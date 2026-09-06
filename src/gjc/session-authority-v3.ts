import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { NormalizedModelSelection } from "../contracts";
import {
	isHistoricalSessionBinding,
	isManagedLifecycleEvidence,
	type ManagedLifecycleEvidence,
	managedLifecycleEvidenceHash,
} from "./managed-lifecycle-evidence";

export { isHistoricalSessionBinding } from "./managed-lifecycle-evidence";

import type { HistoricalSessionBinding } from "./session-authority-types";
import {
	isJsonValue,
	isNonEmptyString,
	isNonnegativeSafeInteger,
	isRecord,
	isTimestamp,
} from "./session-authority-validation-primitives";
import { normalizeModelSelection } from "./session-operation-codec";
import type { GjcTurnEvent, ManagedTurnAuthority } from "./turn-runner";

export const SESSION_AUTHORITY_V3_VERSION = 3 as const;
export const SESSION_AUTHORITY_V3_EPOCH = "managed/1" as const;
export const SESSION_AUTHORITY_V3_KIND = "openwebui-gjc-session-authority" as const;
export const MANAGED_TURN_AUTHORITY_V3_EPOCH = SESSION_AUTHORITY_V3_EPOCH;

export type SessionAuthorityV3OperationState = "pending" | "complete" | "uncertain" | "conflict";
export type SessionAuthorityV3OperationKind =
	| "create"
	| "resume"
	| "close"
	| "prompt"
	| "reply"
	| "gate"
	| "branch"
	| "model"
	| "thinking";

export interface ManagedTurnAuthorityV3 extends ManagedTurnAuthority {
	readonly authorityEpoch: typeof SESSION_AUTHORITY_V3_EPOCH;
}

export type SessionAuthorityV3Binding =
	| { readonly managedAuthority: ManagedTurnAuthorityV3; readonly historicalBinding?: never }
	| { readonly managedAuthority?: never; readonly historicalBinding: HistoricalSessionBinding };

export type SessionAuthorityV3Result = SessionAuthorityV3Binding & {
	readonly kind: "turn" | "control" | "close";
	readonly assistantText: string;
	readonly events?: readonly GjcTurnEvent[];
	readonly mapping: Readonly<{
		chatId: string;
		projectId: string;
		sessionId: string;
		rawFrameCursor: number;
		eventCursor: number;
		operationId: string;
		sessionFile?: string;
		activeLeaf?: string;
		modelSelection?: NormalizedModelSelection;
	}>;
	readonly correlation?: Readonly<Record<string, string>>;
	readonly gate?: Readonly<{ gateId: string; commandId?: string; turnId?: string; sessionId?: string }>;
};

export type SessionAuthorityV3AcknowledgedSuccessor = SessionAuthorityV3Binding & {
	readonly sessionId: string;
};

export interface SessionAuthorityV3Operation {
	readonly id: string;
	readonly kind: SessionAuthorityV3OperationKind;
	readonly state: SessionAuthorityV3OperationState;
	readonly ingressId?: string;
	readonly startedAt: string;
	readonly completedAt?: string;
	readonly detail?: string;
	readonly result?: SessionAuthorityV3Result;
	readonly acknowledgedSuccessor?: SessionAuthorityV3AcknowledgedSuccessor;
	readonly lifecycle?: ManagedLifecycleEvidence;
}

export type SessionAuthorityV3Tombstone = SessionAuthorityV3Binding & {
	readonly version: typeof SESSION_AUTHORITY_V3_VERSION;
	readonly authorityEpoch: typeof SESSION_AUTHORITY_V3_EPOCH;
	readonly chatId: string;
	readonly projectId: string;
	readonly sessionId: string;
	readonly createdAt: string;
	readonly header: Readonly<{ chatId: string; projectId: string; sessionId: string }>;
	readonly sessionFile?: string;
	readonly activeLeaf?: string;
	readonly rawFrameCursor: number;
	readonly eventCursor: number;
	readonly operationId: string;
	readonly assistantText?: string;
	readonly events?: readonly GjcTurnEvent[];
	readonly modelSelection?: NormalizedModelSelection;
	readonly observations?: Readonly<Record<string, unknown>>;
	readonly journal: readonly SessionAuthorityV3Operation[];
	readonly retiredAt: string;
	readonly prior?: SessionAuthorityV3Tombstone;
};

export interface SessionAuthorityV3Reassignment {
	readonly state: "pending" | "rolled_back" | "committed";
	readonly sourceProjectId: string;
	readonly targetProjectId: string;
	readonly startedAt: string;
	readonly completedAt?: string;
	readonly target?: Readonly<{
		id: string;
		ingressId?: string;
		kind: SessionAuthorityV3OperationKind;
		detail?: string;
	}>;
	readonly sourceTombstone?: SessionAuthorityV3Tombstone;
	readonly priorTombstone?: SessionAuthorityV3Tombstone;
}

export type SessionAuthorityV3Mapping = SessionAuthorityV3Binding & {
	readonly version: typeof SESSION_AUTHORITY_V3_VERSION;
	readonly authorityEpoch: typeof SESSION_AUTHORITY_V3_EPOCH;
	readonly chatId: string;
	readonly projectId: string;
	readonly sessionId: string;
	readonly createdAt: string;
	readonly header: Readonly<{ chatId: string; projectId: string; sessionId: string }>;
	readonly sessionFile?: string;
	readonly activeLeaf?: string;
	readonly rawFrameCursor: number;
	readonly eventCursor: number;
	readonly operationId: string;
	readonly assistantText?: string;
	readonly events?: readonly GjcTurnEvent[];
	readonly modelSelection?: NormalizedModelSelection;
	readonly observations?: Readonly<Record<string, unknown>>;
	readonly journal: readonly SessionAuthorityV3Operation[];
	readonly reassignment?: SessionAuthorityV3Reassignment;
};

export type SessionAuthorityV3ProvisionalOperation = SessionAuthorityV3Operation & {
	readonly chatId: string;
	readonly projectId: string;
	readonly sessionFile?: string;
	readonly activeLeaf?: string;
} & (
		| ({ readonly sessionId: string } & SessionAuthorityV3Binding)
		| {
				readonly sessionId?: never;
				readonly managedAuthority?: never;
				readonly historicalBinding?: HistoricalSessionBinding;
		  }
	);

export interface SessionAuthorityV3Document {
	readonly kind: typeof SESSION_AUTHORITY_V3_KIND;
	readonly version: typeof SESSION_AUTHORITY_V3_VERSION;
	readonly authorityEpoch: typeof SESSION_AUTHORITY_V3_EPOCH;
	readonly mappings: readonly SessionAuthorityV3Mapping[];
	readonly provisionalOperations: readonly SessionAuthorityV3ProvisionalOperation[];
}

const FORBIDDEN_FIELDS = new Set([
	"attachment",
	"descriptor",
	"descriptorPath",
	"descriptorStat",
	"payloadDigest",
	"expectedSessionId",
	"expectedCwd",
	"tmuxSocket",
	"tmuxPane",
	"tmuxPanePid",
	"tmuxOwnershipTag",
	"ownedAt",
	"recoveryAttachment",
	"token",
	"endpointToken",
	"endpointUrl",
	"endpointIncarnation",
	"processIncarnation",
	"hostIncarnation",
	"pid",
]);
const operationKinds = new Set<SessionAuthorityV3OperationKind>([
	"create",
	"resume",
	"close",
	"prompt",
	"reply",
	"gate",
	"branch",
	"model",
	"thinking",
]);
const operationStates = new Set<SessionAuthorityV3OperationState>(["pending", "complete", "uncertain", "conflict"]);

export function copyManagedTurnAuthorityV3(authority: ManagedTurnAuthorityV3): ManagedTurnAuthorityV3 {
	return { ...authority };
}

export function copySessionAuthorityV3Document(document: SessionAuthorityV3Document): SessionAuthorityV3Document {
	return structuredClone(document);
}

export const copySessionAuthorityV3 = copySessionAuthorityV3Document;

export function isSessionAuthorityV3Document(value: unknown): value is SessionAuthorityV3Document {
	if (
		containsForbiddenLegacyField(value) ||
		!exactKeys(value, ["kind", "version", "authorityEpoch", "mappings", "provisionalOperations"])
	)
		return false;
	if (
		value.kind !== SESSION_AUTHORITY_V3_KIND ||
		value.version !== SESSION_AUTHORITY_V3_VERSION ||
		value.authorityEpoch !== SESSION_AUTHORITY_V3_EPOCH
	)
		return false;
	if (!Array.isArray(value.mappings) || !Array.isArray(value.provisionalOperations)) return false;
	return (
		value.mappings.every(isMapping) &&
		value.provisionalOperations.every(isProvisional) &&
		isSessionAuthorityV3RelationallyValid(
			value as unknown as Pick<SessionAuthorityV3Document, "mappings" | "provisionalOperations">,
		)
	);
}

export function isSessionAuthorityV3RelationallyValid(
	document: Pick<SessionAuthorityV3Document, "mappings" | "provisionalOperations">,
): boolean {
	const mappings = new Map<string, SessionAuthorityV3Mapping>();
	const identities = new Map<string, string>();
	const provisionalIdentities = new Set<string>();
	for (const mapping of document.mappings) {
		if (mappings.has(mapping.chatId)) return false;
		const mappingBinding = bindingIdentity(mapping);
		const scope = mapping.observations?.__gjcSessionMappingScope;
		if (
			scope !== undefined &&
			(!isRecord(scope) ||
				scope.principalId !== mappingBinding?.principalId ||
				(scope.chatId !== undefined &&
					(typeof scope.chatId !== "string" ||
						JSON.stringify([scope.principalId, scope.chatId]) !== mapping.chatId)))
		)
			return false;
		mappings.set(mapping.chatId, mapping);
		if (!validateJournal(mapping, mapping.journal, identities)) return false;
		for (const root of tombstoneRoots(mapping.reassignment))
			for (
				let tombstone: SessionAuthorityV3Tombstone | undefined = root;
				tombstone !== undefined;
				tombstone = tombstone.prior
			) {
				if (
					tombstone.chatId !== mapping.chatId ||
					!compatibleOwnership(mapping, tombstone, false) ||
					!validateBinding(tombstone, tombstone)
				)
					return false;
				if (!validateJournal(tombstone, tombstone.journal, identities)) return false;
			}
	}
	for (const provisional of document.provisionalOperations) {
		const mapping = mappings.get(provisional.chatId);
		if (!validateLifecycleSourceReference(provisional, mapping?.journal ?? [])) return false;
		if (
			!validateLifecycleOwner(
				provisional.lifecycle,
				provisional.chatId,
				provisional.projectId,
				bindingIdentity(provisional) ??
					(mapping?.projectId === provisional.projectId ? bindingIdentity(mapping) : undefined),
			)
		)
			return false;
		for (const identifier of operationIdentifiers(provisional)) {
			const key = `${provisional.chatId}\u0000${identifier}`;
			if (provisionalIdentities.has(key)) return false;
			provisionalIdentities.add(key);
		}
		const publicationReceipt = isCompletedPublicationReceipt(mapping, provisional);
		if (
			mapping !== undefined &&
			bindingIdentity(provisional) !== undefined &&
			!compatibleOwnership(mapping, provisional, mapping.projectId === provisional.projectId)
		)
			return false;
		if (
			provisional.sessionId !== undefined &&
			!validateBinding(provisional, {
				chatId: provisional.chatId,
				projectId: provisional.projectId,
				sessionId: provisional.sessionId,
			})
		)
			return false;
		const owner =
			bindingIdentity(provisional) ??
			(mapping?.projectId === provisional.projectId ? bindingIdentity(mapping) : undefined);
		if (
			(provisional.result !== undefined || provisional.acknowledgedSuccessor !== undefined) &&
			(owner === undefined ||
				!validateJournal(
					{
						chatId: provisional.chatId,
						projectId: provisional.projectId,
						sessionId: owner.sessionId,
						binding: owner,
					},
					[provisional],
					new Map(),
				))
		)
			return false;
		if (
			mapping !== undefined &&
			mapping.projectId !== provisional.projectId &&
			!isPermittedReassignmentProvisional(mapping, provisional) &&
			!publicationReceipt
		)
			return false;
		if (!addOperationIdentity(identities, provisional.chatId, provisional) && !publicationReceipt) return false;
	}
	return true;
}

export function parseSessionAuthorityV3Document(input: string | Uint8Array): SessionAuthorityV3Document | undefined {
	try {
		const value: unknown = JSON.parse(typeof input === "string" ? input : new TextDecoder().decode(input));
		return isSessionAuthorityV3Document(value) ? copySessionAuthorityV3Document(value) : undefined;
	} catch {
		return undefined;
	}
}

export const decodeSessionAuthorityV3Document = parseSessionAuthorityV3Document;

export function isSessionAuthorityV3Mapping(value: unknown): value is SessionAuthorityV3Mapping {
	return !containsForbiddenLegacyField(value) && isMapping(value);
}

export function isSessionAuthorityV3ProvisionalOperation(
	value: unknown,
): value is SessionAuthorityV3ProvisionalOperation {
	return !containsForbiddenLegacyField(value) && isProvisional(value);
}

export function encodeSessionAuthorityV3Document(document: SessionAuthorityV3Document): string {
	if (!isSessionAuthorityV3Document(document))
		throw new Error("Refusing to encode an invalid v3 session authority document.");
	return `${JSON.stringify(canonicalize(copySessionAuthorityV3Document(document)))}\n`;
}

/** Historical journal/tombstone nodes remain readable; unbound live mappings
 * and unresolved provisional roots cannot admit a serving runtime. */
export function hasUnboundServingAuthority(document: SessionAuthorityV3Document): boolean {
	return (
		document.mappings.some(mapping => mapping.historicalBinding !== undefined) ||
		document.provisionalOperations.some(
			operation => operation.historicalBinding !== undefined && operation.state !== "complete",
		)
	);
}

function isMapping(value: unknown): value is SessionAuthorityV3Mapping {
	return (
		isRecordShape(value, [
			"version",
			"authorityEpoch",
			"chatId",
			"projectId",
			"sessionId",
			"createdAt",
			"header",
			"rawFrameCursor",
			"eventCursor",
			"operationId",
			"assistantText",
			"events",
			"modelSelection",
			"observations",
			"managedAuthority",
			"historicalBinding",
			"sessionFile",
			"activeLeaf",
			"journal",
			"reassignment",
		]) &&
		value.version === SESSION_AUTHORITY_V3_VERSION &&
		value.authorityEpoch === SESSION_AUTHORITY_V3_EPOCH &&
		isIdentity(value) &&
		isTimestamp(value.createdAt) &&
		isCursors(value) &&
		optionalFieldsValid(value) &&
		validateBinding(value, value as Readonly<{ chatId: unknown; projectId: unknown; sessionId: unknown }>) &&
		Array.isArray(value.journal) &&
		value.journal.every(
			operation =>
				isOperation(operation) &&
				!(
					value.historicalBinding !== undefined &&
					operation.lifecycle?.historicalSource !== undefined &&
					operation.result !== undefined
				) &&
				validateLifecycleOwner(
					operation.lifecycle,
					value.chatId as string,
					value.projectId as string,
					bindingIdentity(value),
				) &&
				validateLifecycleSourceReference(operation, value.journal as SessionAuthorityV3Operation[]),
		) &&
		(value.reassignment === undefined ||
			isReassignment(value.reassignment, value as unknown as SessionAuthorityV3Mapping))
	);
}

function isProvisional(value: unknown): value is SessionAuthorityV3ProvisionalOperation {
	if (
		!isRecordShape(value, [
			"id",
			"kind",
			"state",
			"ingressId",
			"startedAt",
			"completedAt",
			"detail",
			"result",
			"acknowledgedSuccessor",
			"lifecycle",
			"chatId",
			"projectId",
			"sessionId",
			"managedAuthority",
			"historicalBinding",
			"sessionFile",
			"activeLeaf",
		])
	)
		return false;
	return (
		isNonEmptyString(value.chatId) &&
		isNonEmptyString(value.projectId) &&
		isOperation(value) &&
		!(
			value.historicalBinding !== undefined &&
			value.lifecycle?.historicalSource !== undefined &&
			value.result !== undefined
		) &&
		validProjection(value) &&
		validateLifecycleOwner(value.lifecycle, value.chatId, value.projectId, bindingIdentity(value)) &&
		validateBinding(value, { chatId: value.chatId, projectId: value.projectId, sessionId: value.sessionId }, true)
	);
}

function isOperation(value: unknown): value is SessionAuthorityV3Operation {
	if (
		!isRecordShape(value, [
			"id",
			"kind",
			"state",
			"ingressId",
			"startedAt",
			"completedAt",
			"detail",
			"result",
			"acknowledgedSuccessor",
			"lifecycle",
			"chatId",
			"projectId",
			"sessionId",
			"managedAuthority",
			"historicalBinding",
			"sessionFile",
			"activeLeaf",
		])
	)
		return false;
	if (
		!isNonEmptyString(value.id) ||
		typeof value.kind !== "string" ||
		!operationKinds.has(value.kind as SessionAuthorityV3OperationKind) ||
		typeof value.state !== "string" ||
		!operationStates.has(value.state as SessionAuthorityV3OperationState) ||
		!isTimestamp(value.startedAt)
	)
		return false;
	if (value.ingressId !== undefined && !isNonEmptyString(value.ingressId)) return false;
	if (value.detail !== undefined && typeof value.detail !== "string") return false;
	if (
		value.lifecycle !== undefined &&
		(!isManagedLifecycleEvidence(value.lifecycle) ||
			Date.parse(value.lifecycle.recordedAt) < Date.parse(value.startedAt) ||
			value.lifecycle.payloadHash !== value.detail)
	)
		return false;
	if (value.state === "complete") {
		if (!isTimestamp(value.completedAt) || Date.parse(value.completedAt) < Date.parse(value.startedAt)) return false;
		if (value.result !== undefined && !isResult(value.result)) return false;
	} else if (value.completedAt !== undefined || value.result !== undefined) return false;
	if (
		value.acknowledgedSuccessor !== undefined &&
		!(
			(value.kind === "create" || value.kind === "branch") &&
			(value.state === "pending" || value.state === "uncertain") &&
			isSuccessor(value.acknowledgedSuccessor)
		)
	)
		return false;
	return validateOperationLifecycle(value as unknown as SessionAuthorityV3Operation);
}

function validateOperationLifecycle(operation: SessionAuthorityV3Operation): boolean {
	const lifecycle = operation.lifecycle;
	if (lifecycle === undefined) return true;
	const kind = {
		"session.create": "create",
		"session.resume": "resume",
		"session.fork": "branch",
		"session.close": "close",
	} as const;
	// No canonical routing journal kind represents public delete yet.
	if (lifecycle.operation === "session.delete" || operation.kind !== kind[lifecycle.operation]) return false;
	const successor = operation.acknowledgedSuccessor;
	if (
		successor !== undefined &&
		(lifecycle.acknowledged === undefined ||
			successor.managedAuthority === undefined ||
			successor.sessionId !== lifecycle.acknowledged.sessionId ||
			!matchesLifecycleAuthority(successor.managedAuthority, lifecycle.acknowledged))
	)
		return false;
	if (operation.state !== "complete") return true;
	if (Date.parse(lifecycle.recordedAt) > Date.parse(operation.completedAt!)) return false;
	if (lifecycle.state === "terminal_failure") return operation.result === undefined;
	if (lifecycle.state !== "active_generation_proven" && lifecycle.state !== "retired") return false;
	const result = operation.result;
	if (result === undefined) return true;
	if (result.managedAuthority === undefined) return false;
	if (lifecycle.operation === "session.close") {
		const source = lifecycle.source;
		const retirement = lifecycle.retirement;
		return (
			result.kind === "close" &&
			lifecycle.state === "retired" &&
			source !== undefined &&
			retirement !== undefined &&
			matchesLifecycleAuthority(result.managedAuthority, source) &&
			result.mapping.sessionId === source.sessionId &&
			retirement.sessionId === source.sessionId &&
			retirement.generation === source.generation &&
			retirement.acknowledgedSessionId === source.sessionId
		);
	}
	const acknowledged = lifecycle.acknowledged;
	const proven = lifecycle.proven;
	return (
		result.kind !== "close" &&
		lifecycle.state === "active_generation_proven" &&
		acknowledged !== undefined &&
		proven !== undefined &&
		matchesLifecycleAuthority(result.managedAuthority, acknowledged) &&
		result.mapping.sessionId === acknowledged.sessionId &&
		proven.sessionId === result.managedAuthority.sessionId &&
		proven.generation === result.managedAuthority.generation &&
		proven.leaseId === result.managedAuthority.leaseId &&
		proven.epoch === result.managedAuthority.epoch
	);
}

function matchesLifecycleAuthority(actual: ManagedTurnAuthorityV3, expected: ManagedTurnAuthority): boolean {
	return (
		[
			"principalId",
			"projectId",
			"canonicalWorkspace",
			"sessionId",
			"generation",
			"leaseId",
			"epoch",
			"requestKey",
		].every(field => actual[field as keyof ManagedTurnAuthority] === expected[field as keyof ManagedTurnAuthority]) &&
		(actual.chatId === expected.chatId || actual.chatId === JSON.stringify([expected.principalId, expected.chatId]))
	);
}

function isResult(value: unknown): value is SessionAuthorityV3Result {
	if (
		!isRecordShape(value, [
			"kind",
			"assistantText",
			"managedAuthority",
			"historicalBinding",
			"events",
			"mapping",
			"correlation",
			"gate",
		]) ||
		(value.kind !== "turn" && value.kind !== "control" && value.kind !== "close") ||
		typeof value.assistantText !== "string" ||
		!isResultMapping(value.mapping) ||
		!validateBinding(value, value.mapping)
	)
		return false;
	const correlation = value.correlation as Record<string, unknown> | undefined;
	const gate = value.gate as Record<string, unknown> | undefined;
	if (value.events !== undefined && (!Array.isArray(value.events) || !value.events.every(isEvent))) return false;
	if (correlation !== undefined && (!isRecord(correlation) || !Object.values(correlation).every(isNonEmptyString)))
		return false;
	if (
		gate !== undefined &&
		(!isRecordShape(gate, ["gateId", "commandId", "turnId", "sessionId"]) ||
			!isNonEmptyString(gate.gateId) ||
			![gate.commandId, gate.turnId, gate.sessionId].every(item => item === undefined || isNonEmptyString(item)))
	)
		return false;
	return (
		value.kind !== "close" ||
		(correlation !== undefined &&
			correlation.closeStatus === "closed" &&
			Object.keys(correlation).every(key => key === "closeStatus" || key === "mappingOperationId"))
	);
}

function isResultMapping(value: unknown): value is SessionAuthorityV3Result["mapping"] {
	return (
		isRecordShape(value, [
			"chatId",
			"projectId",
			"sessionId",
			"rawFrameCursor",
			"eventCursor",
			"operationId",
			"sessionFile",
			"activeLeaf",
			"modelSelection",
		]) &&
		[value.chatId, value.projectId, value.sessionId, value.operationId].every(isNonEmptyString) &&
		isCursors(value) &&
		validProjection(value) &&
		(value.modelSelection === undefined || normalizeModelSelection(value.modelSelection) !== undefined)
	);
}

function isSuccessor(value: unknown): value is SessionAuthorityV3AcknowledgedSuccessor {
	const authority = bindingIdentity(value);
	return (
		isRecordShape(value, ["sessionId", "managedAuthority", "historicalBinding"]) &&
		isNonEmptyString(value.sessionId) &&
		validateBinding(value, {
			chatId: authority?.chatId,
			projectId: authority?.projectId,
			sessionId: value.sessionId,
		})
	);
}

function isReassignment(value: unknown, mapping: SessionAuthorityV3Mapping): value is SessionAuthorityV3Reassignment {
	if (
		!isRecordShape(value, [
			"state",
			"sourceProjectId",
			"targetProjectId",
			"startedAt",
			"completedAt",
			"target",
			"sourceTombstone",
			"priorTombstone",
		]) ||
		(value.state !== "pending" && value.state !== "rolled_back" && value.state !== "committed") ||
		!isNonEmptyString(value.sourceProjectId) ||
		!isNonEmptyString(value.targetProjectId) ||
		value.sourceProjectId === value.targetProjectId ||
		!isTimestamp(value.startedAt) ||
		(value.completedAt !== undefined && !isTimestamp(value.completedAt))
	)
		return false;
	const target = value.target as Record<string, unknown> | undefined;
	if ((value.state === "committed" ? value.targetProjectId : value.sourceProjectId) !== mapping.projectId)
		return false;
	if (
		target !== undefined &&
		(!isRecordShape(target, ["id", "ingressId", "kind", "detail"]) ||
			!isNonEmptyString(target.id) ||
			(target.ingressId !== undefined && !isNonEmptyString(target.ingressId)) ||
			typeof target.kind !== "string" ||
			!operationKinds.has(target.kind as SessionAuthorityV3OperationKind) ||
			(target.detail !== undefined && typeof target.detail !== "string"))
	)
		return false;
	if (value.state === "pending" && value.sourceTombstone !== undefined) return false;
	if (value.state === "committed" && !isTombstone(value.sourceTombstone)) return false;
	if (
		isRecord(value.sourceTombstone) &&
		value.priorTombstone !== undefined &&
		!isDeepStrictEqual(value.priorTombstone, value.sourceTombstone.prior)
	)
		return false;
	return (
		(value.sourceTombstone === undefined ||
			(isTombstone(value.sourceTombstone) &&
				value.sourceTombstone.chatId === mapping.chatId &&
				value.sourceTombstone.projectId === value.sourceProjectId)) &&
		(value.priorTombstone === undefined || isTombstone(value.priorTombstone))
	);
}

function isTombstone(value: unknown): value is SessionAuthorityV3Tombstone {
	return (
		isRecordShape(value, [
			"version",
			"authorityEpoch",
			"chatId",
			"projectId",
			"sessionId",
			"createdAt",
			"header",
			"rawFrameCursor",
			"eventCursor",
			"operationId",
			"assistantText",
			"events",
			"modelSelection",
			"observations",
			"managedAuthority",
			"historicalBinding",
			"sessionFile",
			"activeLeaf",
			"journal",
			"retiredAt",
			"prior",
		]) &&
		value.version === SESSION_AUTHORITY_V3_VERSION &&
		value.authorityEpoch === SESSION_AUTHORITY_V3_EPOCH &&
		isIdentity(value) &&
		isTimestamp(value.createdAt) &&
		isTimestamp(value.retiredAt) &&
		isCursors(value) &&
		optionalFieldsValid(value) &&
		validateBinding(value, value as Readonly<{ chatId: unknown; projectId: unknown; sessionId: unknown }>) &&
		Array.isArray(value.journal) &&
		value.journal.every(
			operation =>
				isOperation(operation) &&
				!(
					value.historicalBinding !== undefined &&
					operation.lifecycle?.historicalSource !== undefined &&
					operation.result !== undefined
				) &&
				validateLifecycleOwner(
					operation.lifecycle,
					value.chatId as string,
					value.projectId as string,
					bindingIdentity(value),
				) &&
				validateLifecycleSourceReference(operation, value.journal as SessionAuthorityV3Operation[]),
		) &&
		(value.prior === undefined || isTombstone(value.prior))
	);
}

function validateLifecycleOwner(value: unknown, chatId: string, projectId: string, owner?: unknown): boolean {
	if (value === undefined) return true;
	if (!isManagedLifecycleEvidence(value)) return false;
	const prepared = value.preparedAuthority;
	if (
		!matchesCanonicalPrincipal(chatId, prepared.principalId) ||
		prepared.projectId !== projectId ||
		(chatId !== prepared.chatId && chatId !== JSON.stringify([prepared.principalId, prepared.chatId]))
	)
		return false;
	if (isRecord(owner) && owner.kind === "unbound-history")
		return value.historicalSource !== undefined && isDeepStrictEqual(owner, value.historicalSource.historicalBinding);
	if (value.historicalSource !== undefined && owner === undefined) return false;
	if (
		owner !== undefined &&
		(!isRecord(owner) ||
			owner.principalId !== prepared.principalId ||
			owner.projectId !== prepared.projectId ||
			owner.canonicalWorkspace !== prepared.canonicalWorkspace)
	)
		return false;
	return [value.source, value.acknowledged].every(
		authority =>
			authority === undefined ||
			(authority.principalId === prepared.principalId &&
				authority.projectId === projectId &&
				authority.canonicalWorkspace === prepared.canonicalWorkspace &&
				authority.chatId === prepared.chatId),
	);
}

function validateLifecycleSourceReference(
	operation: SessionAuthorityV3Operation,
	journal: readonly SessionAuthorityV3Operation[],
): boolean {
	const lifecycle = operation.lifecycle;
	const reference = lifecycle?.sourceProofRef;
	if (reference === undefined) return true;
	const source = lifecycle?.source;
	if (source === undefined || reference.operationId === operation.id) return false;
	const candidates = journal.filter(candidate => isRecord(candidate) && candidate.id === reference.operationId);
	if (candidates.length !== 1) return false;
	const prior = candidates[0]!;
	if (
		!isOperation(prior) ||
		prior.state !== "complete" ||
		prior.completedAt === undefined ||
		Date.parse(prior.completedAt) > Date.parse(operation.startedAt)
	)
		return false;
	const evidence = prior.lifecycle;
	if (
		evidence?.state !== "active_generation_proven" ||
		evidence.acknowledged === undefined ||
		evidence.proven === undefined ||
		managedLifecycleEvidenceHash(evidence) !== reference.evidenceHash
	)
		return false;
	return (
		[
			"principalId",
			"projectId",
			"canonicalWorkspace",
			"chatId",
			"sessionId",
			"generation",
			"leaseId",
			"epoch",
		] as const
	).every(field => evidence.acknowledged![field] === source[field]);
}

function validateJournal(
	owner: {
		readonly chatId: string;
		readonly projectId: string;
		readonly sessionId?: unknown;
		readonly binding?: Record<string, unknown>;
		readonly managedAuthority?: ManagedTurnAuthorityV3;
		readonly historicalBinding?: HistoricalSessionBinding;
	},
	journal: readonly SessionAuthorityV3Operation[],
	identities: Map<string, string>,
): boolean {
	const local = new Set<string>();
	const ownerBinding = owner.binding ?? bindingIdentity(owner);
	for (const operation of journal) {
		if (!validateLifecycleOwner(operation.lifecycle, owner.chatId, owner.projectId, ownerBinding)) return false;
		if (
			ownerBinding?.kind === "unbound-history" &&
			operation.lifecycle?.historicalSource !== undefined &&
			operation.result !== undefined
		)
			return false;
		const successor = operation.acknowledgedSuccessor;
		if (
			successor !== undefined &&
			(!validateBinding(successor, { ...owner, sessionId: successor.sessionId }) ||
				!compatibleBindingOwnership(ownerBinding, bindingIdentity(successor), true))
		)
			return false;
		for (const identifier of operationIdentifiers(operation))
			if (local.has(identifier)) return false;
			else local.add(identifier);
		if (
			operation.result !== undefined &&
			(operation.result.mapping.chatId !== owner.chatId ||
				operation.result.mapping.projectId !== owner.projectId ||
				operation.result.mapping.operationId !== operation.id ||
				!compatibleBindingOwnership(ownerBinding, bindingIdentity(operation.result), true) ||
				!validateBinding(operation.result, operation.result.mapping))
		)
			return false;
		if (!addOperationIdentity(identities, owner.chatId, operation)) return false;
	}
	return true;
}

function isPermittedReassignmentProvisional(
	mapping: SessionAuthorityV3Mapping,
	provisional: SessionAuthorityV3ProvisionalOperation,
): boolean {
	const reassignment = mapping.reassignment;
	if (
		reassignment === undefined ||
		reassignment.targetProjectId !== provisional.projectId ||
		reassignment.target === undefined
	)
		return false;
	if (reassignment.state === "rolled_back" && provisional.state !== "uncertain" && provisional.state !== "conflict")
		return false;
	return (
		reassignment.state !== "committed" &&
		operationIdentity(provisional) ===
			JSON.stringify([reassignment.target.id, reassignment.target.ingressId ?? reassignment.target.id]) &&
		provisional.kind === reassignment.target.kind &&
		provisional.detail === reassignment.target.detail
	);
}

function isCompletedPublicationReceipt(
	mapping: SessionAuthorityV3Mapping | undefined,
	provisional: SessionAuthorityV3ProvisionalOperation,
): boolean {
	if (mapping === undefined || provisional.state !== "complete") return false;
	const matches = (owner: SessionAuthorityV3Mapping | SessionAuthorityV3Tombstone): boolean => {
		if (owner.chatId !== provisional.chatId || owner.projectId !== provisional.projectId) return false;
		const operation = owner.journal.find(
			candidate => operationIdentity(candidate) === operationIdentity(provisional),
		);
		return (
			operation !== undefined &&
			operation.state === "complete" &&
			(operation.kind === "prompt" ||
				(operation.kind === "create" && operation.lifecycle?.operation === "session.create")) &&
			(provisional.kind === "prompt" || provisional.kind === "create") &&
			isDeepStrictEqual(operation.lifecycle, provisional.lifecycle) &&
			operation.detail === provisional.detail &&
			operation.startedAt === provisional.startedAt &&
			operation.completedAt === provisional.completedAt &&
			operation.result !== undefined &&
			(provisional.sessionId === undefined ||
				(provisional.sessionId === operation.result.mapping.sessionId &&
					publicationBindingMatches(provisional, operation.result)))
		);
	};
	if (matches(mapping)) return true;
	for (const root of tombstoneRoots(mapping.reassignment))
		for (
			let tombstone: SessionAuthorityV3Tombstone | undefined = root;
			tombstone !== undefined;
			tombstone = tombstone.prior
		)
			if (matches(tombstone)) return true;
	return false;
}

function validateAuthority(
	value: unknown,
	identity: Readonly<{ chatId: unknown; projectId: unknown; sessionId: unknown }>,
): value is ManagedTurnAuthorityV3 {
	return (
		isRecordShape(value, [
			"authorityEpoch",
			"principalId",
			"projectId",
			"canonicalWorkspace",
			"chatId",
			"sessionId",
			"generation",
			"leaseId",
			"epoch",
			"requestKey",
		]) &&
		value.authorityEpoch === SESSION_AUTHORITY_V3_EPOCH &&
		isNonEmptyString(value.principalId) &&
		matchesCanonicalPrincipal(value.chatId, value.principalId) &&
		value.projectId === identity.projectId &&
		isNonEmptyString(value.canonicalWorkspace) &&
		isAbsolute(value.canonicalWorkspace) &&
		value.chatId === identity.chatId &&
		value.sessionId === identity.sessionId &&
		isNonnegativeSafeInteger(value.generation) &&
		value.generation > 0 &&
		isNonEmptyString(value.leaseId) &&
		isNonEmptyString(value.epoch) &&
		isNonEmptyString(value.requestKey)
	);
}

function validateBinding(
	value: unknown,
	identity: { readonly chatId?: unknown; readonly projectId?: unknown; readonly sessionId?: unknown },
	unassigned = false,
): boolean {
	if (!isRecord(value)) return false;
	if (value.managedAuthority !== undefined)
		return (
			value.historicalBinding === undefined &&
			isNonEmptyString(identity.sessionId) &&
			validateAuthority(value.managedAuthority, {
				chatId: identity.chatId,
				projectId: identity.projectId,
				sessionId: identity.sessionId,
			})
		);
	if (value.historicalBinding !== undefined) return isHistoricalSessionBinding(value.historicalBinding, identity);
	return unassigned && identity.sessionId === undefined;
}

function bindingIdentity(value: unknown): Record<string, unknown> | undefined {
	if (!isRecord(value)) return undefined;
	const binding = value.managedAuthority ?? value.historicalBinding;
	return isRecord(binding) ? binding : undefined;
}
function compatibleOwnership(owner: unknown, child: unknown, workspace: boolean): boolean {
	return compatibleBindingOwnership(bindingIdentity(owner), bindingIdentity(child), workspace);
}
function compatibleBindingOwnership(
	owner: Record<string, unknown> | undefined,
	child: Record<string, unknown> | undefined,
	workspace: boolean,
): boolean {
	if (owner === undefined || child === undefined) return false;
	for (const field of workspace ? ["principalId", "canonicalWorkspace"] : ["principalId"]) {
		if (owner[field] !== undefined && child[field] !== undefined && owner[field] !== child[field]) return false;
		if (owner.kind !== "unbound-history" && child.kind !== "unbound-history" && owner[field] !== child[field])
			return false;
	}
	return true;
}

function publicationBindingMatches(
	provisional: SessionAuthorityV3ProvisionalOperation,
	result: SessionAuthorityV3Result,
): boolean {
	if (provisional.managedAuthority !== undefined || result.managedAuthority !== undefined)
		return isDeepStrictEqual(provisional.managedAuthority, result.managedAuthority);
	const left = provisional.historicalBinding;
	const right = result.historicalBinding;
	return (
		left !== undefined &&
		right !== undefined &&
		(["chatId", "projectId", "sessionId", "principalId", "canonicalWorkspace"] as const).every(
			field => left[field] === right[field],
		)
	);
}

function validProjection(value: Record<string, unknown>): boolean {
	return (
		(value.sessionFile === undefined || (isNonEmptyString(value.sessionFile) && isAbsolute(value.sessionFile))) &&
		(value.activeLeaf === undefined || isNonEmptyString(value.activeLeaf))
	);
}

function isIdentity(value: Record<string, unknown>): boolean {
	const header = value.header as Record<string, unknown> | undefined;
	return (
		[value.chatId, value.projectId, value.sessionId, value.operationId].every(isNonEmptyString) &&
		isRecordShape(header, ["chatId", "projectId", "sessionId"]) &&
		header.chatId === value.chatId &&
		header.projectId === value.projectId &&
		header.sessionId === value.sessionId
	);
}

function matchesCanonicalPrincipal(chatId: unknown, principalId: string): boolean {
	if (typeof chatId !== "string") return false;
	try {
		const scope: unknown = JSON.parse(chatId);
		if (
			!Array.isArray(scope) ||
			scope.length !== 2 ||
			!scope.every(value => typeof value === "string") ||
			JSON.stringify(scope) !== chatId
		)
			return true;
		return scope[0] === principalId;
	} catch {
		return true;
	}
}
function isCursors(value: Record<string, unknown>): boolean {
	return isNonnegativeSafeInteger(value.rawFrameCursor) && isNonnegativeSafeInteger(value.eventCursor);
}
function optionalFieldsValid(value: Record<string, unknown>): boolean {
	return (
		validProjection(value) &&
		(value.assistantText === undefined || typeof value.assistantText === "string") &&
		(value.events === undefined || (Array.isArray(value.events) && value.events.every(isEvent))) &&
		(value.modelSelection === undefined || normalizeModelSelection(value.modelSelection) !== undefined) &&
		(value.observations === undefined || (isRecord(value.observations) && isJsonValue(value.observations)))
	);
}
function isEvent(value: unknown): value is GjcTurnEvent {
	return (
		isRecordShape(value, ["type", "text", "id", "payload"]) &&
		isNonEmptyString(value.type) &&
		(value.text === undefined || typeof value.text === "string") &&
		(value.id === undefined || isNonEmptyString(value.id)) &&
		(value.payload === undefined || (isRecord(value.payload) && isJsonValue(value.payload)))
	);
}
function isRecordShape(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	return isRecord(value) && Object.keys(value).every(key => keys.includes(key));
}
function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	return isRecord(value) && Object.keys(value).length === keys.length && keys.every(key => key in value);
}
function operationIdentifiers(operation: Pick<SessionAuthorityV3Operation, "id" | "ingressId">): readonly string[] {
	return operation.ingressId === undefined || operation.ingressId === operation.id
		? [operation.id]
		: [operation.id, operation.ingressId];
}
function operationIdentity(operation: Pick<SessionAuthorityV3Operation, "id" | "ingressId">): string {
	return JSON.stringify([operation.id, operation.ingressId ?? operation.id]);
}
function addOperationIdentity(
	identities: Map<string, string>,
	chatId: string,
	operation: SessionAuthorityV3Operation,
): boolean {
	const identity = operationIdentity(operation);
	for (const identifier of operationIdentifiers(operation)) {
		const key = `${chatId}\u0000${identifier}`;
		if (identities.has(key)) return false;
		identities.set(key, identity);
	}
	return true;
}
function tombstoneRoots(
	reassignment: SessionAuthorityV3Reassignment | undefined,
): readonly SessionAuthorityV3Tombstone[] {
	return reassignment?.sourceTombstone !== undefined
		? [reassignment.sourceTombstone]
		: reassignment?.priorTombstone === undefined
			? []
			: [reassignment.priorTombstone];
}
function containsForbiddenLegacyField(value: unknown, path = ""): boolean {
	if (Array.isArray(value))
		return value.some((child, index) => containsForbiddenLegacyField(child, `${path}/${index}`));
	if (!isRecord(value)) return false;
	const savedResume =
		/^(?:\/mappings\/\d+(?:\/reassignment\/(?:sourceTombstone|priorTombstone)(?:\/prior)*)?\/journal\/\d+|\/provisionalOperations\/\d+|\/journal\/\d+|\/reassignment\/(?:sourceTombstone|priorTombstone)(?:\/prior)*\/journal\/\d+)?\/lifecycle$/.test(
			path,
		) &&
		isManagedLifecycleEvidence(value) &&
		value.historicalSource !== undefined;
	const projection =
		/^(?:\/mappings\/\d+(?:\/reassignment\/(?:sourceTombstone|priorTombstone)(?:\/prior)*)?|\/provisionalOperations\/\d+)(?:\/journal\/\d+\/result\/mapping)?$/.test(
			path,
		) ||
		/^\/provisionalOperations\/\d+\/result\/mapping$/.test(path) ||
		/^\/(?:journal\/\d+\/result\/mapping|result\/mapping|reassignment\/(?:sourceTombstone|priorTombstone)(?:\/prior)*(?:\/journal\/\d+\/result\/mapping)?)$/.test(
			path,
		) ||
		(path === "" && (value.version === 3 || (isNonEmptyString(value.chatId) && isNonEmptyString(value.projectId))));
	return Object.entries(value).some(
		([key, child]) =>
			FORBIDDEN_FIELDS.has(key) ||
			["sessionPath", "sessionIdentity", "savedSession"].includes(key) ||
			((key === "sessionFile" || key === "activeLeaf") && !projection) ||
			(!(savedResume && (key === "target" || key === "historicalSource")) &&
				containsForbiddenLegacyField(child, `${path}/${key}`)),
	);
}
function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map(key => [key, canonicalize(value[key])]),
	);
}
