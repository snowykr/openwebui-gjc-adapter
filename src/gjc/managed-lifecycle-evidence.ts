import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	assertManagedLifecycleTransition,
	isManagedLifecycleState,
	type ManagedLifecycleState,
} from "./managed-lifecycle-state";
import type { HistoricalSessionBinding } from "./session-authority-types";
import { hasOnlyKeys, isNonEmptyString, isRecord, isTimestamp } from "./session-authority-validation-primitives";
import type { ManagedGenerationProof, ManagedPreparedTurnAuthority, ManagedTurnAuthority } from "./turn-runner";

/** Public saved-session selection receipt, not snapshot or process-incarnation authority. */
export interface ManagedHistoricalSavedSession {
	readonly id: string;
	readonly path: string;
	readonly identity: {
		readonly dev: string;
		readonly ino: string;
		readonly size: number;
		readonly mtimeMs: number;
		readonly mtimeNs: string;
		readonly sha256: string;
		readonly nlink: string;
		readonly ctimeNs: string;
	};
}

export interface ManagedHistoricalLifecycleSource {
	readonly kind: "bootstrap-history";
	readonly manifestDigest: string;
	readonly historicalBinding: HistoricalSessionBinding;
	readonly savedSession: ManagedHistoricalSavedSession;
}

export interface ManagedLifecycleEvidence {
	readonly operation: "session.create" | "session.resume" | "session.fork" | "session.close" | "session.delete";
	readonly actor: { readonly id: string; readonly namespace: "openwebui-gjc-adapter" };
	readonly requestKey: string;
	readonly requestHash: string;
	readonly payloadHash: string;
	readonly preparedAuthority: ManagedPreparedTurnAuthority;
	readonly source?: ManagedTurnAuthority;
	readonly historicalSource?: ManagedHistoricalLifecycleSource;
	readonly sourceProofRef?: { readonly operationId: string; readonly evidenceHash: string };
	readonly target: Readonly<Record<string, unknown>>;
	readonly state: ManagedLifecycleState;
	readonly recordedAt: string;
	readonly acknowledged?: ManagedTurnAuthority;
	readonly proven?: ManagedGenerationProof;
	readonly closeAcknowledgement?: {
		readonly sessionId: string;
		readonly generation: number;
		readonly observedAt: string;
	};
	readonly retirement?: {
		readonly sessionId: string;
		readonly generation: number;
		readonly acknowledgedSessionId: string;
		readonly observedAt: string;
		readonly evidence: Readonly<Record<string, unknown>>;
	};
}

type EvidenceInput = Pick<
	ManagedLifecycleEvidence,
	"operation" | "preparedAuthority" | "source" | "historicalSource" | "target" | "payloadHash"
>;
type EvidencePatch = Partial<
	Pick<ManagedLifecycleEvidence, "acknowledged" | "proven" | "retirement" | "closeAcknowledgement">
>;
const preparedFields = [
	"principalId",
	"projectId",
	"canonicalWorkspace",
	"chatId",
	"leaseId",
	"epoch",
	"requestKey",
] as const;
const scopeFields = ["principalId", "projectId", "canonicalWorkspace", "chatId", "leaseId", "epoch"] as const;
const proofFields = ["acknowledged", "proven", "retirement", "closeAcknowledgement"] as const;
const savedTranscriptFields = ["dev", "ino", "size", "mtimeMs", "mtimeNs", "sha256"] as const;
const identityFields = [
	"operation",
	"actor",
	"requestKey",
	"requestHash",
	"payloadHash",
	"preparedAuthority",
	"source",
	"historicalSource",
	"sourceProofRef",
	"target",
] as const;
const operations = new Set(["session.create", "session.resume", "session.fork", "session.close", "session.delete"]);
const forbiddenField =
	/^(?:raw.*|.*token.*|.*secret.*|.*password.*|.*credential.*|.*descriptor.*|.*attachment.*|.*tmux.*|pid|process.*|.*incarnation.*|url|endpointUrl|authorization|sessionFile|sessionPath|sourceSessionPath|stateRoot)$/i;

export function lifecyclePreparedAuthority(authority: ManagedPreparedTurnAuthority): ManagedPreparedTurnAuthority {
	return {
		principalId: authority.principalId,
		projectId: authority.projectId,
		canonicalWorkspace: authority.canonicalWorkspace,
		chatId: authority.chatId,
		leaseId: authority.leaseId,
		epoch: authority.epoch,
		requestKey: authority.requestKey,
	};
}
export function lifecycleExactAuthority(authority: ManagedTurnAuthority): ManagedTurnAuthority {
	return {
		...lifecyclePreparedAuthority(authority),
		sessionId: authority.sessionId,
		generation: authority.generation,
	};
}

export function createManagedLifecycleEvidence(
	input: EvidenceInput,
	recordedAt = new Date().toISOString(),
): ManagedLifecycleEvidence {
	const actor = { id: input.preparedAuthority.principalId, namespace: "openwebui-gjc-adapter" } as const;
	const requestKey = input.preparedAuthority.requestKey;
	const value: ManagedLifecycleEvidence = {
		operation: input.operation,
		preparedAuthority: input.preparedAuthority,
		target: input.target,
		payloadHash: input.payloadHash,
		...(input.source === undefined ? {} : { source: input.source }),
		...(input.historicalSource === undefined ? {} : { historicalSource: input.historicalSource }),
		actor,
		requestKey,
		requestHash: requestHash({ operation: input.operation, actor, requestKey, target: input.target }),
		state: "intent_prepared",
		recordedAt,
	};
	assertEvidence(value);
	return copyManagedLifecycleEvidence(value);
}

/** Initializes a distinct close operation; the store atomically binds its source proof. */
export function createManagedRetirementEvidence(
	input: Omit<EvidenceInput, "operation" | "source"> & {
		readonly operation: "session.close" | "session.delete";
		readonly source: ManagedTurnAuthority;
		readonly sourceOperationId: string;
		readonly sourceEvidence: ManagedLifecycleEvidence;
	},
	recordedAt = new Date().toISOString(),
): ManagedLifecycleEvidence {
	assertEvidence(input.sourceEvidence);
	const prior = input.sourceEvidence;
	if (
		!isNonEmptyString(input.sourceOperationId) ||
		prior.state !== "active_generation_proven" ||
		prior.acknowledged === undefined ||
		prior.proven === undefined ||
		![...scopeFields, "sessionId", "generation"].every(
			field => Reflect.get(prior.acknowledged!, field) === Reflect.get(input.source, field),
		)
	)
		throw new Error("Managed retirement requires matching persisted active-generation proof.");
	const intent = createManagedLifecycleEvidence(input, recordedAt);
	return copyManagedLifecycleEvidence({
		...intent,
		state: "closing",
		sourceProofRef: {
			operationId: input.sourceOperationId,
			evidenceHash: managedLifecycleEvidenceHash(prior),
		},
	});
}

export function managedLifecycleEvidenceHash(evidence: ManagedLifecycleEvidence): string {
	assertEvidence(evidence);
	return requestHash(evidence);
}

export function transitionManagedLifecycleEvidence(
	current: ManagedLifecycleEvidence,
	state: ManagedLifecycleState,
	patch: EvidencePatch = {},
	recordedAt?: string,
): ManagedLifecycleEvidence {
	if (!hasOnlyKeys(patch, proofFields)) throw new Error("Lifecycle transition patch may contain only proof fields.");
	const next = {
		...current,
		...patch,
		state,
		recordedAt: recordedAt ?? (state === current.state ? current.recordedAt : new Date().toISOString()),
	};
	assertManagedLifecycleEvidenceUpdate(current, next);
	return copyManagedLifecycleEvidence(next);
}

export function assertManagedLifecycleEvidenceUpdate(
	current: ManagedLifecycleEvidence,
	next: ManagedLifecycleEvidence,
): void {
	assertEvidence(current);
	assertEvidence(next);
	for (const field of identityFields)
		if (!isDeepStrictEqual(current[field], next[field]))
			throw new Error(`Immutable managed lifecycle identity changed: ${field}.`);
	if (Date.parse(next.recordedAt) < Date.parse(current.recordedAt))
		throw new Error("Managed lifecycle evidence time moved backwards.");
	if (current.state === next.state) {
		if (
			current.state === "closing" &&
			current.closeAcknowledgement === undefined &&
			next.closeAcknowledgement !== undefined &&
			Date.parse(next.closeAcknowledgement.observedAt) >= Date.parse(current.recordedAt) &&
			isDeepStrictEqual(
				{ ...current, closeAcknowledgement: next.closeAcknowledgement, recordedAt: next.recordedAt },
				next,
			)
		)
			return;
		if (!isDeepStrictEqual(current, next)) throw new Error("Only an exact duplicate lifecycle update is idempotent.");
		return;
	}
	assertManagedLifecycleTransition(current.state, next.state);
	if (current.state === "closing" && next.state === "active_generation_proven")
		throw new Error(
			"Close restoration requires explicit public not-applied evidence, which this receipt cannot represent.",
		);
	if (current.state === "cleanup_uncertain" && next.state === "cleanup_pending")
		throw new Error(
			"Cleanup retry requires explicit public not-applied evidence, which this receipt cannot represent.",
		);
	for (const field of proofFields)
		if (current[field] !== undefined && !isDeepStrictEqual(current[field], next[field]))
			throw new Error(`Managed lifecycle proof cannot be removed or replaced: ${field}.`);
	if (
		next.retirement !== undefined &&
		current.retirement === undefined &&
		Date.parse(next.retirement.observedAt) < Date.parse(current.recordedAt)
	)
		throw new Error("Retirement observation predates the recorded lifecycle operation.");
}

export function copyManagedLifecycleEvidence(value: ManagedLifecycleEvidence): ManagedLifecycleEvidence {
	assertEvidence(value);
	return JSON.parse(canonicalJson(value)) as ManagedLifecycleEvidence;
}

export function isManagedLifecycleEvidence(value: unknown): value is ManagedLifecycleEvidence {
	try {
		assertEvidence(value);
		return true;
	} catch {
		return false;
	}
}

function assertEvidence(value: unknown): asserts value is ManagedLifecycleEvidence {
	if (
		!hasOnlyKeys(value, [...identityFields, ...proofFields, "state", "recordedAt"]) ||
		!operations.has(String(value.operation)) ||
		!isManagedLifecycleState(value.state) ||
		!isTimestamp(value.recordedAt) ||
		!isPrepared(value.preparedAuthority) ||
		!isRecord(value.target) ||
		!isHash(value.payloadHash) ||
		!isHash(value.requestHash) ||
		!hasOnlyKeys(value.actor, ["id", "namespace"]) ||
		value.actor.id !== value.preparedAuthority.principalId ||
		value.actor.namespace !== "openwebui-gjc-adapter" ||
		value.requestKey !== value.preparedAuthority.requestKey
	)
		throw new Error("Invalid managed lifecycle evidence identity.");
	if (
		value.requestHash !==
		requestHash({
			operation: value.operation,
			actor: value.actor,
			requestKey: value.requestKey,
			target: value.target,
		})
	)
		throw new Error("Managed lifecycle request hash does not match its public request.");
	const prepared = value.preparedAuthority;
	const source = value.source;
	const historicalSource = value.historicalSource;
	if (historicalSource !== undefined) {
		if (
			value.operation !== "session.resume" ||
			source !== undefined ||
			value.sourceProofRef !== undefined ||
			!isManagedHistoricalLifecycleSource(historicalSource, prepared)
		)
			throw new Error("Managed bootstrap resume requires an exclusive matching historical source.");
		validateHistoricalTarget(value.target, prepared, historicalSource);
		canonicalJson(value.target);
	} else canonicalJson(value.target, true);
	if (
		value.sourceProofRef !== undefined &&
		(!hasOnlyKeys(value.sourceProofRef, ["operationId", "evidenceHash"]) ||
			!isNonEmptyString(value.sourceProofRef.operationId) ||
			!isHash(value.sourceProofRef.evidenceHash) ||
			(value.operation !== "session.close" && value.operation !== "session.delete"))
	)
		throw new Error("Managed retirement source proof reference is invalid.");
	if (source !== undefined && (!isAuthority(source) || !scopeFields.every(field => source[field] === prepared[field])))
		throw new Error("Managed lifecycle source crosses its prepared tenant fence.");
	if (value.operation !== "session.create" && source === undefined && historicalSource === undefined)
		throw new Error("Managed lifecycle requires an exact source authority.");
	if (historicalSource === undefined)
		validateTarget(
			value.operation as ManagedLifecycleEvidence["operation"],
			value.target,
			prepared,
			source as ManagedTurnAuthority | undefined,
		);
	const acknowledged = value.acknowledged;
	if (acknowledged !== undefined) {
		if (!isAuthority(acknowledged) || !preparedFields.every(field => acknowledged[field] === prepared[field]))
			throw new Error("Managed lifecycle acknowledgement crosses its prepared authority.");
		if (
			historicalSource !== undefined &&
			isManagedHistoricalLifecycleSource(historicalSource, prepared) &&
			acknowledged.sessionId !== historicalSource.historicalBinding.sessionId
		)
			throw new Error("Managed bootstrap acknowledgement changed the full historical session identity.");
		if (source !== undefined && isAuthority(source)) {
			if (
				(value.operation === "session.create" || value.operation === "session.fork") &&
				acknowledged.sessionId === source.sessionId
			)
				throw new Error("Managed successor acknowledgement reused the source identity.");
			if (
				!["session.create", "session.fork"].includes(String(value.operation)) &&
				(acknowledged.sessionId !== source.sessionId || acknowledged.generation !== source.generation)
			)
				throw new Error("Managed lifecycle acknowledgement changed the exact source generation.");
		}
	}
	if (value.proven !== undefined && (!isAuthority(acknowledged) || !isProof(value.proven, acknowledged)))
		throw new Error("Managed lifecycle proof does not match its acknowledged generation.");
	const retiringSource = value.operation === "session.close" || value.operation === "session.delete";
	if (value.closeAcknowledgement !== undefined) {
		const ack = value.closeAcknowledgement;
		if (
			!retiringSource ||
			!isAuthority(source) ||
			!hasOnlyKeys(ack, ["sessionId", "generation", "observedAt"]) ||
			ack.sessionId !== source.sessionId ||
			ack.generation !== source.generation ||
			!isTimestamp(ack.observedAt) ||
			Date.parse(ack.observedAt) > Date.parse(value.recordedAt)
		)
			throw new Error("Managed close acknowledgement does not match its exact source.");
	}
	if (
		["acknowledged_unproven", "active_generation_proven", "cleanup_pending", "cleanup_uncertain"].includes(
			value.state,
		) &&
		acknowledged === undefined &&
		!(retiringSource && value.state === "acknowledged_unproven")
	)
		throw new Error("Managed lifecycle state requires acknowledged target authority.");
	if (
		value.state === "active_generation_proven" &&
		(value.proven === undefined || ["session.close", "session.delete"].includes(String(value.operation)))
	)
		throw new Error("Managed active state requires target generation proof.");
	if (value.state === "closing" && source === undefined && value.proven === undefined)
		throw new Error("Managed closing state requires an exact prior authority.");
	if (value.state === "intent_prepared" && proofFields.some(field => value[field] !== undefined))
		throw new Error("Prepared lifecycle intent cannot contain outcome proof.");
	if (value.retirement !== undefined) {
		const retired = value.retirement;
		const expected =
			value.operation === "session.close" || value.operation === "session.delete" ? source : acknowledged;
		if (
			!isAuthority(expected) ||
			!hasOnlyKeys(retired, ["sessionId", "generation", "acknowledgedSessionId", "observedAt", "evidence"]) ||
			retired.sessionId !== expected.sessionId ||
			retired.generation !== expected.generation ||
			retired.acknowledgedSessionId !== retired.sessionId ||
			!isTimestamp(retired.observedAt) ||
			Date.parse(retired.observedAt) > Date.parse(value.recordedAt) ||
			!isRetirementProof(retired.evidence)
		)
			throw new Error("Managed lifecycle retirement lacks matching exact-generation success and positive evidence.");
		if (
			value.sourceProofRef !== undefined &&
			(!isRecord(value.closeAcknowledgement) ||
				!isTimestamp(value.closeAcknowledgement.observedAt) ||
				Date.parse(value.closeAcknowledgement.observedAt) > Date.parse(retired.observedAt))
		)
			throw new Error("Managed retirement requires its prior durable successful close acknowledgement.");
	}
	if (value.state === "retired" && value.retirement === undefined)
		throw new Error("Retired lifecycle requires positive retirement proof.");
	if (value.retirement !== undefined && value.state !== "retired")
		throw new Error("Retirement proof belongs only to retired lifecycle state.");
	canonicalJson(value);
}

function isManagedHistoricalLifecycleSource(
	value: unknown,
	prepared: ManagedPreparedTurnAuthority,
): value is ManagedHistoricalLifecycleSource {
	if (
		!hasOnlyKeys(value, ["kind", "manifestDigest", "historicalBinding", "savedSession"]) ||
		value.kind !== "bootstrap-history" ||
		!isHash(value.manifestDigest) ||
		!isHistoricalSessionBinding(value.historicalBinding)
	)
		return false;
	const historical = value.historicalBinding;
	return (
		isNonEmptyString(historical.sessionId) &&
		historical.projectId === prepared.projectId &&
		(historical.chatId === prepared.chatId ||
			historical.chatId === JSON.stringify([prepared.principalId, prepared.chatId])) &&
		(historical.principalId === undefined || historical.principalId === prepared.principalId) &&
		(historical.canonicalWorkspace === undefined || historical.canonicalWorkspace === prepared.canonicalWorkspace) &&
		isHistoricalSavedSession(value.savedSession, historical.sessionId, prepared.canonicalWorkspace)
	);
}

export function isHistoricalSavedSession(
	value: unknown,
	sessionId: string,
	workspace: string,
): value is ManagedHistoricalSavedSession {
	if (
		!hasOnlyKeys(value, ["id", "path", "identity"]) ||
		value.id !== sessionId ||
		!isNonEmptyString(value.path) ||
		!isAbsolute(value.path) ||
		resolve(value.path) !== value.path ||
		/[\p{Cc}]/u.test(value.path) ||
		resolve(workspace) !== workspace ||
		/[\p{Cc}]/u.test(workspace)
	)
		return false;
	const within = relative(workspace, value.path);
	if (within === "" || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) return false;
	const identity = value.identity;
	return (
		hasOnlyKeys(identity, [...savedTranscriptFields, "nlink", "ctimeNs"]) &&
		[identity.dev, identity.ino, identity.mtimeNs, identity.nlink, identity.ctimeNs].every(isDecimalIdentity) &&
		typeof identity.size === "number" &&
		Number.isSafeInteger(identity.size) &&
		identity.size >= 0 &&
		typeof identity.mtimeMs === "number" &&
		Number.isFinite(identity.mtimeMs) &&
		identity.mtimeMs >= 0 &&
		isHash(identity.sha256)
	);
}

function isDecimalIdentity(value: unknown): value is string {
	return typeof value === "string" && /^[0-9]+$/.test(value);
}

export function isHistoricalSessionBinding(
	value: unknown,
	identity?: { readonly chatId?: unknown; readonly projectId?: unknown; readonly sessionId?: unknown },
): value is HistoricalSessionBinding {
	if (
		!hasOnlyKeys(value, [
			"kind",
			"chatId",
			"projectId",
			"sessionId",
			"principalId",
			"canonicalWorkspace",
			"reason",
			"provenance",
		]) ||
		value.kind !== "unbound-history" ||
		!isNonEmptyString(value.chatId) ||
		!isNonEmptyString(value.projectId) ||
		(value.sessionId !== undefined && !isNonEmptyString(value.sessionId)) ||
		(value.principalId !== undefined && !isNonEmptyString(value.principalId)) ||
		(value.canonicalWorkspace !== undefined &&
			(!isNonEmptyString(value.canonicalWorkspace) || !isAbsolute(value.canonicalWorkspace)))
	)
		return false;
	if (
		identity !== undefined &&
		(value.chatId !== identity.chatId ||
			value.projectId !== identity.projectId ||
			value.sessionId !== identity.sessionId)
	)
		return false;
	const principal = scopedHistoricalPrincipal(value.chatId);
	if (principal !== undefined && value.principalId !== principal) return false;
	if (
		value.reason !==
		(value.principalId === undefined || value.canonicalWorkspace === undefined
			? "ownership-unresolved"
			: "generation-unproven")
	)
		return false;
	const provenance = value.provenance;
	return (
		hasOnlyKeys(provenance, ["source", "documentHash", "nodeRef", "nodeHash"]) &&
		Object.keys(provenance).length === 4 &&
		provenance.source === "v2" &&
		isHash(provenance.documentHash) &&
		isHash(provenance.nodeHash) &&
		typeof provenance.nodeRef === "string" &&
		/^\/(?:mappings|provisionalOperations)\/(?:0|[1-9][0-9]*)(?:\/(?:[^~/]|~[01])+)*$/.test(provenance.nodeRef)
	);
}

function scopedHistoricalPrincipal(chatId: string): string | undefined {
	try {
		const scope: unknown = JSON.parse(chatId);
		return Array.isArray(scope) &&
			scope.length === 2 &&
			scope.every(isNonEmptyString) &&
			JSON.stringify(scope) === chatId
			? scope[0]
			: undefined;
	} catch {
		return undefined;
	}
}

function validateHistoricalTarget(
	target: Record<string, unknown>,
	prepared: ManagedPreparedTurnAuthority,
	source: ManagedHistoricalLifecycleSource,
): void {
	const identity = target.sessionIdentity;
	if (
		!hasOnlyKeys(target, ["sessionId", "cwd", "sessionPath", "sessionIdentity"]) ||
		target.sessionId !== source.savedSession.id ||
		target.cwd !== prepared.canonicalWorkspace ||
		target.sessionPath !== source.savedSession.path ||
		!hasOnlyKeys(identity, savedTranscriptFields) ||
		!savedTranscriptFields.every(field => identity[field] === source.savedSession.identity[field])
	)
		throw new Error(
			"Managed bootstrap target requires the exact public saved-session selection and transcript identity projection.",
		);
}

function validateTarget(
	operation: ManagedLifecycleEvidence["operation"],
	target: Record<string, unknown>,
	prepared: ManagedPreparedTurnAuthority,
	source?: ManagedTurnAuthority,
): void {
	const allowed = {
		"session.create": ["kind", "path", "cwd", "body", "modelPreset", "readiness", "readinessTimeoutMs"],
		"session.resume": ["sessionId", "sessionIdOrPrefix", "path", "cwd", "body", "modelPreset", "readinessTimeoutMs"],
		"session.fork": ["sourceSessionId", "cwd", "body", "modelPreset", "readinessTimeoutMs"],
		"session.close": ["sessionId", "endpointGeneration"],
		"session.delete": ["sessionId", "cwd"],
	};
	if (Object.keys(target).some(key => !allowed[operation].includes(key)))
		throw new Error("Lifecycle target contains undeclared authority.");
	for (const field of ["cwd", "path"])
		if (target[field] !== undefined && target[field] !== prepared.canonicalWorkspace)
			throw new Error("Lifecycle target workspace is foreign.");
	if (
		operation === "session.create" &&
		target.cwd !== prepared.canonicalWorkspace &&
		target.path !== prepared.canonicalWorkspace
	)
		throw new Error("Lifecycle create target requires its canonical workspace.");
	if (target.kind !== undefined && target.kind !== "existing_path")
		throw new Error("Lifecycle evidence requires an existing canonical workspace.");
	if (
		operation === "session.fork" &&
		(target.sourceSessionId !== source?.sessionId || target.cwd !== prepared.canonicalWorkspace)
	)
		throw new Error("Lifecycle fork target does not match its source.");
	if (
		operation === "session.resume" &&
		((target.sessionId ?? target.sessionIdOrPrefix) !== source?.sessionId ||
			(target.sessionId !== undefined && target.sessionId !== source?.sessionId) ||
			(target.sessionIdOrPrefix !== undefined && target.sessionIdOrPrefix !== source?.sessionId))
	)
		throw new Error("Lifecycle resume target must name the exact source session.");
	if ((operation === "session.close" || operation === "session.delete") && target.sessionId !== source?.sessionId)
		throw new Error("Lifecycle retirement target must name the exact source session.");
	if (target.endpointGeneration !== undefined && target.endpointGeneration !== source?.generation)
		throw new Error("Lifecycle target generation does not match its source.");
}

function isPrepared(value: unknown): value is ManagedPreparedTurnAuthority {
	return (
		hasOnlyKeys(value, preparedFields) &&
		preparedFields.every(field => isNonEmptyString(value[field])) &&
		isAbsolute(value.canonicalWorkspace as string)
	);
}
function isAuthority(value: unknown): value is ManagedTurnAuthority {
	return (
		hasOnlyKeys(value, [...preparedFields, "sessionId", "generation"]) &&
		preparedFields.every(field => isNonEmptyString(value[field])) &&
		isAbsolute(value.canonicalWorkspace as string) &&
		isNonEmptyString(value.sessionId) &&
		positiveInteger(value.generation)
	);
}
function isProof(value: unknown, authority: ManagedTurnAuthority): value is ManagedGenerationProof {
	return (
		hasOnlyKeys(value, ["kind", "sessionId", "generation", "leaseId", "epoch"]) &&
		value.kind === "managed-generation" &&
		value.sessionId === authority.sessionId &&
		value.generation === authority.generation &&
		value.leaseId === authority.leaseId &&
		value.epoch === authority.epoch
	);
}
function isRetirementProof(value: unknown): boolean {
	if (!isRecord(value)) return false;
	canonicalJson(value, true);
	return (
		value.source === "session_index" &&
		["host_unregistered", "session_closed", "session_deleted"].includes(String(value.event)) &&
		positiveInteger(value.observedIndexSeq) &&
		positiveInteger(value.evidenceIndexSeq) &&
		value.evidenceIndexSeq <= value.observedIndexSeq
	);
}
function positiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function isHash(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function requestHash(request: unknown): string {
	return createHash("sha256").update(canonicalJson(request)).digest("hex");
}
function canonicalJson(value: unknown, rejectAuthority = false, depth = 0): string {
	if (depth > 64) throw new Error("Managed lifecycle evidence is too deeply nested.");
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value))
	)
		return JSON.stringify(value);
	if (Array.isArray(value))
		return `[${Array.from(value, child => canonicalJson(child, rejectAuthority, depth + 1)).join(",")}]`;
	if (!isRecord(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null))
		throw new Error("Managed lifecycle evidence must contain only JSON values.");
	return `{${Object.keys(value)
		.sort()
		.map(key => {
			if (rejectAuthority && forbiddenField.test(key))
				throw new Error("Managed lifecycle evidence contains forbidden raw authority.");
			return `${JSON.stringify(key)}:${canonicalJson(value[key], rejectAuthority, depth + 1)}`;
		})
		.join(",")}}`;
}
