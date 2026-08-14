import {
	canonicalSessionMappingKey,
	type ProvisionalSessionOperation,
	SessionAuthority,
	type SessionAuthorityInput,
	type SessionOperation,
	type SessionOperationResult,
	type SessionOperationState,
} from "./session-authority";
import type {
	AcknowledgedSuccessor,
	SessionAuthorityReassignment,
	SessionAuthorityRecord,
	SessionAuthorityTargetIdentity,
	SessionAuthorityTombstone,
	SessionOperationGateBinding,
} from "./session-authority-types";
import { copySessionMapping } from "./session-mapping-copy";
import type { SessionMapping, SessionMappingScope } from "./session-mapping-store";
import { operationResult } from "./session-operation-codec";

const SCOPED_MAPPING_OBSERVATION = "__gjcSessionMappingScope";
const SCOPED_MAPPING_RETIREMENT_OBSERVATION = "__gjcSessionMappingRetirement";

interface StoredMappingScope {
	readonly principalId: string;
	readonly chatId?: string;
}

interface CanonicalScope extends SessionMappingScope {
	readonly key: string;
}

interface AuthorityState {
	readonly records: readonly SessionAuthorityRecord[];
	readonly provisional: readonly ProvisionalSessionOperation[];
}

type AuthorityStateMutation = (
	records: readonly SessionAuthorityRecord[],
	provisional: readonly ProvisionalSessionOperation[],
) => AuthorityState;

interface ScopedMappingRetirement {
	readonly principalId: string;
	readonly chatId: string;
	readonly retiredAt: string;
	readonly operationIds: readonly string[];
	readonly provisionalOperationIds: readonly string[];
}

export class SessionMappingStore {
	#adminPrincipalId: string | undefined;

	constructor(protected readonly authority: SessionAuthority = new SessionAuthority()) {}

	/**
	 * Configures the sole administrator principal. Scoped lookups for exactly
	 * this principal fall back to legacy unscoped mappings, which by invariant
	 * belong only to the configured admin (historical-import rows and
	 * pre-scoping authority state). Normal principals never see them.
	 */
	setLegacyAdminPrincipalId(principalId: string | undefined): void {
		this.#adminPrincipalId = principalId?.trim() || undefined;
	}

	get(chatId: string): SessionMapping | undefined {
		const record = this.authority.get(chatId);
		return record === undefined || isRetiredRecord(record) ? undefined : mappingFromRecord(record);
	}
	set(mapping: SessionMapping): SessionMapping {
		assertLegacyKeyAvailable(this.authority, mapping.chatId);
		return mappingFromRecord(this.authority.set(authorityInputFromLegacyMapping(mapping)));
	}
	upsert(mapping: SessionMapping): SessionMapping {
		assertLegacyKeyAvailable(this.authority, mapping.chatId);
		return mappingFromRecord(this.authority.upsert(authorityInputFromLegacyMapping(mapping)));
	}
	getScoped(scope: SessionMappingScope): SessionMapping | undefined {
		const canonicalScope = canonicalScopeFor(scope);
		const record = this.authority.get(canonicalScope.key);
		if (record !== undefined && isScopedRecordFor(record, canonicalScope) && !isRetiredRecord(record))
			return mappingFromRecord(record);
		if (this.#adminPrincipalId !== undefined && scope.principalId === this.#adminPrincipalId) {
			const legacy = this.authority.get(scope.chatId);
			if (legacy !== undefined && !isScopedRecordFor(legacy, canonicalScope) && !isRetiredRecord(legacy)) {
				const mapping = mappingFromRecord(legacy);
				// Downstream scoped-only paths (HTTP close, idle reaper) treat a
				// missing principalId as unowned; bind the admin's legacy row to
				// the scoped principal exactly like the write path does.
				return mapping.principalId === undefined ? { ...mapping, principalId: scope.principalId } : mapping;
			}
		}
		return undefined;
	}
	setScoped(scope: SessionMappingScope, mapping: SessionMapping): SessionMapping {
		const canonicalScope = canonicalScopeFor(scope);
		assertScopedKeyAvailable(this.authority, canonicalScope);
		return mappingFromRecord(this.authority.set(authorityInputForScope(canonicalScope, mapping)));
	}
	upsertScoped(scope: SessionMappingScope, mapping: SessionMapping): SessionMapping {
		const canonicalScope = canonicalScopeFor(scope);
		assertScopedKeyAvailable(this.authority, canonicalScope);
		return mappingFromRecord(this.authority.upsert(authorityInputForScope(canonicalScope, mapping)));
	}
	beginProjectReassignment(
		chatId: string,
		currentProjectId: string,
		nextProjectId: string,
		target?: SessionAuthorityTargetIdentity,
	): void {
		assertLegacyKeyAvailable(this.authority, chatId);
		this.authority.beginProjectReassignment(chatId, currentProjectId, nextProjectId, target);
	}
	beginProjectReassignmentScoped(
		scope: SessionMappingScope,
		currentProjectId: string,
		nextProjectId: string,
		target?: SessionAuthorityTargetIdentity,
	): void {
		const canonicalScope = canonicalScopeFor(scope);
		assertScopedKeyAvailable(this.authority, canonicalScope);
		this.authority.beginProjectReassignment(canonicalScope.key, currentProjectId, nextProjectId, target);
	}
	rollbackProjectReassignment(chatId: string, currentProjectId: string): void {
		assertLegacyKeyAvailable(this.authority, chatId);
		this.authority.rollbackProjectReassignment(chatId, currentProjectId);
	}
	rollbackProjectReassignmentScoped(scope: SessionMappingScope, currentProjectId: string): void {
		const canonicalScope = canonicalScopeFor(scope);
		assertScopedKeyAvailable(this.authority, canonicalScope);
		this.authority.rollbackProjectReassignment(canonicalScope.key, currentProjectId);
	}
	reassignProjectAuthority(chatId: string, currentProjectId: string, nextProjectId: string): void {
		this.beginProjectReassignment(chatId, currentProjectId, nextProjectId);
	}
	reassignProjectAuthorityScoped(scope: SessionMappingScope, currentProjectId: string, nextProjectId: string): void {
		this.beginProjectReassignmentScoped(scope, currentProjectId, nextProjectId);
	}
	entries(): readonly SessionMapping[] {
		return this.authority
			.entries()
			.filter(record => !isRetiredRecord(record))
			.map(mappingFromRecord);
	}
	/**
	 * Read-only, no-copy view for boot synthesis: the same filters and scope
	 * derivation as {@link entries}, but the mapping shapes and their event
	 * arrays are shared by reference with the authority records. Callers must
	 * not mutate the returned mappings or their event payloads.
	 */
	mappingRecords(): readonly SessionMapping[] {
		return this.authority
			.records()
			.filter(record => !isRetiredRecord(record))
			.map(mappingFromRecordShallow);
	}
	entriesForPrincipal(
		principalId: string,
		options: { readonly includeLegacyAdmin?: boolean } = {},
	): readonly SessionMapping[] {
		assertPrincipalId(principalId);
		return this.authority
			.entries()
			.filter(record => {
				if (isRetiredRecord(record)) return false;
				const scope = compositeScopeFromRecord(record);
				if (scope?.principalId === principalId) return true;
				if (options.includeLegacyAdmin !== true) return false;
				const legacyScope = storedScopeFromRecord(record);
				return legacyScope?.principalId === principalId || legacyScope === undefined;
			})
			.map(mappingFromRecord);
	}
	entriesScoped(scope: SessionMappingScope): readonly SessionMapping[] {
		const mapping = this.getScoped(scope);
		return mapping === undefined ? [] : [mapping];
	}
	retireScoped(scope: SessionMappingScope): void {
		const canonicalScope = canonicalScopeFor(scope);
		this.mutateAuthorityState((records, provisional) => {
			const record = records.find(candidate => candidate.chatId === canonicalScope.key);
			if (record === undefined || !isScopedRecordFor(record, canonicalScope))
				throw new Error(`Unknown or cross-principal scoped session mapping for ${canonicalScope.key}.`);
			if (isRetiredRecord(record))
				throw new Error(`Scoped session mapping ${canonicalScope.key} is already retired.`);
			const retiredAt = new Date().toISOString();
			const retirement: ScopedMappingRetirement = {
				principalId: canonicalScope.principalId,
				chatId: canonicalScope.chatId,
				retiredAt,
				operationIds: record.journal.map(operation => operation.id),
				provisionalOperationIds: provisional
					.filter(operation => operation.chatId === canonicalScope.key)
					.map(operation => operation.id),
			};
			const nextRecord: SessionAuthorityRecord = {
				...record,
				events: undefined,
				journal: [],
				...(record.reassignment?.state === "pending" ? { reassignment: undefined } : {}),
				observations: {
					...(record.observations ?? {}),
					[SCOPED_MAPPING_RETIREMENT_OBSERVATION]: retirement,
				},
			};
			return {
				records: records.map(candidate => (candidate.chatId === canonicalScope.key ? nextRecord : candidate)),
				provisional: provisional.filter(operation => operation.chatId !== canonicalScope.key),
			};
		});
	}
	operation(chatId: string, operationId: string): SessionOperation | undefined {
		const record = this.authority.get(chatId);
		return record === undefined || isRetiredRecord(record)
			? undefined
			: this.authority.lookupOperation(chatId, operationId);
	}
	/** Copy-free operation state check (state + result mapping operationId)
	 * without deep-copying the record, its event payloads, or the operation
	 * result; used by boot projection synthesis to avoid document-sized
	 * allocations for oversized legacy records. */
	operationStateReference(
		chatId: string,
		operationId: string,
	): { readonly state: SessionOperationState; readonly resultOperationId?: string } | undefined {
		const record = this.authority.get(chatId);
		return record === undefined || isRetiredRecord(record)
			? undefined
			: this.authority.operationStateReference(chatId, operationId);
	}
	operationStateReferenceScoped(
		scope: SessionMappingScope,
		operationId: string,
	): { readonly state: SessionOperationState; readonly resultOperationId?: string } | undefined {
		const canonicalScope = canonicalScopeFor(scope);
		const record = this.authority.get(canonicalScope.key);
		return record === undefined || !isScopedRecordFor(record, canonicalScope) || isRetiredRecord(record)
			? undefined
			: this.authority.operationStateReference(canonicalScope.key, operationId);
	}
	operationScoped(scope: SessionMappingScope, operationId: string): SessionOperation | undefined {
		const canonicalScope = canonicalScopeFor(scope);
		const record = this.authority.get(canonicalScope.key);
		return record === undefined || !isScopedRecordFor(record, canonicalScope) || isRetiredRecord(record)
			? undefined
			: operationForScope(this.authority.lookupOperation(canonicalScope.key, operationId), canonicalScope);
	}
	operations(chatId: string): readonly SessionOperation[] {
		const record = this.authority.get(chatId);
		return record === undefined || isRetiredRecord(record) ? [] : record.journal;
	}
	operationsScoped(scope: SessionMappingScope): readonly SessionOperation[] {
		const canonicalScope = canonicalScopeFor(scope);
		const record = this.authority.get(canonicalScope.key);
		if (record === undefined || !isScopedRecordFor(record, canonicalScope) || isRetiredRecord(record)) return [];
		return record.journal.map(operation => operationForScope(operation, canonicalScope));
	}
	operationAuthority(
		chatId: string,
		operationId: string,
	): SessionAuthorityRecord | SessionAuthorityTombstone | undefined {
		const record = this.authority.get(chatId);
		return record === undefined || isRetiredRecord(record)
			? undefined
			: this.authority.lookupOperationAuthority(chatId, operationId);
	}
	operationAuthorityScoped(
		scope: SessionMappingScope,
		operationId: string,
	): SessionAuthorityRecord | SessionAuthorityTombstone | undefined {
		const canonicalScope = canonicalScopeFor(scope);
		const record = this.authority.get(canonicalScope.key);
		if (record === undefined || !isScopedRecordFor(record, canonicalScope) || isRetiredRecord(record))
			return undefined;
		const authority = this.authority.lookupOperationAuthority(canonicalScope.key, operationId);
		if (authority === undefined) return undefined;
		return "retiredAt" in authority
			? authorityTombstoneForScope(authority, canonicalScope)
			: authorityRecordForScope(authority, canonicalScope);
	}
	assertOperationProject(chatId: string, projectId: string, operationId: string): void {
		assertLegacyKeyAvailable(this.authority, chatId);
		this.authority.assertOperationProject(chatId, projectId, operationId);
	}
	assertOperationProjectScoped(scope: SessionMappingScope, projectId: string, operationId: string): void {
		const canonicalScope = canonicalScopeFor(scope);
		assertScopedKeyAvailable(this.authority, canonicalScope);
		this.authority.assertOperationProject(canonicalScope.key, projectId, operationId);
	}
	beginOperation(chatId: string, operation: Omit<SessionOperation, "state" | "startedAt" | "completedAt">): void {
		assertLegacyKeyAvailable(this.authority, chatId);
		this.authority.beginOperation(chatId, operation);
	}
	beginOperationScoped(
		scope: SessionMappingScope,
		operation: Omit<SessionOperation, "state" | "startedAt" | "completedAt">,
	): void {
		const canonicalScope = canonicalScopeFor(scope);
		assertScopedKeyAvailable(this.authority, canonicalScope);
		this.authority.beginOperation(canonicalScope.key, operation);
	}
	recordAcknowledgedSuccessor(
		chatId: string,
		operationId: string,
		operationHash: string,
		successor: AcknowledgedSuccessor,
	): SessionOperation {
		assertLegacyKeyAvailable(this.authority, chatId);
		return this.authority.recordAcknowledgedSuccessor(chatId, operationId, operationHash, successor);
	}
	recordAcknowledgedSuccessorScoped(
		scope: SessionMappingScope,
		operationId: string,
		operationHash: string,
		successor: AcknowledgedSuccessor,
	): SessionOperation {
		const canonicalScope = canonicalScopeFor(scope);
		assertScopedKeyAvailable(this.authority, canonicalScope);
		return operationForScope(
			this.authority.recordAcknowledgedSuccessor(canonicalScope.key, operationId, operationHash, successor),
			canonicalScope,
		);
	}
	transitionOperation(
		chatId: string,
		operationId: string,
		state: SessionOperationState,
		detail?: string,
		result?: SessionOperationResult,
	): void {
		assertLegacyKeyAvailable(this.authority, chatId);
		this.authority.transitionOperation(chatId, operationId, state, detail, result);
	}
	transitionOperationScoped(
		scope: SessionMappingScope,
		operationId: string,
		state: SessionOperationState,
		detail?: string,
		result?: SessionOperationResult,
	): void {
		const canonicalScope = canonicalScopeFor(scope);
		assertScopedKeyAvailable(this.authority, canonicalScope);
		this.authority.transitionOperation(
			canonicalScope.key,
			operationId,
			state,
			detail,
			result === undefined ? undefined : operationResultForScope(result, canonicalScope),
		);
	}
	completeOperationWithMapping(
		chatId: string,
		operationId: string,
		detail: string,
		mapping: SessionMapping,
		kind: "turn" | "control" | "close",
		gate?: SessionOperationGateBinding,
	): SessionMapping {
		assertLegacyKeyAvailable(this.authority, chatId);
		const result = operationResult(kind, { ...mapping, operationId }, gate);
		const resultWithCloseGeneration =
			kind === "close"
				? {
						...result,
						correlation: { ...result.correlation, mappingOperationId: mapping.operationId },
					}
				: result;
		return mappingFromRecord(
			this.authority.completeOperationWithMapping(
				chatId,
				operationId,
				detail,
				authorityInputFromLegacyMapping(mapping),
				resultWithCloseGeneration,
			),
		);
	}
	completeOperationWithMappingScoped(
		scope: SessionMappingScope,
		operationId: string,
		detail: string,
		mapping: SessionMapping,
		kind: "turn" | "control" | "close",
		gate?: SessionOperationGateBinding,
	): SessionMapping {
		const canonicalScope = canonicalScopeFor(scope);
		assertScopedKeyAvailable(this.authority, canonicalScope);
		const authorityMapping = authorityInputForScope(canonicalScope, mapping);
		const result = operationResult(kind, { ...authorityMapping, operationId }, gate);
		const resultWithCloseGeneration =
			kind === "close"
				? {
						...result,
						correlation: { ...result.correlation, mappingOperationId: mapping.operationId },
					}
				: result;
		return mappingFromRecord(
			this.authority.completeOperationWithMapping(
				canonicalScope.key,
				operationId,
				detail,
				authorityMapping,
				resultWithCloseGeneration,
			),
		);
	}
	provisionalOperation(chatId: string, ingressId: string): ProvisionalSessionOperation | undefined {
		const record = this.authority.get(chatId);
		return record !== undefined && isRetiredRecord(record)
			? undefined
			: this.authority.provisionalOperation(chatId, ingressId);
	}
	provisionalOperationScoped(scope: SessionMappingScope, ingressId: string): ProvisionalSessionOperation | undefined {
		const canonicalScope = canonicalScopeFor(scope);
		const record = this.authority.get(canonicalScope.key);
		if (record !== undefined && (!isScopedRecordFor(record, canonicalScope) || isRetiredRecord(record)))
			return undefined;
		const operation = this.authority.provisionalOperation(canonicalScope.key, ingressId);
		return operation === undefined ? undefined : provisionalOperationForScope(operation, canonicalScope);
	}
	reserveProvisionalOperation(
		operation: Omit<ProvisionalSessionOperation, "state" | "startedAt" | "completedAt">,
	): ProvisionalSessionOperation {
		assertLegacyKeyAvailable(this.authority, operation.chatId);
		return this.authority.reserveProvisionalOperation(operation);
	}
	reserveProvisionalOperationScoped(
		scope: SessionMappingScope,
		operation: Omit<ProvisionalSessionOperation, "state" | "startedAt" | "completedAt">,
	): ProvisionalSessionOperation {
		const canonicalScope = canonicalScopeFor(scope);
		assertScopedKeyAvailable(this.authority, canonicalScope);
		return provisionalOperationForScope(
			this.authority.reserveProvisionalOperation(provisionalOperationInputForScope(canonicalScope, operation)),
			canonicalScope,
		);
	}
	publishProvisionalOperation(
		operation: Omit<ProvisionalSessionOperation, "state" | "startedAt" | "completedAt">,
		mapping: SessionMapping,
	): SessionMapping {
		assertLegacyKeyAvailable(this.authority, operation.chatId);
		return mappingFromRecord(
			this.authority.publishProvisionalOperation(operation, authorityInputFromLegacyMapping(mapping)),
		);
	}
	publishProvisionalOperationScoped(
		scope: SessionMappingScope,
		operation: Omit<ProvisionalSessionOperation, "state" | "startedAt" | "completedAt">,
		mapping: SessionMapping,
	): SessionMapping {
		const canonicalScope = canonicalScopeFor(scope);
		assertScopedKeyAvailable(this.authority, canonicalScope);
		return mappingFromRecord(
			this.authority.publishProvisionalOperation(
				provisionalOperationInputForScope(canonicalScope, operation),
				authorityInputForScope(canonicalScope, mapping),
			),
		);
	}
	attachProvisionalOperation(
		chatId: string,
		ingressId: string,
		attachment: Pick<ProvisionalSessionOperation, "sessionId" | "sessionFile" | "attachment">,
	): void {
		assertLegacyKeyAvailable(this.authority, chatId);
		this.authority.attachProvisionalOperation(chatId, ingressId, attachment);
	}
	attachProvisionalOperationScoped(
		scope: SessionMappingScope,
		ingressId: string,
		attachment: Pick<ProvisionalSessionOperation, "sessionId" | "sessionFile" | "attachment">,
	): void {
		const canonicalScope = canonicalScopeFor(scope);
		assertScopedKeyAvailable(this.authority, canonicalScope);
		this.authority.attachProvisionalOperation(canonicalScope.key, ingressId, attachment);
	}
	transitionProvisionalOperation(
		chatId: string,
		ingressId: string,
		state: SessionOperationState,
		detail?: string,
	): void {
		assertLegacyKeyAvailable(this.authority, chatId);
		this.authority.transitionProvisionalOperation(chatId, ingressId, state, detail);
	}
	transitionProvisionalOperationScoped(
		scope: SessionMappingScope,
		ingressId: string,
		state: SessionOperationState,
		detail?: string,
	): void {
		const canonicalScope = canonicalScopeFor(scope);
		assertScopedKeyAvailable(this.authority, canonicalScope);
		this.authority.transitionProvisionalOperation(canonicalScope.key, ingressId, state, detail);
	}
	protected mutateAuthorityState(mutation: AuthorityStateMutation): void {
		const next = mutation(this.authority.entries(), this.authority.provisionalEntries());
		(
			this.authority as unknown as {
				replaceAll: (
					records: readonly SessionAuthorityRecord[],
					provisional: readonly ProvisionalSessionOperation[],
				) => void;
			}
		).replaceAll(next.records, next.provisional);
	}
}

function canonicalScopeFor(scope: SessionMappingScope): CanonicalScope {
	if (scope === undefined || scope === null || typeof scope !== "object")
		throw new Error("Scoped session mapping requires a principal/chat scope.");
	return {
		principalId: scope.principalId,
		chatId: scope.chatId,
		key: canonicalSessionMappingKey(scope.principalId, scope.chatId),
	};
}

function assertPrincipalId(principalId: string): void {
	canonicalSessionMappingKey(principalId, "");
}

function compositeScopeFromRecord(record: SessionAuthorityRecord): SessionMappingScope | undefined {
	const observation = record.observations?.[SCOPED_MAPPING_OBSERVATION];
	if (observation === undefined) return undefined;
	if (typeof observation !== "object" || observation === null || Array.isArray(observation))
		throw new Error("Session mapping contains invalid scope metadata.");
	if (!Object.hasOwn(observation, "chatId")) return undefined;
	const principalId = (observation as StoredMappingScope).principalId;
	const chatId = (observation as StoredMappingScope).chatId;
	if (
		typeof principalId !== "string" ||
		typeof chatId !== "string" ||
		canonicalSessionMappingKey(principalId, chatId) !== record.chatId
	)
		throw new Error("Session mapping contains an invalid canonical scope key.");
	return { principalId, chatId };
}

function retirementFromRecord(record: SessionAuthorityRecord): ScopedMappingRetirement | undefined {
	const value = record.observations?.[SCOPED_MAPPING_RETIREMENT_OBSERVATION];
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Session mapping contains invalid retirement metadata.");
	const retirement = value as Partial<ScopedMappingRetirement>;
	if (
		typeof retirement.principalId !== "string" ||
		typeof retirement.chatId !== "string" ||
		typeof retirement.retiredAt !== "string" ||
		!Array.isArray(retirement.operationIds) ||
		!retirement.operationIds.every(operationId => typeof operationId === "string") ||
		!Array.isArray(retirement.provisionalOperationIds) ||
		!retirement.provisionalOperationIds.every(operationId => typeof operationId === "string") ||
		canonicalSessionMappingKey(retirement.principalId, retirement.chatId) !== record.chatId
	)
		throw new Error("Session mapping contains invalid retirement metadata.");
	return retirement as ScopedMappingRetirement;
}

function isRetiredRecord(record: SessionAuthorityRecord): boolean {
	return retirementFromRecord(record) !== undefined;
}

function assertLegacyKeyAvailable(authority: SessionAuthority, chatId: string): void {
	const record = authority.get(chatId);
	if (record !== undefined && isRetiredRecord(record))
		throw new Error(`Retired scoped session mapping ${chatId} cannot be mutated.`);
}
function isScopedRecordFor(record: SessionAuthorityRecord, scope: CanonicalScope): boolean {
	const storedScope = compositeScopeFromRecord(record);
	return storedScope?.principalId === scope.principalId && storedScope.chatId === scope.chatId;
}

function assertScopedKeyAvailable(authority: SessionAuthority, scope: CanonicalScope): void {
	const existing = authority.get(scope.key);
	if (existing === undefined) return;
	if (!isScopedRecordFor(existing, scope))
		throw new Error(`Scoped session mapping key ${scope.key} is occupied by an unscoped authority record.`);
	if (isRetiredRecord(existing)) throw new Error(`Retired scoped session mapping ${scope.key} cannot be mutated.`);
}

function authorityInputFromLegacyMapping(mapping: SessionMapping): SessionAuthorityInput {
	const copied = copySessionMapping(mapping);
	const { principalId, ...authorityMapping } = copied;
	return {
		...authorityMapping,
		...(principalId === undefined ? {} : { observations: { [SCOPED_MAPPING_OBSERVATION]: { principalId } } }),
	};
}

function authorityInputForScope(scope: CanonicalScope, mapping: SessionMapping): SessionAuthorityInput {
	const copied = copySessionMapping(mapping);
	if (copied.chatId !== scope.chatId)
		throw new Error(`Scoped session mapping chat ID ${copied.chatId} does not match scope ${scope.chatId}.`);
	if (copied.principalId !== undefined && copied.principalId !== scope.principalId)
		throw new Error(
			`Scoped session mapping principal ID ${copied.principalId} does not match scope ${scope.principalId}.`,
		);
	const { principalId: _principalId, ...authorityMapping } = { ...copied, principalId: scope.principalId };
	return {
		...authorityMapping,
		chatId: scope.key,
		observations: {
			[SCOPED_MAPPING_OBSERVATION]: {
				principalId: scope.principalId,
				chatId: scope.chatId,
			},
		},
	};
}

function provisionalOperationInputForScope(
	scope: CanonicalScope,
	operation: Omit<ProvisionalSessionOperation, "state" | "startedAt" | "completedAt">,
): Omit<ProvisionalSessionOperation, "state" | "startedAt" | "completedAt"> {
	if (operation.chatId !== scope.chatId)
		throw new Error(`Scoped session operation chat ID ${operation.chatId} does not match scope ${scope.chatId}.`);
	return { ...operation, chatId: scope.key };
}

function provisionalOperationForScope(
	operation: ProvisionalSessionOperation,
	scope: CanonicalScope,
): ProvisionalSessionOperation {
	return { ...operation, chatId: scope.chatId };
}

function operationResultForScope(result: SessionOperationResult, scope: CanonicalScope): SessionOperationResult {
	const { principalId, ...mapping } = result.mapping as SessionOperationResult["mapping"] & {
		readonly principalId?: string;
	};
	if (mapping.chatId !== scope.chatId && mapping.chatId !== scope.key)
		throw new Error(`Scoped session operation chat ID ${mapping.chatId} does not match scope ${scope.chatId}.`);
	if (principalId !== undefined && principalId !== scope.principalId)
		throw new Error(
			`Scoped session operation principal ID ${principalId} does not match scope ${scope.principalId}.`,
		);
	return {
		...result,
		mapping: {
			...mapping,
			chatId: scope.key,
		},
		...(result.correlation === undefined
			? {}
			: {
					correlation: {
						...result.correlation,
						...(result.correlation.chatId === scope.chatId ? { chatId: scope.key } : {}),
					},
				}),
	};
}

function operationForScope(operation: SessionOperation, scope: CanonicalScope): SessionOperation;
function operationForScope(
	operation: SessionOperation | undefined,
	scope: CanonicalScope,
): SessionOperation | undefined;
function operationForScope(
	operation: SessionOperation | undefined,
	scope: CanonicalScope,
): SessionOperation | undefined {
	if (operation === undefined || operation.result === undefined) return operation;
	return {
		...operation,
		result: {
			...operation.result,
			mapping: {
				...operation.result.mapping,
				...(operation.result.mapping.chatId === scope.key
					? { chatId: scope.chatId, principalId: scope.principalId }
					: {}),
			} as SessionOperationResult["mapping"],
			...(operation.result.correlation === undefined
				? {}
				: {
						correlation: {
							...operation.result.correlation,
							...(operation.result.correlation.chatId === scope.key ? { chatId: scope.chatId } : {}),
						},
					}),
		},
	};
}

function authorityRecordForScope(record: SessionAuthorityRecord, scope: CanonicalScope): SessionAuthorityRecord {
	return {
		...record,
		chatId: scope.chatId,
		header: { ...record.header, chatId: scope.chatId },
		journal: record.journal.map(operation => operationForScope(operation, scope) as SessionOperation),
		...(record.reassignment === undefined ? {} : { reassignment: reassignmentForScope(record.reassignment, scope) }),
	};
}

function reassignmentForScope(
	reassignment: SessionAuthorityReassignment,
	scope: CanonicalScope,
): SessionAuthorityReassignment {
	return {
		...reassignment,
		...(reassignment.sourceTombstone === undefined
			? {}
			: { sourceTombstone: authorityTombstoneForScope(reassignment.sourceTombstone, scope) }),
		...(reassignment.priorTombstone === undefined
			? {}
			: { priorTombstone: authorityTombstoneForScope(reassignment.priorTombstone, scope) }),
	};
}

function authorityTombstoneForScope(
	tombstone: SessionAuthorityTombstone,
	scope: CanonicalScope,
): SessionAuthorityTombstone {
	return {
		...tombstone,
		chatId: scope.chatId,
		header: { ...tombstone.header, chatId: scope.chatId },
		journal: tombstone.journal.map(operation => operationForScope(operation, scope) as SessionOperation),
		...(tombstone.prior === undefined ? {} : { prior: authorityTombstoneForScope(tombstone.prior, scope) }),
	};
}

function mappingFromRecord(record: SessionAuthorityRecord): SessionMapping {
	const storedScope = storedScopeFromRecord(record);
	const {
		version: _version,
		createdAt: _createdAt,
		header: _header,
		observations: _observations,
		journal: _journal,
		reassignment: _reassignment,
		...mapping
	} = record;
	return copySessionMapping({
		...mapping,
		chatId: storedScope?.chatId ?? mapping.chatId,
		...(storedScope === undefined ? {} : { principalId: storedScope.principalId }),
	});
}
function mappingFromRecordShallow(record: SessionAuthorityRecord): SessionMapping {
	const storedScope = storedScopeFromRecord(record);
	const {
		version: _version,
		createdAt: _createdAt,
		header: _header,
		observations: _observations,
		journal: _journal,
		reassignment: _reassignment,
		...mapping
	} = record;
	return {
		...mapping,
		// The returned mapping shares the record's event objects by reference
		// (this is the copy-free boot synthesis view), but the ARRAY itself is a
		// fresh copy so a consumer cannot push/splice onto the durable record's
		// event list without dirty tracking. The shared event objects must not be
		// mutated (documented internal contract).
		...(mapping.events === undefined ? {} : { events: [...mapping.events] }),
		chatId: storedScope?.chatId ?? mapping.chatId,
		...(storedScope === undefined ? {} : { principalId: storedScope.principalId }),
	};
}

function storedScopeFromRecord(record: SessionAuthorityRecord): SessionMappingScope | undefined {
	const observation = record.observations?.[SCOPED_MAPPING_OBSERVATION];
	if (observation === undefined) return undefined;
	if (typeof observation !== "object" || observation === null || Array.isArray(observation))
		throw new Error("Session mapping contains invalid scope metadata.");
	const principalId = (observation as StoredMappingScope).principalId;
	const chatId = (observation as StoredMappingScope).chatId;
	if (typeof principalId !== "string") throw new Error("Session mapping contains invalid scope metadata.");
	if (chatId === undefined) return { principalId, chatId: record.chatId };
	if (typeof chatId !== "string" || canonicalSessionMappingKey(principalId, chatId) !== record.chatId)
		throw new Error("Session mapping contains an invalid canonical scope key.");
	return { principalId, chatId };
}
