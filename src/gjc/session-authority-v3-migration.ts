import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isAttachmentProof } from "./session-authority-operation-validation";
import type {
	HistoricalSessionBinding,
	ProvisionalSessionOperation,
	SessionAuthorityRecord,
} from "./session-authority-types";
import {
	encodeSessionAuthorityV3Document,
	isSessionAuthorityV3Document,
	SESSION_AUTHORITY_V3_EPOCH,
	SESSION_AUTHORITY_V3_KIND,
	SESSION_AUTHORITY_V3_VERSION,
	type SessionAuthorityV3Document,
} from "./session-authority-v3";
import { isNonEmptyString, isRecord } from "./session-authority-validation-primitives";
import type { ManagedTurnAuthority } from "./turn-runner";

export interface SessionAuthorityV2Document {
	readonly mappings: readonly SessionAuthorityRecord[];
	readonly provisionalOperations?: readonly ProvisionalSessionOperation[];
}

/** A binding proves one exact source occurrence, never every use of a session ID. */
export interface ManagedTurnAuthorityBinding {
	readonly nodeRef: string;
	readonly chatId: string;
	readonly projectId: string;
	readonly sessionId: string;
	readonly managedAuthority: ManagedTurnAuthority;
}
export interface SessionAuthorityV3MigrationBlocked {
	readonly status: "blocked";
	readonly reasons: readonly string[];
}
export interface SessionAuthorityV3MigrationReady {
	readonly status: "ready";
	readonly document: SessionAuthorityV3Document;
}
export type SessionAuthorityV3MigrationReport = SessionAuthorityV3MigrationBlocked | SessionAuthorityV3MigrationReady;
export interface SessionAuthorityV2Snapshot {
	readonly originalBaseBytes: Uint8Array;
	readonly originalBaseDigest: string;
	readonly originalWalBytes: Uint8Array;
	readonly originalWalDigest: string;
}
export interface StageSessionAuthorityV3MigrationRequest {
	readonly snapshot: SessionAuthorityV2Snapshot;
	readonly decodedDocument: SessionAuthorityV2Document;
	readonly bindings?: readonly ManagedTurnAuthorityBinding[];
}
export interface StagedSessionAuthorityV3Migration {
	readonly status: "staged";
	readonly originalBaseBytes: Uint8Array;
	readonly originalBaseDigest: string;
	readonly originalWalBytes: Uint8Array;
	readonly originalWalDigest: string;
	readonly v3Bytes: Uint8Array;
	readonly v3Digest: string;
	readonly document: SessionAuthorityV3Document;
}
export type StageSessionAuthorityV3MigrationReport =
	| SessionAuthorityV3MigrationBlocked
	| StagedSessionAuthorityV3Migration;

type Identity = { readonly chatId: string; readonly projectId: string; readonly sessionId?: string };
type Owner = { readonly principalId?: string; readonly canonicalWorkspace?: string; readonly projectId: string };
interface Conversion {
	readonly documentHash: string;
	readonly bindings: ReadonlyMap<string, ManagedTurnAuthorityBinding>;
	readonly used: Set<string>;
}

/** Pure lossless graph conversion: historical nodes remain non-serving until individually proven. */
export function migrateSessionAuthorityV2ToV3(
	document: SessionAuthorityV2Document,
	bindings: readonly ManagedTurnAuthorityBinding[] = [],
): SessionAuthorityV3MigrationReport {
	try {
		const sourceJson = canonicalJson(document);
		const documentHash = sha256(new TextEncoder().encode(sourceJson));
		const source: unknown = JSON.parse(sourceJson);
		if (
			!isRecord(source) ||
			Object.keys(source).some(key => key !== "mappings" && key !== "provisionalOperations") ||
			!Array.isArray(source.mappings) ||
			(source.provisionalOperations !== undefined && !Array.isArray(source.provisionalOperations))
		)
			throw new Error("Source is not a decoded V2 authority graph.");
		const index = new Map<string, ManagedTurnAuthorityBinding>();
		for (const binding of bindings) {
			if (
				!isNonEmptyString(binding.nodeRef) ||
				!/^\/(?:mappings|provisionalOperations)\/(?:0|[1-9][0-9]*)(?:\/(?:[^~/]|~[01])+)*$/.test(binding.nodeRef)
			)
				throw new Error("Every managed binding requires an exact source nodeRef JSON pointer.");
			if (index.has(binding.nodeRef)) throw new Error(`Duplicate managed authority binding at ${binding.nodeRef}.`);
			index.set(binding.nodeRef, structuredClone(binding));
		}
		const context: Conversion = { documentHash, bindings: index, used: new Set() };
		const converted: unknown = {
			kind: SESSION_AUTHORITY_V3_KIND,
			version: SESSION_AUTHORITY_V3_VERSION,
			authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
			mappings: source.mappings.map((node, index) => convertRecord(node, `/mappings/${index}`, context)),
			provisionalOperations: (source.provisionalOperations ?? []).map((node, index) =>
				convertProvisional(node, `/provisionalOperations/${index}`, context),
			),
		};
		for (const nodeRef of index.keys())
			if (!context.used.has(nodeRef))
				throw new Error(`Binding does not name an identity-bearing source occurrence: ${nodeRef}.`);
		if (!isSessionAuthorityV3Document(converted))
			throw new Error("The V2 graph cannot be represented losslessly as ordinary V3 history.");
		return { status: "ready", document: converted };
	} catch (error) {
		return blocked(error instanceof Error ? error.message : "Malformed V2 graph.");
	}
}

export function stageSessionAuthorityV3Migration(
	request: StageSessionAuthorityV3MigrationRequest,
): StageSessionAuthorityV3MigrationReport {
	const base = new Uint8Array(request.snapshot.originalBaseBytes);
	const wal = new Uint8Array(request.snapshot.originalWalBytes);
	if (sha256(base) !== request.snapshot.originalBaseDigest)
		return blocked("Original V2 base bytes do not match their supplied digest.");
	if (sha256(wal) !== request.snapshot.originalWalDigest)
		return blocked("Original V2 WAL bytes do not match their supplied digest.");
	const migrated = migrateSessionAuthorityV2ToV3(request.decodedDocument, request.bindings);
	if (migrated.status === "blocked") return migrated;
	const v3Bytes = new TextEncoder().encode(encodeSessionAuthorityV3Document(migrated.document));
	return {
		status: "staged",
		originalBaseBytes: base,
		originalBaseDigest: request.snapshot.originalBaseDigest,
		originalWalBytes: wal,
		originalWalDigest: request.snapshot.originalWalDigest,
		v3Bytes,
		v3Digest: sha256(v3Bytes),
		document: migrated.document,
	};
}

function convertRecord(
	value: unknown,
	nodeRef: string,
	context: Conversion,
	inherited?: Owner,
): Record<string, unknown> {
	const node = record(value, nodeRef);
	if (node.version !== 2 || node.authorityEpoch !== undefined || !Array.isArray(node.journal))
		throw new Error(`Invalid V2 record at ${nodeRef}.`);
	const identity = identityOf(node, nodeRef);
	const owner = ownerOf(node, identity, inherited);
	const {
		version: _version,
		attachment: _attachment,
		managedAuthority: _managed,
		historicalBinding: _historical,
		journal,
		reassignment,
		prior,
		...projection
	} = node;
	validateAttachment(node.attachment, identity.sessionId, nodeRef);
	if (node.historicalBinding !== undefined)
		throw new Error(`V2 source already contains a historical binding at ${nodeRef}.`);
	return {
		...projection,
		version: SESSION_AUTHORITY_V3_VERSION,
		authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
		...convertBinding(node, identity, owner, nodeRef, context),
		journal: node.journal.map((operation, index) =>
			convertOperation(operation, `${nodeRef}/journal/${index}`, identity, owner, context),
		),
		...(reassignment === undefined
			? {}
			: { reassignment: convertReassignment(reassignment, `${nodeRef}/reassignment`, owner, context) }),
		...(prior === undefined ? {} : { prior: convertRecord(prior, `${nodeRef}/prior`, context, owner) }),
	};
}

function convertReassignment(
	value: unknown,
	nodeRef: string,
	owner: Owner,
	context: Conversion,
): Record<string, unknown> {
	const node = record(value, nodeRef);
	const { sourceTombstone, priorTombstone, ...fields } = node;
	const source =
		sourceTombstone === undefined
			? undefined
			: convertRecord(sourceTombstone, `${nodeRef}/sourceTombstone`, context, owner);
	let prior: Record<string, unknown> | undefined;
	if (priorTombstone !== undefined) {
		if (
			isRecord(sourceTombstone) &&
			isDeepStrictEqual(sourceTombstone.prior, priorTombstone) &&
			isRecord(source?.prior)
		) {
			const canonicalPath = `${nodeRef}/sourceTombstone/prior`;
			const aliasPath = `${nodeRef}/priorTombstone`;
			assertDuplicateBindings(context, canonicalPath, aliasPath);
			const sourceOwner = ownerOf(sourceTombstone, identityOf(sourceTombstone, `${nodeRef}/sourceTombstone`), owner);
			const convertedAlias = convertRecord(priorTombstone, aliasPath, context, sourceOwner);
			const normalized = normalizeAliasProvenance(convertedAlias, canonicalPath, aliasPath);
			if (!isRecord(normalized) || !isDeepStrictEqual(source.prior, normalized))
				throw new Error("Duplicate prior history cannot be represented without changing retained evidence.");
			prior = normalized;
		} else prior = convertRecord(priorTombstone, `${nodeRef}/priorTombstone`, context, owner);
	}
	return {
		...fields,
		...(source === undefined ? {} : { sourceTombstone: source }),
		...(prior === undefined ? {} : { priorTombstone: prior }),
	};
}

function assertDuplicateBindings(context: Conversion, canonicalPath: string, aliasPath: string): void {
	for (const [path, binding] of context.bindings) {
		const canonical = path === canonicalPath || path.startsWith(`${canonicalPath}/`);
		const alias = path === aliasPath || path.startsWith(`${aliasPath}/`);
		if (!canonical && !alias) continue;
		const peerPath = canonical
			? aliasPath + path.slice(canonicalPath.length)
			: canonicalPath + path.slice(aliasPath.length);
		const peer = context.bindings.get(peerPath);
		if (
			peer === undefined ||
			binding.chatId !== peer.chatId ||
			binding.projectId !== peer.projectId ||
			binding.sessionId !== peer.sessionId ||
			!isDeepStrictEqual(withEpoch(binding.managedAuthority), withEpoch(peer.managedAuthority))
		)
			throw new Error(`Duplicated history requires equal explicit occurrence bindings at ${path} and ${peerPath}.`);
	}
}
function normalizeAliasProvenance(value: unknown, canonicalPath: string, aliasPath: string): unknown {
	if (Array.isArray(value)) return value.map(child => normalizeAliasProvenance(child, canonicalPath, aliasPath));
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, child]) => {
			if (
				key === "historicalBinding" &&
				isRecord(child) &&
				isRecord(child.provenance) &&
				typeof child.provenance.nodeRef === "string"
			) {
				const reference = child.provenance.nodeRef;
				return [
					key,
					{
						...child,
						provenance: {
							...child.provenance,
							nodeRef:
								reference === aliasPath || reference.startsWith(`${aliasPath}/`)
									? canonicalPath + reference.slice(aliasPath.length)
									: reference,
						},
					},
				];
			}
			return [key, normalizeAliasProvenance(child, canonicalPath, aliasPath)];
		}),
	);
}

function convertOperation(
	value: unknown,
	nodeRef: string,
	identity: Identity,
	owner: Owner,
	context: Conversion,
): Record<string, unknown> {
	const node = record(value, nodeRef);
	const { result, acknowledgedSuccessor, ...fields } = node;
	return {
		...fields,
		...(result === undefined ? {} : { result: convertResult(result, `${nodeRef}/result`, owner, context) }),
		...(acknowledgedSuccessor === undefined
			? {}
			: {
					acknowledgedSuccessor: convertSuccessor(
						acknowledgedSuccessor,
						`${nodeRef}/acknowledgedSuccessor`,
						identity,
						owner,
						context,
					),
				}),
	};
}

function convertResult(value: unknown, nodeRef: string, owner: Owner, context: Conversion): Record<string, unknown> {
	const node = record(value, nodeRef);
	const mapping = record(node.mapping, `${nodeRef}/mapping`);
	const identity = identityOf(mapping, nodeRef);
	const { attachment: _attachment, ...projection } = mapping;
	validateAttachment(mapping.attachment, identity.sessionId, `${nodeRef}/mapping`);
	const { mapping: _mapping, managedAuthority: _managed, historicalBinding: _historical, ...fields } = node;
	if (node.historicalBinding !== undefined)
		throw new Error(`V2 source already contains a historical binding at ${nodeRef}.`);
	return {
		...fields,
		mapping: projection,
		...convertBinding(node, identity, ownerOf(node, identity, owner), nodeRef, context),
	};
}

function convertSuccessor(
	value: unknown,
	nodeRef: string,
	parent: Identity,
	owner: Owner,
	context: Conversion,
): Record<string, unknown> {
	const node = record(value, nodeRef);
	if (!isNonEmptyString(node.sessionId)) throw new Error(`Successor has no session identity at ${nodeRef}.`);
	const identity = { chatId: parent.chatId, projectId: parent.projectId, sessionId: node.sessionId };
	validateAttachment(node.attachment, identity.sessionId, nodeRef);
	const { attachment: _attachment, managedAuthority: _managed, historicalBinding: _historical, ...fields } = node;
	if (node.historicalBinding !== undefined)
		throw new Error(`V2 source already contains a historical binding at ${nodeRef}.`);
	return { ...fields, ...convertBinding(node, identity, ownerOf(node, identity, owner), nodeRef, context) };
}

function convertProvisional(value: unknown, nodeRef: string, context: Conversion): Record<string, unknown> {
	const node = record(value, nodeRef);
	const identity = identityOf(node, nodeRef, true);
	const owner = ownerOf(node, identity);
	validateAttachment(node.attachment, identity.sessionId, nodeRef);
	const { attachment: _attachment, managedAuthority: _managed, historicalBinding: _historical, ...fields } = node;
	if (node.historicalBinding !== undefined)
		throw new Error(`V2 source already contains a historical binding at ${nodeRef}.`);
	const operation = convertOperation(fields, nodeRef, identity, owner, context);
	if (identity.sessionId === undefined) {
		if (node.managedAuthority !== undefined || context.bindings.has(nodeRef))
			throw new Error("Unassigned reservation cannot carry a generation binding.");
		return node.result === undefined && node.acknowledgedSuccessor === undefined
			? operation
			: { ...operation, ...convertBinding(node, identity, owner, nodeRef, context) };
	}
	return { ...operation, ...convertBinding(node, identity, owner, nodeRef, context) };
}

function convertBinding(
	node: Record<string, unknown>,
	identity: Identity,
	owner: Owner,
	nodeRef: string,
	context: Conversion,
): Record<string, unknown> {
	const binding = context.bindings.get(nodeRef);
	if (binding !== undefined) {
		context.used.add(nodeRef);
		if (
			binding.chatId !== identity.chatId ||
			binding.projectId !== identity.projectId ||
			binding.sessionId !== identity.sessionId
		)
			throw new Error(`Binding does not match the exact source occurrence at ${nodeRef}.`);
	}
	const existing = node.managedAuthority;
	if (existing !== undefined && !isRecord(existing)) throw new Error(`Malformed managed authority at ${nodeRef}.`);
	const supplied = binding?.managedAuthority;
	const actual = existing ?? supplied;
	if (actual !== undefined) {
		if (
			!isRecord(actual) ||
			actual.chatId !== identity.chatId ||
			actual.projectId !== identity.projectId ||
			actual.sessionId !== identity.sessionId ||
			(owner.principalId !== undefined && actual.principalId !== owner.principalId) ||
			(owner.canonicalWorkspace !== undefined && actual.canonicalWorkspace !== owner.canonicalWorkspace)
		)
			throw new Error(`Managed occurrence ownership conflicts at ${nodeRef}.`);
		if (
			existing !== undefined &&
			supplied !== undefined &&
			!isDeepStrictEqual(withEpoch(existing), withEpoch(supplied))
		)
			throw new Error(`Binding would rewrite historical generation authority at ${nodeRef}.`);
		return { managedAuthority: withEpoch(actual) };
	}
	const historicalBinding: HistoricalSessionBinding = {
		kind: "unbound-history",
		...identity,
		...(owner.principalId === undefined ? {} : { principalId: owner.principalId }),
		...(owner.canonicalWorkspace === undefined ? {} : { canonicalWorkspace: owner.canonicalWorkspace }),
		reason:
			owner.principalId === undefined || owner.canonicalWorkspace === undefined
				? "ownership-unresolved"
				: "generation-unproven",
		provenance: { source: "v2", documentHash: context.documentHash, nodeRef, nodeHash: jsonHash(node) },
	};
	return { historicalBinding };
}

function ownerOf(node: Record<string, unknown>, identity: Identity, inherited?: Owner): Owner {
	const scope = isRecord(node.observations) ? node.observations.__gjcSessionMappingScope : undefined;
	const canonical = canonicalScope(identity.chatId);
	let principalId = canonical?.[0];
	if (scope !== undefined) {
		if (
			!isRecord(scope) ||
			!isNonEmptyString(scope.principalId) ||
			(scope.chatId !== undefined &&
				(!isNonEmptyString(scope.chatId) || JSON.stringify([scope.principalId, scope.chatId]) !== identity.chatId))
		)
			throw new Error("Malformed or ambiguous legacy principal scope metadata.");
		if (principalId !== undefined && principalId !== scope.principalId)
			throw new Error("Foreign legacy principal scope metadata.");
		principalId = scope.principalId;
	}
	const managed = node.managedAuthority;
	if (managed !== undefined && !isRecord(managed)) throw new Error("Malformed historical managed authority.");
	if (isRecord(managed)) {
		if (!isNonEmptyString(managed.principalId) || !isNonEmptyString(managed.canonicalWorkspace))
			throw new Error("Incomplete historical managed owner.");
		if (principalId !== undefined && principalId !== managed.principalId)
			throw new Error("Foreign historical managed principal.");
		principalId = managed.principalId;
	}
	if (principalId !== undefined && inherited?.principalId !== undefined && principalId !== inherited.principalId)
		throw new Error("Historical child crosses principal ownership.");
	const canonicalWorkspace = isRecord(managed)
		? managed.canonicalWorkspace
		: inherited?.projectId === identity.projectId
			? inherited.canonicalWorkspace
			: undefined;
	if (canonicalWorkspace !== undefined && typeof canonicalWorkspace !== "string")
		throw new Error("Malformed historical workspace.");
	return {
		projectId: identity.projectId,
		...((principalId ?? inherited?.principalId) === undefined
			? {}
			: { principalId: principalId ?? inherited?.principalId }),
		...(canonicalWorkspace === undefined ? {} : { canonicalWorkspace }),
	};
}
function identityOf(node: Record<string, unknown>, context: string, unassigned = false): Identity {
	if (
		!isNonEmptyString(node.chatId) ||
		!isNonEmptyString(node.projectId) ||
		(!unassigned && !isNonEmptyString(node.sessionId)) ||
		(node.sessionId !== undefined && !isNonEmptyString(node.sessionId))
	)
		throw new Error(`Incomplete historical identity at ${context}.`);
	return {
		chatId: node.chatId,
		projectId: node.projectId,
		...(node.sessionId === undefined ? {} : { sessionId: node.sessionId }),
	};
}
function validateAttachment(value: unknown, sessionId: string | undefined, context: string): void {
	if (value !== undefined && (!isAttachmentProof(value) || value.expectedSessionId !== sessionId))
		throw new Error(
			`Malformed legacy attachment at ${context}; conversion cannot discard malformed source evidence.`,
		);
}
function record(value: unknown, context: string): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`Malformed graph node at ${context}.`);
	return value;
}
function withEpoch(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) throw new Error("Malformed managed authority.");
	if (value.authorityEpoch !== undefined && value.authorityEpoch !== SESSION_AUTHORITY_V3_EPOCH)
		throw new Error("Foreign managed authority epoch.");
	return { ...value, authorityEpoch: SESSION_AUTHORITY_V3_EPOCH };
}
function canonicalScope(chatId: string): readonly [string, string] | undefined {
	try {
		const scope: unknown = JSON.parse(chatId);
		if (
			Array.isArray(scope) &&
			scope.length === 2 &&
			scope.every(isNonEmptyString) &&
			JSON.stringify(scope) === chatId
		)
			return [scope[0], scope[1]];
	} catch {
		/* Unscoped history remains unowned. */
	}
	return undefined;
}
function blocked(reason: string): SessionAuthorityV3MigrationBlocked {
	return { status: "blocked", reasons: [reason] };
}
function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}
function jsonHash(value: unknown): string {
	return sha256(new TextEncoder().encode(canonicalJson(value)));
}
function canonicalJson(value: unknown, depth = 0): string {
	if (depth > 64) throw new Error("Historical graph exceeds the supported depth.");
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value))
	)
		return JSON.stringify(value);
	if (Array.isArray(value)) return `[${Array.from(value, item => canonicalJson(item, depth + 1)).join(",")}]`;
	if (!isRecord(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null))
		throw new Error("Historical graph is not JSON data.");
	return `{${Object.keys(value)
		.filter(key => value[key] !== undefined)
		.sort()
		.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1)}`)
		.join(",")}}`;
}
