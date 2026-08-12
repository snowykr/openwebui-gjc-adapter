import type { SessionOperationResult } from "./session-authority";
import { ensureSdkSessionFile, validateSessionFile } from "./session-file";
import { recoverInitialMappedSession } from "./session-initial-create-recovery";
import type { SessionMapping, SessionMappingScope, SessionMappingStore } from "./session-mapping-store";
import { copyAttachment, hashTurnIngress, normalizeModelSelection } from "./session-operation-codec";
import { resolveEffectiveGjcSessionRoot } from "./session-root";
import type { RouteGjcTurnInput, RouteGjcTurnResult } from "./session-turn-router-contract";
import { startNewMappedSession } from "./session-turn-router-new";
import { type GjcTurnRunner, getProjectSessionRoot } from "./turn-runner";

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
	const mappings =
		typeof input.principalId === "string" && input.principalId.trim().length > 0
			? scopedSessionMappingStore(input.mappings, input.principalId, input.chatId)
			: input.mappings;
	const scopedInput = mappings === input.mappings ? input : { ...input, mappings };
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
		// Journal results no longer carry the event stream; the record mapping
		// retains it. Replay the CURRENT record mapping so projection rows hash
		// identically to completion, and skip re-enqueueing a superseded
		// operation whose rows already exist (they settle as obsolete).
		const currentMapping = mappings.get(input.chatId);
		const isCurrentReplay = currentMapping !== undefined && currentMapping.operationId === input.userMessageId;
		const replayMapping = isCurrentReplay ? currentMapping! : replayed.mapping;
		const sessionRoot = resolveEffectiveGjcSessionRoot(
			input.project.cwd,
			getProjectSessionRoot(input.project),
			input.runner.resolveSessionRoot,
		);
		return withLifecyclePublication(
			input.runner,
			{
				cwd: input.project.cwd,
				sessionRoot,
				projectId: replayed.mapping.projectId,
				chatId: replayed.mapping.chatId,
				sessionId: replayed.mapping.sessionId,
				sessionFile: replayed.mapping.sessionFile,
				recoveryAttachment: replayed.mapping.attachment,
			},
			async () => {
				if (isCurrentReplay) input.afterPublish?.({ ...replayed, mapping: replayMapping });
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

	if (existing === undefined && mappings.provisionalOperation(input.chatId, input.userMessageId) !== undefined)
		return recoverInitialMappedSession(scopedInput, operationHash);
	if (existing === undefined || existing.projectId !== input.project.id) {
		return startNewMappedSession(scopedInput);
	}

	const sessionRoot = resolveEffectiveGjcSessionRoot(
		input.project.cwd,
		getProjectSessionRoot(input.project),
		input.runner.resolveSessionRoot,
	);
	const operation = beginDurableOperation(scopedInput, mappings);
	let existingSessionFile: string | undefined;
	try {
		existingSessionFile = await ensureSdkSessionFile(
			input.project,
			existing.sessionFile,
			sessionRoot,
			existing.sessionId,
		);
	} catch (error) {
		mappings.transitionOperation(input.chatId, operation.key, "uncertain", operation.hash);
		throw error;
	}
	const address = {
		cwd: input.project.cwd,
		sessionRoot,
		projectId: input.project.id,
		sessionId: existing.sessionId,
		chatId: input.chatId,
	};
	return withLifecyclePublication(
		input.runner,
		{ ...address, sessionFile: existingSessionFile, recoveryAttachment: existing.attachment },
		async lifecycle => {
			try {
				await input.runner.switchSession({
					...address,
					lifecycle,
					sessionFile: existingSessionFile,
					recoveryAttachment: existing.attachment,
				});
				const state = await input.runner.getState({
					...address,
					lifecycle,
					sessionFile: existingSessionFile,
					recoveryAttachment: existing.attachment,
				});
				const result = await input.runner.continueSession({
					...address,
					sessionFile: existingSessionFile,
					userMessageId: input.userMessageId,
					parentId: input.parentId,
					text: input.text,
					activeLeaf: state.activeLeaf,
					rawFrameCursor: state.rawFrameCursor,
					eventCursor: state.eventCursor,
					operationId: input.userMessageId,
					recoveryAttachment: existing.attachment,
					lifecycle,
					...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
					...(input.onObservedTurn === undefined ? {} : { observer: input.onObservedTurn }),
				});
				const completedSelection =
					input.modelSelection === undefined ? undefined : normalizeModelSelection(result.modelSelection);
				if (input.modelSelection !== undefined && completedSelection === undefined)
					throw new TypeError("Missing selected GJC outcome");
				const sessionFile = [result.sessionFile, state.sessionFile, existingSessionFile].find(
					candidate => candidate !== undefined,
				);
				const assistantText = input.projectAssistantText?.(result) ?? result.text;
				const nextMapping = {
					chatId: input.chatId,
					projectId: input.project.id,
					sessionId: existing.sessionId,
					sessionFile:
						sessionFile === undefined ? undefined : validateSessionFile(input.project, sessionFile, sessionRoot),
					activeLeaf: result.activeLeaf ?? state.activeLeaf,
					rawFrameCursor: result.rawFrameCursor,
					eventCursor: result.eventCursor,
					operationId: input.userMessageId,
					assistantText,
					events: result.events,
					...((result.attachment ?? state.attachment ?? existing.attachment) === undefined
						? {}
						: { attachment: result.attachment ?? state.attachment ?? existing.attachment }),
					...(completedSelection === undefined ? {} : { modelSelection: completedSelection }),
				};
				const proof = result.attachment ?? state.attachment ?? existing.attachment;
				if (proof === undefined) throw new Error("GJC turn did not return a validated current attachment.");
				const mapping = await lifecycle.publish(proof, () => {
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
				mappings.transitionOperation(input.chatId, operation.key, "uncertain", operation.hash);
				throw error;
			}
		},
	);
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
			...(result.mapping.attachment === undefined ? {} : { attachment: copyAttachment(result.mapping.attachment) }),
			operationId,
			assistantText: result.assistantText,
			events: replayEvents,
		},
	};
}
