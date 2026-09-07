import { isDeepStrictEqual } from "node:util";
import {
	assertManagedLifecycleEvidenceUpdate,
	copyManagedLateCreateAcknowledgement,
	copyManagedLateLifecycleAcknowledgement,
	copyManagedLifecycleEvidence,
	createManagedLateCreateAcknowledgement,
	createManagedLateLifecycleAcknowledgement,
	createManagedLifecycleEvidence,
	createManagedRetirementEvidence,
	isManagedCatalogProvisional,
	isManagedEndpointReceipt,
	isManagedLateCreateAcknowledgement,
	isManagedLateLifecycleAcknowledgement,
	isManagedLifecycleEvidence,
	lifecycleExactAuthority,
	lifecyclePreparedAuthority,
	type ManagedLateCreateAcknowledgement,
	type ManagedLateLifecycleAcknowledgement,
	type ManagedLifecycleEvidence,
	managedHistoricalPublicationAssociation,
	managedLifecycleAdmissionHash,
	managedLifecycleEvidenceHash,
	managedProvisionalCreateAdmissionHash,
	requireManagedEndpointReceipt,
	transitionManagedLifecycleEvidence,
} from "./managed-lifecycle-evidence";
import {
	canonicalSessionMappingKey,
	type ProvisionalSessionOperation,
	SessionAuthority,
	type SessionAuthorityInput,
	type SessionOperation,
	type SessionOperationResult,
	type SessionOperationState,
} from "./session-authority";
import { copySessionAuthorityBinding } from "./session-authority-copy";
import type {
	AcknowledgedSuccessor,
	SessionAuthorityBinding,
	SessionAuthorityReassignment,
	SessionAuthorityRecord,
	SessionAuthorityTargetIdentity,
	SessionAuthorityTombstone,
	SessionOperationGateBinding,
} from "./session-authority-types";
import { copySessionMapping } from "./session-mapping-copy";
import type { SessionMapping, SessionMappingScope } from "./session-mapping-store";
import { operationResult } from "./session-operation-codec";
import type { ManagedPreparedTurnAuthority, ManagedTurnAuthority } from "./turn-runner";

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
		return record === undefined || record.historicalBinding !== undefined || isRetiredRecord(record)
			? undefined
			: mappingFromRecord(record);
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
		if (
			record !== undefined &&
			record.historicalBinding === undefined &&
			isScopedRecordFor(record, canonicalScope) &&
			!isRetiredRecord(record)
		)
			return mappingFromRecord(record);
		if (this.#adminPrincipalId !== undefined && scope.principalId === this.#adminPrincipalId) {
			const legacy = this.authority.get(scope.chatId);
			if (
				legacy !== undefined &&
				legacy.historicalBinding === undefined &&
				!isScopedRecordFor(legacy, canonicalScope) &&
				!isRetiredRecord(legacy)
			) {
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
			.filter(record => record.historicalBinding === undefined && !isRetiredRecord(record))
			.map(mappingFromRecord);
	}
	/**
	 * Read-only, no-copy view for boot synthesis: the same filters and scope
	 * derivation as {@link entries}, but the mapping shapes and their event
	 * arrays are shared by reference with the authority records. Callers must
	 * not mutate the returned mappings or their event payloads.
	 */
	mappingRecords(): readonly SessionMapping[] {
		return [...this.mappingRecordsIterable()];
	}
	/**
	 * Streaming no-copy view for boot synthesis: filters and projects one
	 * record at a time without materializing array views of every record.
	 * When the authority contains millions of small mappings, the previous
	 * `records()` → `filter()` → `map()` chain created three arrays plus a
	 * shallow object per record before synthesis began; this generator yields
	 * one shallow mapping at a time so peak memory is bounded by a single
	 * record.
	 */
	*mappingRecordsIterable(): Iterable<SessionMapping> {
		for (const record of this.authority.recordsIterable()) {
			if (record.historicalBinding !== undefined || isRetiredRecord(record)) continue;
			yield mappingFromRecordShallow(record);
		}
	}
	entriesForPrincipal(
		principalId: string,
		options: { readonly includeLegacyAdmin?: boolean } = {},
	): readonly SessionMapping[] {
		assertPrincipalId(principalId);
		return this.authority
			.entries()
			.filter(record => {
				if (record.historicalBinding !== undefined || isRetiredRecord(record)) return false;
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
		const record = this.authority.recordReference(chatId);
		return record === undefined || isRetiredRecord(record)
			? undefined
			: this.authority.operationStateReference(chatId, operationId);
	}
	operationStateReferenceScoped(
		scope: SessionMappingScope,
		operationId: string,
	): { readonly state: SessionOperationState; readonly resultOperationId?: string } | undefined {
		const canonicalScope = canonicalScopeFor(scope);
		const record = this.authority.recordReference(canonicalScope.key);
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
		this.authority.beginOperation(canonicalScope.key, operationInputForScope(canonicalScope, operation));
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
	discardPendingOperation(chatId: string, operation: Pick<SessionOperation, "id" | "ingressId" | "detail">): void {
		assertLegacyKeyAvailable(this.authority, chatId);
		this.authority.discardPendingOperation(chatId, operation);
	}
	discardPendingProvisionalOperation(
		chatId: string,
		operation: Pick<ProvisionalSessionOperation, "id" | "ingressId" | "detail">,
	): void {
		assertLegacyKeyAvailable(this.authority, chatId);
		this.authority.discardPendingProvisionalOperation(chatId, operation);
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
			this.authority.recordAcknowledgedSuccessor(
				canonicalScope.key,
				operationId,
				operationHash,
				successorForScope(canonicalScope, successor),
			),
			canonicalScope,
		);
	}
	discardPendingOperationScoped(
		scope: SessionMappingScope,
		operation: Pick<SessionOperation, "id" | "ingressId" | "detail">,
	): void {
		const canonicalScope = canonicalScopeFor(scope);
		assertScopedKeyAvailable(this.authority, canonicalScope);
		this.authority.discardPendingOperation(canonicalScope.key, operation);
	}
	discardPendingProvisionalOperationScoped(
		scope: SessionMappingScope,
		operation: Pick<ProvisionalSessionOperation, "id" | "ingressId" | "detail">,
	): void {
		const canonicalScope = canonicalScopeFor(scope);
		assertScopedKeyAvailable(this.authority, canonicalScope);
		this.authority.discardPendingProvisionalOperation(canonicalScope.key, operation);
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
			result === undefined
				? undefined
				: operationResultWithAuthority(
						operationResultForScope(result, canonicalScope),
						this.authority.get(canonicalScope.key)?.managedAuthority,
					),
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
		const resultWithAuthority =
			authorityMapping.managedAuthority === undefined || resultWithCloseGeneration.historicalBinding !== undefined
				? resultWithCloseGeneration
				: { ...resultWithCloseGeneration, managedAuthority: authorityMapping.managedAuthority };
		return mappingFromRecord(
			this.authority.completeOperationWithMapping(
				canonicalScope.key,
				operationId,
				detail,
				authorityMapping,
				resultWithAuthority,
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
		const candidates = this.authority
			.provisionalEntries()
			.filter(
				operation =>
					(operation.id === ingressId || operation.ingressId === ingressId) &&
					(operation.chatId === canonicalScope.key ||
						(record !== undefined && managedHistoricalPublicationAssociation(record, operation) !== undefined)),
			);
		const operation = candidates.length === 1 ? candidates[0] : undefined;
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
		attachment: Pick<ProvisionalSessionOperation, "sessionId" | "sessionFile" | "attachment" | "managedAuthority">,
	): void {
		assertLegacyKeyAvailable(this.authority, chatId);
		this.authority.attachProvisionalOperation(chatId, ingressId, attachment);
	}
	attachProvisionalOperationScoped(
		scope: SessionMappingScope,
		ingressId: string,
		attachment: Pick<ProvisionalSessionOperation, "sessionId" | "sessionFile" | "attachment" | "managedAuthority">,
	): void {
		const canonicalScope = canonicalScopeFor(scope);
		assertScopedKeyAvailable(this.authority, canonicalScope);
		this.authority.attachProvisionalOperation(canonicalScope.key, ingressId, {
			...attachment,
			...(attachment.managedAuthority === undefined
				? {}
				: { managedAuthority: managedAuthorityToScope(attachment.managedAuthority, canonicalScope) }),
		});
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
	recordLifecycleEvidence(
		chatId: string,
		operationId: string,
		payloadHash: string,
		evidence: ManagedLifecycleEvidence,
	): void {
		assertLegacyKeyAvailable(this.authority, chatId);
		this.writeLifecycleEvidence(chatId, operationId, payloadHash, evidence);
	}
	/** A catalog owner never publishes a mapping or borrows an active generation. */
	reserveManagedCatalogScoped(
		scope: SessionMappingScope,
		input: {
			readonly operationId: string;
			readonly prepared: ManagedPreparedTurnAuthority;
			readonly payloadHash: string;
		},
	): ProvisionalSessionOperation {
		const canonical = canonicalScopeFor(scope);
		const prepared = lifecyclePreparedAuthority(input.prepared);
		if (prepared.principalId !== scope.principalId || prepared.chatId !== scope.chatId || !input.operationId)
			throw new Error("Catalog reservation does not match its tenant scope.");
		const recordedAt = new Date().toISOString();
		const lifecycle = createManagedLifecycleEvidence(
			{
				operation: "session.create",
				preparedAuthority: prepared,
				payloadHash: input.payloadHash,
				target: { kind: "existing_path", path: prepared.canonicalWorkspace },
			},
			recordedAt,
		);
		const reserved: ProvisionalSessionOperation = {
			id: input.operationId,
			ingressId: input.operationId,
			kind: "create",
			purpose: "model-catalog",
			chatId: canonical.key,
			projectId: prepared.projectId,
			state: "pending",
			startedAt: recordedAt,
			detail: input.payloadHash,
			lifecycle,
		};
		this.mutateAuthorityState((records, provisional) => {
			const root = records.find(record => record.chatId === canonical.key);
			if (
				root !== undefined &&
				(root.historicalBinding !== undefined ||
					isRetiredRecord(root) ||
					!isScopedRecordFor(root, canonical) ||
					root.projectId !== prepared.projectId ||
					root.managedAuthority?.canonicalWorkspace !== prepared.canonicalWorkspace)
			)
				throw new Error("Catalog reservation conflicts with its canonical tenant owner.");
			if (provisional.some(operation => operation.chatId === canonical.key && operation.state !== "complete"))
				throw new Error("Catalog reservation conflicts with unfinished provisional work.");
			return { records, provisional: [...provisional, reserved] };
		});
		return provisionalOperationForScope(reserved, canonical);
	}
	advanceManagedCatalogScoped(
		scope: SessionMappingScope,
		admitted: ProvisionalSessionOperation,
		expectedHash: string,
		evidence: ManagedLifecycleEvidence,
	): ProvisionalSessionOperation {
		return this.mutateManagedCatalog(scope, admitted, retained => {
			if (retained.cleanup !== undefined || managedLifecycleEvidenceHash(retained.lifecycle!) !== expectedHash)
				throw new Error("Catalog create evidence changed before mutation.");
			assertManagedLifecycleEvidenceUpdate(retained.lifecycle!, evidence);
			if (isDeepStrictEqual(retained.lifecycle, evidence)) return retained;
			if (evidence.state === "invoking" && retained.state !== "pending")
				throw new Error("Catalog invocation requires pending original admission.");
			return {
				...retained,
				lifecycle: copyManagedLifecycleEvidence(evidence),
				...(evidence.state === "uncertain" ? { state: "uncertain" as const } : {}),
				...(evidence.state === "terminal_failure"
					? { state: "complete" as const, completedAt: evidence.recordedAt }
					: {}),
			};
		});
	}
	reserveManagedCatalogCleanupScoped(
		scope: SessionMappingScope,
		admitted: ProvisionalSessionOperation,
		expectedHash: string,
		input: { readonly operationId: string; readonly requestKey: string; readonly payloadHash: string },
	): ProvisionalSessionOperation {
		return this.mutateManagedCatalog(scope, admitted, retained => {
			const prior = retained.lifecycle!;
			if (
				retained.state !== "pending" ||
				retained.cleanup !== undefined ||
				retained.lateCreateAcknowledgement !== undefined ||
				managedLifecycleEvidenceHash(prior) !== expectedHash ||
				prior.acknowledged === undefined ||
				!["active_generation_proven", "acknowledged_unproven"].includes(prior.state)
			)
				throw new Error("Catalog cleanup requires this owner's original acknowledged generation.");
			const endpointReceipt = requireManagedEndpointReceipt(prior);
			const recordedAt = new Date().toISOString();
			const lifecycle =
				prior.state === "active_generation_proven"
					? transitionManagedLifecycleEvidence(prior, "closing", {}, recordedAt)
					: prior;
			const cleanup = {
				id: input.operationId,
				ingressId: input.operationId,
				kind: "close" as const,
				state: "pending" as const,
				startedAt: recordedAt,
				detail: input.payloadHash,
				lifecycle: createManagedLifecycleEvidence(
					{
						operation: "session.close",
						preparedAuthority: { ...prior.preparedAuthority, requestKey: input.requestKey },
						source: prior.acknowledged,
						payloadHash: input.payloadHash,
						target: { ...endpointReceipt },
					},
					recordedAt,
				),
			};
			return { ...retained, lifecycle, cleanup };
		});
	}
	advanceManagedCatalogCleanupScoped(
		scope: SessionMappingScope,
		admitted: ProvisionalSessionOperation,
		expectedHash: string,
		evidence: ManagedLifecycleEvidence,
	): ProvisionalSessionOperation {
		const originalChild = structuredClone(admitted.cleanup);
		return this.mutateManagedCatalog(scope, admitted, retained => {
			const child = retained.cleanup;
			if (
				child === undefined ||
				originalChild === undefined ||
				child.id !== originalChild.id ||
				child.ingressId !== originalChild.ingressId ||
				child.startedAt !== originalChild.startedAt ||
				child.detail !== originalChild.detail ||
				child.lifecycle.requestHash !== originalChild.lifecycle.requestHash ||
				!isDeepStrictEqual(child.lifecycle.preparedAuthority, originalChild.lifecycle.preparedAuthority) ||
				!isDeepStrictEqual(child.lifecycle.source, originalChild.lifecycle.source) ||
				managedLifecycleEvidenceHash(child.lifecycle) !== expectedHash
			)
				throw new Error("Catalog cleanup evidence changed before mutation.");
			assertManagedLifecycleEvidenceUpdate(child.lifecycle, evidence);
			if (isDeepStrictEqual(child.lifecycle, evidence)) return retained;
			if (evidence.state === "invoking" && (retained.state !== "pending" || child.state !== "pending"))
				throw new Error("Catalog cleanup invocation requires pending original admission.");
			if (child.state === "complete" || child.state === "conflict")
				throw new Error("Catalog cleanup evidence is immutable.");
			if (
				child.lifecycle.closeAcknowledgement === undefined &&
				evidence.closeAcknowledgement !== undefined &&
				Date.parse(evidence.closeAcknowledgement.observedAt) < Date.parse(child.lifecycle.recordedAt)
			)
				throw new Error("Catalog close acknowledgement predates its original invocation.");
			let parent = retained.lifecycle!;
			if (evidence.state === "uncertain" && parent.state !== "uncertain" && parent.state !== "cleanup_uncertain")
				parent = transitionManagedLifecycleEvidence(
					parent,
					parent.state === "acknowledged_unproven" ? "cleanup_uncertain" : "uncertain",
					{},
					evidence.recordedAt,
				);
			if (evidence.state === "retired") {
				parent = transitionManagedLifecycleEvidence(
					parent,
					"retired",
					{ retirement: evidence.retirement },
					evidence.recordedAt,
				);
			}
			const terminal = evidence.state === "retired" || evidence.state === "terminal_failure";
			return {
				...retained,
				lifecycle: parent,
				...(evidence.state === "uncertain" ? { state: "uncertain" as const } : {}),
				...(evidence.state === "retired" ? { state: "complete" as const, completedAt: evidence.recordedAt } : {}),
				cleanup: {
					...child,
					lifecycle: copyManagedLifecycleEvidence(evidence),
					...(evidence.state === "uncertain" ? { state: "uncertain" as const } : {}),
					...(terminal ? { state: "complete" as const, completedAt: evidence.recordedAt } : {}),
				},
			};
		});
	}
	private mutateManagedCatalog(
		scope: SessionMappingScope,
		admitted: ProvisionalSessionOperation,
		update: (retained: ProvisionalSessionOperation) => ProvisionalSessionOperation,
	): ProvisionalSessionOperation {
		const canonical = canonicalScopeFor(scope);
		const original = structuredClone(admitted);
		if (
			!isManagedCatalogProvisional(original) ||
			original.purpose !== "model-catalog" ||
			original.lifecycle?.preparedAuthority.principalId !== scope.principalId ||
			original.lifecycle.preparedAuthority.chatId !== scope.chatId
		)
			throw new Error("Catalog mutation lacks its original tenant owner.");
		let updated!: ProvisionalSessionOperation;
		this.mutateAuthorityState((records, provisional) => {
			const candidates = provisional.filter(
				operation => operation.chatId === canonical.key && operation.id === original.id,
			);
			const retained = candidates.length === 1 ? candidates[0] : undefined;
			if (
				retained === undefined ||
				retained.purpose !== "model-catalog" ||
				retained.startedAt !== original.startedAt ||
				retained.ingressId !== original.ingressId ||
				retained.projectId !== original.projectId ||
				retained.detail !== original.detail ||
				!isDeepStrictEqual(retained.lifecycle?.preparedAuthority, original.lifecycle!.preparedAuthority) ||
				retained.lifecycle?.requestHash !== original.lifecycle!.requestHash ||
				!isDeepStrictEqual(retained.lifecycle?.target, original.lifecycle!.target)
			)
				throw new Error("Catalog reservation changed before mutation.");
			updated = update(retained);
			if (!isManagedCatalogProvisional(updated)) throw new Error("Invalid canonical catalog mutation.");
			if (isDeepStrictEqual(updated, retained)) return { records, provisional };
			if (retained.state === "complete" || retained.state === "conflict")
				throw new Error("Catalog reservation is immutable.");
			return { records, provisional: provisional.map(operation => (operation === retained ? updated : operation)) };
		});
		return provisionalOperationForScope(structuredClone(updated), canonical);
	}
	reserveManagedRetirementScoped(
		scope: SessionMappingScope,
		source: ManagedTurnAuthority,
		input: { readonly operationId: string; readonly requestKey: string; readonly payloadHash: string },
	): SessionOperation {
		const canonical = canonicalScopeFor(scope);
		if (
			source.principalId !== scope.principalId ||
			source.chatId !== scope.chatId ||
			!input.operationId ||
			!input.requestKey
		)
			throw new Error("Managed retirement does not match the requested tenant scope.");
		let reserved!: SessionOperation;
		this.mutateAuthorityState((records, provisional) => {
			const record = records.find(candidate => candidate.chatId === canonical.key);
			const authority = managedAuthorityForScope(record?.managedAuthority, canonical);
			if (
				record === undefined ||
				isRetiredRecord(record) ||
				!isScopedRecordFor(record, canonical) ||
				authority === undefined ||
				!isDeepStrictEqual(lifecycleExactAuthority(authority), lifecycleExactAuthority(source))
			)
				throw new Error("Managed retirement source changed before reservation.");
			const existing = record.journal.find(
				operation => operation.id === input.operationId || operation.ingressId === input.operationId,
			);
			if (existing !== undefined) {
				if (
					existing.kind !== "close" ||
					existing.state !== "pending" ||
					existing.detail !== input.payloadHash ||
					existing.lifecycle?.requestKey !== input.requestKey ||
					existing.lifecycle.state !== "closing" ||
					existing.lifecycle.sourceProofRef === undefined ||
					!isManagedEndpointReceipt(existing.lifecycle.target, source) ||
					!isDeepStrictEqual(existing.lifecycle.source, lifecycleExactAuthority(source))
				)
					throw new Error("Managed retirement request conflicts with its durable reservation.");
				const reference = existing.lifecycle.sourceProofRef;
				const references = record.journal.filter(operation => operation.id === reference.operationId);
				const prior = references.length === 1 ? references[0] : undefined;
				if (
					prior === undefined ||
					prior.id === existing.id ||
					prior.state !== "complete" ||
					prior.completedAt === undefined ||
					Date.parse(prior.completedAt) > Date.parse(existing.startedAt) ||
					prior.lifecycle?.state !== "active_generation_proven" ||
					prior.lifecycle.acknowledged === undefined ||
					prior.lifecycle.proven === undefined ||
					managedLifecycleEvidenceHash(prior.lifecycle) !== reference.evidenceHash ||
					!isDeepStrictEqual(existing.lifecycle.target, requireManagedEndpointReceipt(prior.lifecycle)) ||
					![
						"principalId",
						"projectId",
						"canonicalWorkspace",
						"chatId",
						"sessionId",
						"generation",
						"leaseId",
						"epoch",
					].every(field => Reflect.get(prior.lifecycle!.acknowledged!, field) === Reflect.get(source, field))
				)
					throw new Error("Managed retirement reservation lost its original source receipt.");
				reserved = operationForScope(existing, canonical);
				return { records, provisional };
			}
			if (
				record.journal.some(
					operation =>
						operation.state === "pending" ||
						operation.state === "uncertain" ||
						(operation.kind === "close" && operation.state === "complete"),
				) ||
				provisional.some(operation => operation.chatId === canonical.key && operation.state !== "complete")
			)
				throw new Error("Managed retirement conflicts with unfinished work.");
			const sourceOperation = [...record.journal]
				.reverse()
				.find(
					operation =>
						operation.state === "complete" &&
						operation.lifecycle?.state === "active_generation_proven" &&
						operation.lifecycle.acknowledged !== undefined &&
						[
							"principalId",
							"projectId",
							"canonicalWorkspace",
							"chatId",
							"sessionId",
							"generation",
							"leaseId",
							"epoch",
						].every(
							field => Reflect.get(operation.lifecycle!.acknowledged!, field) === Reflect.get(source, field),
						),
				);
			if (sourceOperation?.lifecycle === undefined)
				throw new Error("Managed retirement requires persisted active-generation lifecycle evidence.");
			const startedAt = new Date().toISOString();
			const lifecycle = createManagedRetirementEvidence(
				{
					operation: "session.close",
					preparedAuthority: { ...lifecyclePreparedAuthority(source), requestKey: input.requestKey },
					source: lifecycleExactAuthority(source),
					sourceOperationId: sourceOperation.id,
					sourceEvidence: sourceOperation.lifecycle,
					payloadHash: input.payloadHash,
					target: { ...requireManagedEndpointReceipt(sourceOperation.lifecycle) },
				},
				startedAt,
			);
			reserved = {
				id: input.operationId,
				ingressId: input.operationId,
				kind: "close",
				state: "pending",
				startedAt,
				detail: input.payloadHash,
				lifecycle,
			};
			return {
				records: records.map(candidate =>
					candidate === record ? { ...record, journal: [...record.journal, reserved] } : candidate,
				),
				provisional,
			};
		});
		return reserved;
	}
	completeManagedRetirementScoped(
		scope: SessionMappingScope,
		source: ManagedTurnAuthority,
		operationId: string,
		evidence: Readonly<Record<string, unknown>>,
	): void {
		const canonical = canonicalScopeFor(scope);
		this.mutateAuthorityState((records, provisional) => {
			const record = records.find(candidate => candidate.chatId === canonical.key);
			const authority = managedAuthorityForScope(record?.managedAuthority, canonical);
			if (
				record === undefined ||
				isRetiredRecord(record) ||
				authority === undefined ||
				!isDeepStrictEqual(lifecycleExactAuthority(authority), lifecycleExactAuthority(source))
			)
				throw new Error("Managed retirement source changed before completion.");
			const operation = record.journal.find(candidate => candidate.id === operationId);
			const lifecycle = operation?.lifecycle;
			if (
				operation?.kind !== "close" ||
				(operation.state !== "pending" && operation.state !== "uncertain") ||
				lifecycle?.sourceProofRef === undefined ||
				lifecycle.closeAcknowledgement === undefined ||
				!isDeepStrictEqual(lifecycle.source, lifecycleExactAuthority(source))
			)
				throw new Error("Managed retirement requires durable successful close acknowledgement.");
			const completedAt = new Date().toISOString();
			const retired = transitionManagedLifecycleEvidence(
				lifecycle,
				"retired",
				{
					retirement: {
						sessionId: source.sessionId,
						generation: source.generation,
						acknowledgedSessionId: lifecycle.closeAcknowledgement.sessionId,
						observedAt: completedAt,
						evidence,
					},
				},
				completedAt,
			);
			const result: SessionOperationResult = {
				kind: "close",
				assistantText: "",
				events: [],
				managedAuthority: record.managedAuthority,
				mapping: {
					chatId: canonical.key,
					projectId: record.projectId,
					sessionId: record.sessionId,
					rawFrameCursor: record.rawFrameCursor,
					eventCursor: record.eventCursor,
					operationId,
				},
				correlation: { closeStatus: "closed", mappingOperationId: record.operationId },
			};
			const completed: SessionOperation = {
				...operation,
				state: "complete",
				completedAt,
				lifecycle: retired,
				result,
			};
			return {
				records: records.map(candidate =>
					candidate === record
						? {
								...record,
								journal: record.journal.map(entry => (entry === operation ? completed : entry)),
							}
						: candidate,
				),
				provisional,
			};
		});
	}
	lifecycleOperationsScoped(scope: SessionMappingScope): readonly SessionOperation[] {
		const canonical = canonicalScopeFor(scope);
		assertScopedKeyAvailable(this.authority, canonical);
		const operations = [
			...this.operationsScoped(scope),
			...this.authority
				.provisionalEntries()
				.filter(operation => operation.chatId === canonical.key)
				.map(operation => provisionalOperationForScope(operation, canonical)),
		];
		return operations.filter(
			operation =>
				operation.lifecycle !== undefined &&
				operation.lifecycle.preparedAuthority.principalId === scope.principalId &&
				operation.lifecycle.preparedAuthority.chatId === scope.chatId,
		);
	}
	recordLifecycleEvidenceScoped(
		scope: SessionMappingScope,
		operationId: string,
		payloadHash: string,
		evidence: ManagedLifecycleEvidence,
	): void {
		const canonical = canonicalScopeFor(scope);
		assertScopedKeyAvailable(this.authority, canonical);
		if (
			evidence.preparedAuthority.principalId !== scope.principalId ||
			evidence.preparedAuthority.chatId !== scope.chatId
		)
			throw new Error("Managed lifecycle evidence does not match the requested tenant scope.");
		this.writeLifecycleEvidence(canonical.key, operationId, payloadHash, evidence);
	}
	recordLateCreateAcknowledgement(
		chatId: string,
		admitted: ProvisionalSessionOperation,
		observation: ManagedLateCreateAcknowledgement,
	): void {
		const principalId = admitted.lifecycle?.preparedAuthority.principalId;
		if (principalId === undefined) throw new Error("Late create observation lacks an admitted owner.");
		this.recordLateCreateAcknowledgementScoped({ principalId, chatId }, admitted, observation);
	}
	recordLateCreateAcknowledgementScoped(
		scope: SessionMappingScope,
		admitted: ProvisionalSessionOperation,
		observation: ManagedLateCreateAcknowledgement,
	): void {
		const canonical = canonicalScopeFor(scope);
		const admissionHash = managedProvisionalCreateAdmissionHash(admitted);
		const prepared = admitted.lifecycle!.preparedAuthority;
		if (prepared.principalId !== scope.principalId || prepared.chatId !== scope.chatId)
			throw new Error("Late create observation does not match its admitted owner.");
		const validated = createManagedLateCreateAcknowledgement(
			admitted,
			{ ...prepared, ...observation.acknowledged },
			observation.observedAt,
			observation.endpointReceipt,
		);
		if (!isDeepStrictEqual(validated, observation))
			throw new Error("Late create observation does not match its original invocation.");
		this.mutateAuthorityState((records, provisional) => {
			const root = records.find(record => record.chatId === canonical.key);
			if (
				root !== undefined &&
				(root.historicalBinding !== undefined ||
					root.projectId !== prepared.projectId ||
					!isScopedRecordFor(root, canonical))
			)
				throw new Error("Late create observation owner conflicts with the current mapping.");
			const candidates = provisional.filter(
				operation =>
					operation.chatId === canonical.key &&
					(operation.id === admitted.id || operation.ingressId === (admitted.ingressId ?? admitted.id)),
			);
			if (candidates.length !== 1)
				throw new Error("Late create observation requires one retained provisional reservation.");
			const retained = candidates[0]!;
			if (
				managedProvisionalCreateAdmissionHash(retained) !== admissionHash ||
				!isManagedLateCreateAcknowledgement(observation, retained)
			)
				throw new Error("Late create observation conflicts with its retained reservation.");
			if (retained.lateCreateAcknowledgement !== undefined) {
				if (!isDeepStrictEqual(retained.lateCreateAcknowledgement, observation))
					throw new Error("Late create observation is immutable.");
				return { records, provisional };
			}
			return {
				records,
				provisional: provisional.map(operation =>
					operation === retained
						? {
								...operation,
								lateCreateAcknowledgement: copyManagedLateCreateAcknowledgement(observation),
							}
						: operation,
				),
			};
		});
	}
	recordLateLifecycleAcknowledgement(
		chatId: string,
		admitted: SessionOperation,
		observation: ManagedLateLifecycleAcknowledgement,
	): void {
		const principalId = admitted.lifecycle?.preparedAuthority.principalId;
		if (principalId === undefined) throw new Error("Late lifecycle observation lacks an admitted owner.");
		this.recordLateLifecycleAcknowledgementScoped({ principalId, chatId }, admitted, observation);
	}
	recordLateLifecycleAcknowledgementScoped(
		scope: SessionMappingScope,
		admitted: SessionOperation,
		observation: ManagedLateLifecycleAcknowledgement,
	): void {
		const canonical = canonicalScopeFor(scope);
		const admissionHash = managedLifecycleAdmissionHash(admitted);
		const prepared = admitted.lifecycle!.preparedAuthority;
		if (
			admitted.state !== "pending" ||
			admitted.lifecycle!.state !== "invoking" ||
			admitted.lifecycle!.acknowledged !== undefined ||
			admitted.lifecycle!.proven !== undefined ||
			admitted.lateLifecycleAcknowledgement !== undefined ||
			prepared.principalId !== scope.principalId ||
			prepared.chatId !== scope.chatId ||
			observation.admissionHash !== admissionHash
		)
			throw new Error("Late lifecycle observation does not match its admitted owner.");
		const validated = createManagedLateLifecycleAcknowledgement(
			admitted,
			{ ...prepared, ...observation.acknowledged },
			observation.observedAt,
			observation.endpointReceipt,
		);
		if (!isDeepStrictEqual(validated, observation))
			throw new Error("Late lifecycle observation does not match its original invocation.");
		this.mutateAuthorityState((records, provisional) => {
			const root = records.find(record => record.chatId === canonical.key);
			if (root === undefined || !isScopedRecordFor(root, canonical) || root.historicalBinding !== undefined)
				throw new Error("Late lifecycle observation owner is unavailable.");
			let matches = 0;
			let changed = false;
			const update = <T extends SessionAuthorityRecord | SessionAuthorityTombstone>(owner: T): T => {
				const journal = owner.journal.map(operation => {
					if (operation.id !== admitted.id && operation.ingressId !== (admitted.ingressId ?? admitted.id))
						return operation;
					matches += 1;
					if (
						owner.historicalBinding !== undefined ||
						owner.projectId !== prepared.projectId ||
						managedLifecycleAdmissionHash(operation) !== admissionHash ||
						!isManagedLateLifecycleAcknowledgement(observation, operation)
					)
						throw new Error("Late lifecycle observation conflicts with its retained reservation.");
					if (operation.lateLifecycleAcknowledgement !== undefined) {
						if (!isDeepStrictEqual(operation.lateLifecycleAcknowledgement, observation))
							throw new Error("Late lifecycle observation is immutable.");
						return operation;
					}
					changed = true;
					return {
						...operation,
						lateLifecycleAcknowledgement: copyManagedLateLifecycleAcknowledgement(observation),
					};
				});
				if ("prior" in owner)
					return { ...owner, journal, ...(owner.prior === undefined ? {} : { prior: update(owner.prior) }) };
				const reassignment = "reassignment" in owner ? owner.reassignment : undefined;
				const sourceTombstone =
					reassignment?.sourceTombstone === undefined ? undefined : update(reassignment.sourceTombstone);
				const priorTombstone =
					reassignment?.priorTombstone === undefined
						? undefined
						: reassignment.sourceTombstone !== undefined &&
								isDeepStrictEqual(reassignment.priorTombstone, reassignment.sourceTombstone.prior)
							? sourceTombstone!.prior
							: update(reassignment.priorTombstone);
				return {
					...owner,
					journal,
					...(reassignment === undefined
						? {}
						: {
								reassignment: {
									...reassignment,
									...(sourceTombstone === undefined ? {} : { sourceTombstone }),
									...(priorTombstone === undefined ? {} : { priorTombstone }),
								},
							}),
				};
			};
			const updated = update(root);
			if (
				matches !== 1 ||
				provisional.some(
					operation =>
						operation.chatId === canonical.key &&
						(operation.id === admitted.id || operation.ingressId === (admitted.ingressId ?? admitted.id)),
				)
			)
				throw new Error("Late lifecycle observation requires one retained reservation.");
			return changed
				? { records: records.map(record => (record === root ? updated : record)), provisional }
				: { records, provisional };
		});
	}
	private writeLifecycleEvidence(
		chatId: string,
		operationId: string,
		payloadHash: string,
		evidence: ManagedLifecycleEvidence,
	): void {
		if (!isManagedLifecycleEvidence(evidence) || evidence.payloadHash !== payloadHash)
			throw new Error("Invalid managed lifecycle evidence or payload hash.");
		this.mutateAuthorityState((records, provisional) => {
			if (evidence.sourceProofRef !== undefined) {
				const record = records.find(candidate => candidate.chatId === chatId);
				const source = evidence.source;
				const authority = record?.managedAuthority;
				if (
					source === undefined ||
					authority === undefined ||
					record === undefined ||
					isRetiredRecord(record) ||
					!isDeepStrictEqual(lifecycleExactAuthority({ ...authority, chatId: source.chatId }), source)
				)
					throw new Error("Managed retirement source changed before evidence persistence.");
			}
			let found = false;
			const update = <T extends SessionOperation>(operation: T): T => {
				if (operation.id !== operationId && operation.ingressId !== operationId) return operation;
				if ("purpose" in operation && operation.purpose !== undefined)
					throw new Error("Catalog lifecycle evidence requires its original operation-scoped owner.");
				if (
					found ||
					operation.state === "complete" ||
					operation.state === "conflict" ||
					operation.detail !== payloadHash
				)
					throw new Error("Managed lifecycle operation has an immutable or conflicting result binding.");
				if (operation.lifecycle === undefined) {
					if (evidence.state !== "intent_prepared")
						throw new Error("Managed lifecycle must begin with prepared intent.");
				} else assertManagedLifecycleEvidenceUpdate(operation.lifecycle, evidence);
				found = true;
				return { ...operation, lifecycle: copyManagedLifecycleEvidence(evidence) };
			};
			const nextRecords = records.map(record =>
				record.chatId !== chatId
					? record
					: {
							...record,
							journal: record.journal.map(update),
						},
			);
			const nextProvisional = provisional.map(operation =>
				operation.chatId === chatId ? update(operation) : operation,
			);
			if (!found) throw new Error("Managed lifecycle operation must be durably reserved before evidence.");
			return { records: nextRecords, provisional: nextProvisional };
		});
	}
	protected mutateAuthorityState(mutation: AuthorityStateMutation): void {
		const records = this.authority.entries(),
			provisional = this.authority.provisionalEntries();
		const next = mutation(records, provisional);
		if (next.records === records && next.provisional === provisional) return;
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
	if (
		observation === undefined ||
		(record.managedAuthority !== undefined &&
			typeof observation === "object" &&
			observation !== null &&
			!Array.isArray(observation) &&
			!Object.hasOwn(observation, "chatId") &&
			Reflect.get(observation, "principalId") === record.managedAuthority.principalId)
	) {
		const principalId = record.historicalBinding?.principalId ?? record.managedAuthority?.principalId;
		if (principalId === undefined) return undefined;
		let key: unknown;
		try {
			key = JSON.parse(record.chatId);
		} catch {
			return undefined;
		}
		if (
			!Array.isArray(key) ||
			key.length !== 2 ||
			key[0] !== principalId ||
			typeof key[1] !== "string" ||
			canonicalSessionMappingKey(principalId, key[1]) !== record.chatId
		)
			return undefined;
		return { principalId, chatId: key[1] };
	}
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
		...(authorityMapping.managedAuthority === undefined
			? {}
			: { managedAuthority: managedAuthorityToScope(authorityMapping.managedAuthority, scope) }),
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
	return {
		...operationInputForScope(scope, operation),
		chatId: scope.key,
		projectId: operation.projectId,
		sessionId: operation.sessionId,
		...(operation.managedAuthority === undefined
			? {}
			: { managedAuthority: managedAuthorityToScope(operation.managedAuthority, scope) }),
	};
}

function operationInputForScope(
	scope: CanonicalScope,
	operation: Omit<SessionOperation, "state" | "startedAt" | "completedAt">,
): Omit<SessionOperation, "state" | "startedAt" | "completedAt"> {
	return {
		...operation,
		...(operation.acknowledgedSuccessor === undefined
			? {}
			: { acknowledgedSuccessor: successorForScope(scope, operation.acknowledgedSuccessor) }),
		...(operation.result === undefined ? {} : { result: operationResultForScope(operation.result, scope) }),
	};
}

function successorForScope(scope: CanonicalScope, successor: AcknowledgedSuccessor): AcknowledgedSuccessor {
	if ("attachment" in successor) return successor;
	return { sessionId: successor.sessionId, ...bindingForScope(successor, scope, true) } as AcknowledgedSuccessor;
}

function provisionalOperationForScope(
	operation: ProvisionalSessionOperation,
	scope: CanonicalScope,
): ProvisionalSessionOperation {
	if (operation.historicalBinding !== undefined) {
		bindingForScope(operation, scope, false);
		return structuredClone(operation);
	}
	const { managedAuthority: _managed, historicalBinding: _history, ...rest } = operation;
	return {
		...rest,
		...operationForScope(operation, scope),
		chatId: scope.chatId,
		projectId: operation.projectId,
		sessionId: operation.sessionId,
		...bindingForScope(operation, scope, false),
	};
}

function operationResultForScope(result: SessionOperationResult, scope: CanonicalScope): SessionOperationResult {
	if (result.historicalBinding !== undefined) {
		bindingForScope(result, scope, true);
		return structuredClone(result);
	}
	const { managedAuthority: _managed, historicalBinding: _history, ...rest } = result;
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
		...rest,
		...bindingForScope(result, scope, true),
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

function operationResultWithAuthority(
	result: SessionOperationResult,
	authority: ManagedTurnAuthority | undefined,
): SessionOperationResult {
	if (result.historicalBinding !== undefined) return result;
	return result.managedAuthority === undefined && authority === undefined
		? result
		: {
				...result,
				...(result.managedAuthority === undefined
					? authority === undefined
						? {}
						: { managedAuthority: authority }
					: {}),
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
	if (operation === undefined) return undefined;
	const result = operation.result;
	const copiedResult = result === undefined ? undefined : resultForLogicalScope(result, scope);
	return {
		...operation,
		...(operation.acknowledgedSuccessor === undefined
			? {}
			: {
					acknowledgedSuccessor: logicalSuccessor(operation.acknowledgedSuccessor, scope),
				}),
		...(copiedResult === undefined ? {} : { result: copiedResult }),
	};
}

function resultForLogicalScope(result: SessionOperationResult, scope: CanonicalScope): SessionOperationResult {
	if (result.historicalBinding !== undefined) {
		bindingForScope(result, scope, false);
		return structuredClone(result);
	}
	const { managedAuthority: _managed, historicalBinding: _history, ...rest } = result;
	return {
		...rest,
		...bindingForScope(result, scope, false),
		mapping: {
			...result.mapping,
			...(result.mapping.chatId === scope.key ? { chatId: scope.chatId, principalId: scope.principalId } : {}),
		},
		...(result.correlation === undefined
			? {}
			: {
					correlation: {
						...result.correlation,
						...(result.correlation.chatId === scope.key ? { chatId: scope.chatId } : {}),
					},
				}),
	};
}

function logicalSuccessor(successor: AcknowledgedSuccessor, scope: CanonicalScope): AcknowledgedSuccessor {
	if ("attachment" in successor) return successor;
	return { sessionId: successor.sessionId, ...bindingForScope(successor, scope, false) } as AcknowledgedSuccessor;
}

function bindingForScope(
	binding: SessionAuthorityBinding,
	scope: CanonicalScope,
	stored: boolean,
): SessionAuthorityBinding {
	const copied = copySessionAuthorityBinding(binding);
	if (copied.historicalBinding !== undefined) {
		const history = copied.historicalBinding;
		if (history.principalId !== undefined && history.principalId !== scope.principalId)
			throw new Error("Historical authority principal does not match the requested scope.");
		if (history.chatId !== scope.chatId && history.chatId !== scope.key)
			throw new Error("Historical authority chat does not match the requested scope.");
		return copied;
	}
	if (copied.managedAuthority === undefined) return copied;
	return {
		managedAuthority: stored
			? managedAuthorityToScope(copied.managedAuthority, scope)
			: managedAuthorityForScope(copied.managedAuthority, scope),
	};
}

function authorityRecordForScope(record: SessionAuthorityRecord, scope: CanonicalScope): SessionAuthorityRecord {
	if (record.historicalBinding !== undefined) {
		bindingForScope(record, scope, false);
		return structuredClone(record);
	}
	const { managedAuthority: _managed, historicalBinding: _history, ...rest } = record;
	return {
		...rest,
		chatId: scope.chatId,
		header: { ...record.header, chatId: scope.chatId },
		...bindingForScope(record, scope, false),
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
	if (tombstone.historicalBinding !== undefined) {
		bindingForScope(tombstone, scope, false);
		return structuredClone(tombstone);
	}
	const { managedAuthority: _managed, historicalBinding: _history, ...rest } = tombstone;
	return {
		...rest,
		chatId: scope.chatId,
		header: { ...tombstone.header, chatId: scope.chatId },
		...bindingForScope(tombstone, scope, false),
		journal: tombstone.journal.map(operation => operationForScope(operation, scope) as SessionOperation),
		...(tombstone.prior === undefined ? {} : { prior: authorityTombstoneForScope(tombstone.prior, scope) }),
	};
}

function managedAuthorityForScope(authority: ManagedTurnAuthority, scope: CanonicalScope): ManagedTurnAuthority;
function managedAuthorityForScope(
	authority: ManagedTurnAuthority | undefined,
	scope: CanonicalScope,
): ManagedTurnAuthority | undefined;
function managedAuthorityForScope(
	authority: ManagedTurnAuthority | undefined,
	scope: CanonicalScope,
): ManagedTurnAuthority | undefined {
	if (authority === undefined || authority.chatId !== scope.key) return authority;
	return { ...authority, chatId: scope.chatId };
}

function managedAuthorityToScope(authority: ManagedTurnAuthority, scope: CanonicalScope): ManagedTurnAuthority {
	if (authority.principalId !== scope.principalId)
		throw new Error("Managed session authority principal does not match the requested scope.");
	if (authority.chatId !== scope.chatId && authority.chatId !== scope.key)
		throw new Error("Managed session authority chat does not match the requested scope.");
	return authority.chatId === scope.key ? authority : { ...authority, chatId: scope.key };
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
		...(storedScope === undefined || record.managedAuthority === undefined
			? {}
			: { managedAuthority: managedAuthorityForScope(record.managedAuthority, canonicalScopeFor(storedScope)) }),
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
		// The returned mapping shares the record's readonly event array by
		// reference (copy-free boot synthesis): the array and its objects are
		// both readonly-typed, so a consumer cannot push/splice onto the
		// durable record's event list. Cloning the array would allocate a
		// second array proportional to an oversized authority.
		...(mapping.events === undefined ? {} : { events: mapping.events }),
		chatId: storedScope?.chatId ?? mapping.chatId,
		...(storedScope === undefined ? {} : { principalId: storedScope.principalId }),
		...(storedScope === undefined || record.managedAuthority === undefined
			? {}
			: { managedAuthority: managedAuthorityForScope(record.managedAuthority, canonicalScopeFor(storedScope)) }),
	};
}

function storedScopeFromRecord(record: SessionAuthorityRecord): SessionMappingScope | undefined {
	const observation = record.observations?.[SCOPED_MAPPING_OBSERVATION];
	if (observation === undefined) return compositeScopeFromRecord(record);
	if (typeof observation !== "object" || observation === null || Array.isArray(observation))
		throw new Error("Session mapping contains invalid scope metadata.");
	const principalId = (observation as StoredMappingScope).principalId;
	const chatId = (observation as StoredMappingScope).chatId;
	if (typeof principalId !== "string") throw new Error("Session mapping contains invalid scope metadata.");
	if (chatId === undefined) return compositeScopeFromRecord(record) ?? { principalId, chatId: record.chatId };
	if (typeof chatId !== "string" || canonicalSessionMappingKey(principalId, chatId) !== record.chatId)
		throw new Error("Session mapping contains an invalid canonical scope key.");
	return { principalId, chatId };
}
