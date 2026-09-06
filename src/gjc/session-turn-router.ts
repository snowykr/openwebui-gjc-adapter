import { resolve } from "node:path";
import type { SessionOperationResult } from "./session-authority";
import { SESSION_AUTHORITY_V3_EPOCH } from "./session-authority-v3";
import type { SessionMapping, SessionMappingScope, SessionMappingStore } from "./session-mapping-store";
import { hashTurnIngress, normalizeModelSelection } from "./session-operation-codec";
import type { RouteGjcTurnInput, RouteGjcTurnResult } from "./session-turn-router-contract";
import { startNewMappedSession } from "./session-turn-router-new";
import {
	GjcTurnCancelledError,
	type GjcTurnRunner,
	getProjectSessionRoot,
	type ManagedGenerationProof,
	type ManagedTurnAuthority,
} from "./turn-runner";

export interface ScopedRouteGjcTurnInput extends RouteGjcTurnInput {
	readonly principalId?: string;
}

const scopedStoreCache = new WeakMap<object, Map<string, SessionMappingStore>>();

export function scopedSessionMappingStore(
	mappings: SessionMappingStore,
	principalId: string,
	chatId: string,
): SessionMappingStore {
	const key = JSON.stringify([principalId, chatId]);
	let byScope = scopedStoreCache.get(mappings);
	if (byScope === undefined) {
		byScope = new Map();
		scopedStoreCache.set(mappings, byScope);
	}
	const cached = byScope.get(key);
	if (cached !== undefined) return cached;
	const scope: SessionMappingScope = { principalId, chatId };
	const requireChat = (actual: string): void => {
		if (actual !== chatId)
			throw new Error(`Scoped session mapping chat ID ${actual} does not match scope ${chatId}.`);
	};
	const withPrincipal = (mapping: SessionMapping): SessionMapping =>
		mapping.principalId === undefined ? { ...mapping, principalId } : mapping;
	const methods = {
		get: (actual: string) => {
			requireChat(actual);
			return mappings.getScoped(scope);
		},
		set: (mapping: SessionMapping) => mappings.setScoped(scope, withPrincipal(mapping)),
		upsert: (mapping: SessionMapping) => mappings.upsertScoped(scope, withPrincipal(mapping)),
		beginProjectReassignment: (
			actual: string,
			currentProjectId: string,
			nextProjectId: string,
			target?: Parameters<SessionMappingStore["beginProjectReassignmentScoped"]>[3],
		) => {
			requireChat(actual);
			mappings.beginProjectReassignmentScoped(scope, currentProjectId, nextProjectId, target);
		},
		rollbackProjectReassignment: (actual: string, currentProjectId: string) => {
			requireChat(actual);
			mappings.rollbackProjectReassignmentScoped(scope, currentProjectId);
		},
		reassignProjectAuthority: (actual: string, currentProjectId: string, nextProjectId: string) => {
			requireChat(actual);
			mappings.reassignProjectAuthorityScoped(scope, currentProjectId, nextProjectId);
		},
		entries: () => mappings.entriesScoped(scope),
		operation: (actual: string, operationId: string) => {
			requireChat(actual);
			return mappings.operationScoped(scope, operationId);
		},
		operations: (actual: string) => {
			requireChat(actual);
			return mappings.operationsScoped(scope);
		},
		operationAuthority: (actual: string, operationId: string) => {
			requireChat(actual);
			return mappings.operationAuthorityScoped(scope, operationId);
		},
		assertOperationProject: (actual: string, projectId: string, operationId: string) => {
			requireChat(actual);
			mappings.assertOperationProjectScoped(scope, projectId, operationId);
		},
		beginOperation: (actual: string, operation: Parameters<SessionMappingStore["beginOperation"]>[1]) => {
			requireChat(actual);
			mappings.beginOperationScoped(scope, operation);
		},
		recordAcknowledgedSuccessor: (
			actual: string,
			operationId: string,
			operationHash: string,
			successor: Parameters<SessionMappingStore["recordAcknowledgedSuccessor"]>[3],
		) => {
			requireChat(actual);
			return mappings.recordAcknowledgedSuccessorScoped(scope, operationId, operationHash, successor);
		},
		discardPendingOperation: (
			actual: string,
			operation: Parameters<SessionMappingStore["discardPendingOperation"]>[1],
		) => {
			requireChat(actual);
			mappings.discardPendingOperationScoped(scope, operation);
		},
		discardPendingProvisionalOperation: (
			actual: string,
			operation: Parameters<SessionMappingStore["discardPendingProvisionalOperation"]>[1],
		) => {
			requireChat(actual);
			mappings.discardPendingProvisionalOperationScoped(scope, operation);
		},
		transitionOperation: (
			actual: string,
			operationId: string,
			state: Parameters<SessionMappingStore["transitionOperation"]>[2],
			detail?: string,
			result?: Parameters<SessionMappingStore["transitionOperation"]>[4],
		) => {
			requireChat(actual);
			mappings.transitionOperationScoped(scope, operationId, state, detail, result);
		},
		completeOperationWithMapping: (
			actual: string,
			operationId: string,
			detail: string,
			mapping: SessionMapping,
			kind: Parameters<SessionMappingStore["completeOperationWithMapping"]>[4],
			gate?: Parameters<SessionMappingStore["completeOperationWithMapping"]>[5],
		) => {
			requireChat(actual);
			return mappings.completeOperationWithMappingScoped(
				scope,
				operationId,
				detail,
				withPrincipal(mapping),
				kind,
				gate,
			);
		},
		provisionalOperation: (actual: string, ingressId: string) => {
			requireChat(actual);
			return mappings.provisionalOperationScoped(scope, ingressId);
		},
		recordLifecycleEvidence: (
			actual: string,
			operationId: string,
			payloadHash: string,
			evidence: Parameters<SessionMappingStore["recordLifecycleEvidence"]>[3],
		) => {
			requireChat(actual);
			mappings.recordLifecycleEvidenceScoped(scope, operationId, payloadHash, evidence);
		},
		reserveProvisionalOperation: (operation: Parameters<SessionMappingStore["reserveProvisionalOperation"]>[0]) =>
			mappings.reserveProvisionalOperationScoped(scope, operation),
		publishProvisionalOperation: (
			operation: Parameters<SessionMappingStore["publishProvisionalOperation"]>[0],
			mapping: SessionMapping,
		) => mappings.publishProvisionalOperationScoped(scope, operation, withPrincipal(mapping)),
		attachProvisionalOperation: (
			actual: string,
			ingressId: string,
			attachment: Parameters<SessionMappingStore["attachProvisionalOperation"]>[2],
		) => {
			requireChat(actual);
			mappings.attachProvisionalOperationScoped(scope, ingressId, attachment);
		},
		transitionProvisionalOperation: (
			actual: string,
			ingressId: string,
			state: Parameters<SessionMappingStore["transitionProvisionalOperation"]>[2],
			detail?: string,
		) => {
			requireChat(actual);
			mappings.transitionProvisionalOperationScoped(scope, ingressId, state, detail);
		},
	};
	const scoped = new Proxy(mappings, {
		get(target, property, receiver) {
			const method = methods[property as keyof typeof methods];
			return method === undefined ? Reflect.get(target, property, receiver) : method;
		},
	});
	byScope.set(key, scoped);
	return scoped;
}

export async function routeGjcTurn(input: ScopedRouteGjcTurnInput): Promise<RouteGjcTurnResult> {
	throwIfAborted(input.signal);
	if (typeof input.principalId !== "string" || input.principalId.trim().length === 0)
		throw new Error("Managed GJC routing requires an explicit principal.");
	const mappings = scopedSessionMappingStore(input.mappings, input.principalId, input.chatId);
	const scopedInput = mappings === input.mappings ? input : { ...input, mappings };
	const initialMapping = mappings.get(input.chatId);
	const authority =
		initialMapping?.projectId === input.project.id ? continuationAuthorityFor(input, initialMapping) : undefined;
	const cancellation = {
		projectId: input.project.id,
		chatId: input.chatId,
		operationId: input.userMessageId,
		...(input.principalId === undefined ? {} : { principalId: input.principalId }),
		...(authority === undefined ? {} : { managedAuthority: authority }),
		...(initialMapping?.projectId === input.project.id ? { sessionId: initialMapping.sessionId } : {}),
	};
	let cancellationRequested = false;
	const onAbort = () => {
		if (cancellationRequested) return;
		cancellationRequested = true;
		void Promise.resolve(input.runner.cancelTurn?.(cancellation)).catch(() => undefined);
	};
	input.signal?.addEventListener("abort", onAbort, { once: true });
	if (input.signal?.aborted) onAbort();
	try {
		throwIfAborted(input.signal);
		const existing = mappings.get(input.chatId);
		const operationHash = hashTurnIngress({
			chatId: input.chatId,
			projectId: input.project.id,
			parentId: input.parentId,
			text: input.text,
			...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
		});
		const priorOperation = existing === undefined ? undefined : mappings.operation(input.chatId, input.userMessageId);
		if (priorOperation?.state === "complete") {
			if (priorOperation.detail !== operationHash)
				throw new Error(`GJC operation ${input.userMessageId} conflicts with a different ingress payload.`);
			const replayed = replayOperation(input.userMessageId, priorOperation.result);
			// The immutable journal result carries replay text and events. Only the
			// current mapping may re-enqueue projection rows; superseded operations
			// return their original result without reviving obsolete projections.
			if (replayed.mapping.projectId !== input.project.id || replayed.mapping.chatId !== input.chatId)
				throw new Error(`GJC operation ${input.userMessageId} is not authorized for this project and chat.`);
			const sessionRoot = getProjectSessionRoot(input.project);
			return await withLifecyclePublication(
				input.runner,
				{
					cwd: input.project.cwd,
					sessionRoot,
					projectId: replayed.mapping.projectId,
					chatId: replayed.mapping.chatId,
					sessionId: replayed.mapping.sessionId,
				},
				async () => {
					throwIfAborted(input.signal);
					const currentMapping = mappings.get(input.chatId);
					const isCurrentReplay =
						currentMapping !== undefined && currentMapping.operationId === input.userMessageId;
					const replayMapping = isCurrentReplay ? currentMapping : replayed.mapping;
					if (isCurrentReplay) input.afterPublish?.({ ...replayed, mapping: replayMapping });
					throwIfAborted(input.signal);
					return { ...replayed, mapping: replayMapping };
				},
			);
		}
		if (priorOperation?.state === "pending") {
			throw new Error(`GJC operation ${input.userMessageId} is pending and cannot be replayed.`);
		}
		if (priorOperation?.state === "uncertain" || priorOperation?.state === "conflict") {
			throw new Error(`GJC operation ${input.userMessageId} requires reconciliation.`);
		}

		const provisional = mappings.provisionalOperation(input.chatId, input.userMessageId);
		if (provisional !== undefined) {
			if (provisional.detail !== operationHash)
				throw new Error(`GJC operation ${input.userMessageId} conflicts with a different ingress payload.`);
			throw new Error(`GJC operation ${input.userMessageId} requires reconciliation.`);
		}
		if (existing === undefined || existing.projectId !== input.project.id) {
			return await startNewMappedSession(scopedInput);
		}

		if (authority === undefined) throw new Error("Managed continuation requires persisted authority.");
		const sessionRoot = getProjectSessionRoot(input.project);
		const address = {
			cwd: input.project.cwd,
			sessionRoot,
			projectId: input.project.id,
			sessionId: existing.sessionId,
			chatId: input.chatId,
		};
		return await withLifecyclePublication(input.runner, address, async lifecycle => {
			throwIfAborted(input.signal);
			if (lifecycle.publishManaged === undefined)
				throw new Error("Lifecycle transaction cannot publish managed generation authority.");
			const operation = beginDurableOperation(scopedInput, mappings);
			let promptDispatched = false;
			try {
				const state = await input.runner.getState({
					...address,
					lifecycle,
					managedAuthority: { ...authority },
				});
				throwIfAborted(input.signal);
				assertManagedProof(state.managedProof, authority);
				if (state.managedAuthority !== undefined) assertSameManagedAuthority(state.managedAuthority, authority);
				const result = await input.runner.continueSession({
					...address,
					userMessageId: input.userMessageId,
					parentId: input.parentId,
					text: input.text,
					rawFrameCursor: state.rawFrameCursor,
					eventCursor: state.eventCursor,
					operationId: input.userMessageId,
					lifecycle,
					...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
					...(input.onObservedTurn === undefined ? {} : { observer: input.onObservedTurn }),
					...(input.signal === undefined ? {} : { signal: input.signal }),
					...(input.principalId === undefined ? {} : { principalId: input.principalId }),
					managedAuthority: { ...authority },
					onDispatch: () => {
						promptDispatched = true;
					},
				});
				throwIfAborted(input.signal);
				const completedSelection =
					input.modelSelection === undefined ? undefined : normalizeModelSelection(result.modelSelection);
				if (input.modelSelection !== undefined && completedSelection === undefined)
					throw new TypeError("Missing selected GJC outcome");
				const proof = result.managedProof;
				assertManagedProof(proof, authority);
				if (result.managedAuthority !== undefined) assertSameManagedAuthority(result.managedAuthority, authority);
				const assistantText = input.projectAssistantText?.(result) ?? result.text;
				const nextMapping = {
					chatId: input.chatId,
					projectId: input.project.id,
					sessionId: existing.sessionId,
					rawFrameCursor: result.rawFrameCursor,
					eventCursor: result.eventCursor,
					operationId: input.userMessageId,
					assistantText,
					events: result.events,
					...(completedSelection === undefined ? {} : { modelSelection: completedSelection }),
					managedAuthority: { ...authority },
				};
				const mapping = await lifecycle.publishManaged(proof, () => {
					throwIfAborted(input.signal);
					const published = mappings.completeOperationWithMapping(
						input.chatId,
						operation.key,
						operation.hash,
						nextMapping,
						"turn",
					);
					input.afterPublish?.({ assistantText, events: result.events, mapping: published });
					return published;
				});
				return { assistantText, events: result.events, mapping };
			} catch (error) {
				if (error instanceof GjcTurnCancelledError && !promptDispatched) {
					try {
						mappings.discardPendingOperation(input.chatId, {
							id: operation.key,
							ingressId: operation.key,
							detail: operation.hash,
						});
					} catch (discardError) {
						try {
							mappings.transitionOperation(input.chatId, operation.key, "uncertain", operation.hash);
						} catch (transitionError) {
							throw new AggregateError(
								[error, discardError, transitionError],
								"pre-prompt cancellation operation cleanup is uncertain",
							);
						}
						throw new AggregateError(
							[error, discardError],
							"pre-prompt cancellation operation cleanup is uncertain",
						);
					}
					throw error;
				}
				mappings.transitionOperation(input.chatId, operation.key, "uncertain", operation.hash);
				throw error;
			}
		});
	} finally {
		input.signal?.removeEventListener("abort", onAbort);
		input.runner.clearTurnCancellation?.(cancellation);
	}
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new GjcTurnCancelledError();
}

function continuationAuthorityFor(input: RouteGjcTurnInput, mapping: SessionMapping): ManagedTurnAuthority {
	const authority = input.managedAuthority;
	const persisted = mapping.managedAuthority;
	if (
		authority === undefined ||
		persisted === undefined ||
		![
			authority.principalId,
			authority.projectId,
			authority.chatId,
			authority.sessionId,
			authority.leaseId,
			authority.epoch,
			authority.requestKey,
		].every(value => typeof value === "string" && value.trim().length > 0) ||
		!Number.isSafeInteger(authority.generation) ||
		authority.generation <= 0 ||
		authority.principalId !== input.principalId ||
		mapping.principalId !== input.principalId ||
		authority.projectId !== input.project.id ||
		authority.canonicalWorkspace !== resolve(input.project.cwd) ||
		authority.chatId !== input.chatId ||
		mapping.chatId !== input.chatId ||
		authority.sessionId !== mapping.sessionId ||
		(authority as ManagedTurnAuthority & { readonly authorityEpoch?: unknown }).authorityEpoch !==
			SESSION_AUTHORITY_V3_EPOCH
	)
		throw new Error(
			"Managed continuation requires exact persisted principal, project, workspace, chat, and positive generation authority.",
		);
	assertSameManagedAuthority(authority, persisted);
	return { ...authority };
}

function assertSameManagedAuthority(actual: ManagedTurnAuthority, expected: ManagedTurnAuthority): void {
	for (const field of [
		"principalId",
		"projectId",
		"canonicalWorkspace",
		"chatId",
		"sessionId",
		"generation",
		"leaseId",
		"epoch",
		"requestKey",
	] as const)
		if (actual[field] !== expected[field])
			throw new Error("Managed GJC session authority does not match persisted authority.");
	if (
		(actual as ManagedTurnAuthority & { readonly authorityEpoch?: unknown }).authorityEpoch !==
		(expected as ManagedTurnAuthority & { readonly authorityEpoch?: unknown }).authorityEpoch
	)
		throw new Error("Managed GJC session authority epoch does not match persisted authority.");
}

function assertManagedProof(
	proof: ManagedGenerationProof | undefined,
	authority: ManagedTurnAuthority,
): asserts proof is ManagedGenerationProof {
	if (
		proof === undefined ||
		proof.kind !== "managed-generation" ||
		proof.sessionId !== authority.sessionId ||
		!Number.isSafeInteger(proof.generation) ||
		proof.generation <= 0 ||
		proof.generation !== authority.generation ||
		proof.leaseId !== authority.leaseId ||
		proof.epoch !== authority.epoch
	)
		throw new Error("GJC turn did not return a fresh matching managed generation proof.");
}

function beginDurableOperation(
	input: RouteGjcTurnInput,
	mappings: SessionMappingStore,
): { readonly key: string; readonly hash: string } {
	const key = input.userMessageId;
	const hash = hashTurnIngress({
		chatId: input.chatId,
		projectId: input.project.id,
		parentId: input.parentId,
		text: input.text,
		...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
	});
	mappings.beginOperation(input.chatId, { id: key, kind: "prompt", ingressId: key, detail: hash });
	return { key, hash };
}

async function withLifecyclePublication<T>(
	runner: GjcTurnRunner,
	address: import("./turn-runner").GjcLifecyclePublicationAddress,
	effect: (lifecycle: import("./turn-runner").GjcLifecycleTransaction) => Promise<T>,
): Promise<T> {
	if (runner.withLifecyclePublication === undefined)
		throw new Error("GJC runner must provide lifecycle publication for mutating operations.");
	return runner.withLifecyclePublication(address, effect);
}

export function replayOperation(operationId: string, result: SessionOperationResult | undefined): RouteGjcTurnResult {
	if (result === undefined || result.kind !== "turn" || result.mapping.operationId !== operationId)
		throw new Error(`GJC operation ${operationId} completed without a valid immutable result binding.`);
	const replayEvents = result.events ?? [];
	return {
		assistantText: result.assistantText,
		events: replayEvents,
		mapping: {
			...result.mapping,
			...(result.managedAuthority === undefined ? {} : { managedAuthority: { ...result.managedAuthority } }),
			operationId,
			assistantText: result.assistantText,
			events: replayEvents,
		},
	};
}
