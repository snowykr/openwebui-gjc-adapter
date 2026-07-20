import type { NormalizedModelSelection } from "../contracts";
import { SdkV3OperationError } from "../gjc/sdk-v3-protocol";
import type { GjcLifecycleTestBarrierHook } from "../gjc/turn-runner";
import { assertPublishedSdkAttachmentCurrent } from "../gjc/public-sdk-session-port";
import { type RouteGjcTurnResult, routeGjcTurn, type SessionMapping, type SessionMappingStore } from "../gjc/session-router";
import { projectPendingWorkflowGateMessage } from "../projection/workflow-gates";
import type { OutboxStore } from "../state/outbox";
import type { LiveGatewayRunner, LiveGatewayRunnerInput, LiveGatewayRunnerResult } from "./chat-completions";
import { OpenWebUIControlError } from "./chat-completions-types";
import type { ModelReader, ModelReaderFactory } from "./model-reader";
import { modelSelectionError } from "./model-selection-errors";
import { formatCanonicalModelId } from "./models";
import { ensureProjectionRows, handleWorkflowGateReply, latestPendingWorkflowGate, projectTurnEvents, replayCompletedWorkflowGateReply } from "./workflow-gate-turns";
import { waitForSdkEndpoint } from "./gjc-routing-endpoints";
import { sameAttachmentProof } from "./gjc-routing-proof";
import { assertBoundRequest, isModelSelectionApplyFailure, replayWithLifecyclePublication, resolveNormalSelection, withCanonicalModel } from "./gjc-routing-selection";
import { controlOperationHash, controlOperationKind, publishControlMapping } from "./gjc-routing-publication";

export type GjcSessionTurnRunner = Parameters<typeof routeGjcTurn>[0]["runner"];
export interface CreateGjcRoutingLiveGatewayRunnerInput {
	readonly turnRunner: GjcSessionTurnRunner;
	readonly mappings: SessionMappingStore;
	readonly outbox?: OutboxStore;
	readonly ownerUserId?: string;
	readonly requestedModelId?: (turn: LiveGatewayRunnerInput) => string;
	readonly createNeutralModelReader?: ( turn: LiveGatewayRunnerInput, ) => NeutralModelReader | Promise<NeutralModelReader>;
	readonly modelReaderFactory?: ModelReaderFactory;
	/** Test-only synchronization point; it never receives endpoint credentials. */ readonly testBarrierHook?: GjcLifecycleTestBarrierHook;
}

export type NeutralModelReader = ModelReader;
export type { ModelReader, ModelReaderFactory } from "./model-reader";

export type GjcRoutingLiveGatewayRunnerResult = LiveGatewayRunnerResult & { readonly model?: string };

export interface GjcRoutingLiveGatewayRunner extends LiveGatewayRunner {
	run(turn: LiveGatewayRunnerInput): Promise<GjcRoutingLiveGatewayRunnerResult>;
}

export function createGjcRoutingLiveGatewayRunner( input: CreateGjcRoutingLiveGatewayRunnerInput, ): GjcRoutingLiveGatewayRunner {
	return {
		async stop(): Promise<void> {
			await input.turnRunner.stop?.();
		}, async run(turn: LiveGatewayRunnerInput): Promise<GjcRoutingLiveGatewayRunnerResult> {
			const priorOperation = input.mappings.operation(turn.chatId, turn.userMessageId);
			if (turn.control !== undefined && priorOperation?.state === "complete") {
				const result = priorOperation.result;
				if ( result === undefined || result.kind !== "control" || priorOperation.detail !== controlOperationHash(turn) || result.mapping.operationId !== turn.userMessageId )
					throw new Error(`GJC operation ${turn.userMessageId} completed without a valid immutable result binding.`);
				const selection = result.mapping.modelSelection;
				return replayWithLifecyclePublication(input.turnRunner, turn, result.mapping, async () => {
					ensureProjectionRows(input.outbox, result.mapping, input.ownerUserId ?? "openwebui-gjc-adapter");
					const events = projectTurnEvents(result.events, selection === undefined ? undefined : formatCanonicalModelId(selection));
					return withCanonicalModel( events.length === 0 ? { content: result.assistantText } : { content: result.assistantText, events }, selection, );
				});
			}
			if (turn.control !== undefined && priorOperation?.state === "pending") throw new Error(`GJC operation ${turn.userMessageId} is pending and cannot be replayed.`);
			if (turn.control !== undefined && (priorOperation?.state === "uncertain" || priorOperation?.state === "conflict")) throw new Error(`GJC operation ${turn.userMessageId} requires reconciliation.`);
			if (priorOperation?.state === "complete" && priorOperation.kind === "gate") {
				const result = priorOperation.result;
				if (result === undefined) throw new Error(`GJC workflow gate operation ${turn.userMessageId} completed without a valid immutable result binding.`);
				return replayWithLifecyclePublication(input.turnRunner, turn, result.mapping, async () => {
					const replayed = replayCompletedWorkflowGateReply(input, turn);
					if (replayed === null) throw new Error(`GJC workflow gate operation ${turn.userMessageId} completed without a valid immutable result binding.`);
					return withCanonicalModel(replayed, result.mapping.modelSelection);
				});
			}

			const requestedModelId = turn.requestedModelId ?? input.requestedModelId?.(turn);
			const existing = input.mappings.get(turn.chatId);
			if ( requestedModelId !== undefined && isSameProject(existing, turn) && existing.operationId === turn.userMessageId ) {
				const selection = assertBoundRequest(existing, requestedModelId, "duplicate");
				const events = projectTurnEvents(existing.events ?? [], formatCanonicalModelId(selection));
				const result = events.length === 0 ? { content: existing.assistantText ?? "" }
						: { content: existing.assistantText ?? "", events };
				return withCanonicalModel(result, selection);
			}
			if (turn.control !== undefined && isSameProject(existing, turn)) {
				const controlled = input.turnRunner;
				const control = turn.control;
				if (controlled.runControl === undefined) throw new OpenWebUIControlError(control.operation);
				const runControl = controlled.runControl;
				const hash = controlOperationHash(turn);
				if (controlled.withLifecyclePublication === undefined) throw new Error("GJC runner must provide lifecycle publication for controls.");
				const sessionRoot = turn.project.sessionRoot ?? `${turn.project.cwd}/.gjc/sessions`;
				const predecessor = await controlled.withLifecyclePublication( {
						cwd: turn.project.cwd, sessionRoot, projectId: existing.projectId, chatId: existing.chatId, sessionId: existing.sessionId, sessionFile: existing.sessionFile, recoveryAttachment: existing.attachment, },
					async lifecycle => {
						input.mappings.beginOperation(turn.chatId, {
							id: turn.userMessageId, kind: controlOperationKind(control.operation), ingressId: turn.userMessageId, detail: hash, });
						try {
							const applied = await runControl.call(controlled, turn, existing, lifecycle);
							if (control.operation === "branch") return { applied };
							return {
								applied, mapping: await publishControlMapping( input.mappings, lifecycle, turn, existing, applied, hash, mapping => ensureProjectionRows(input.outbox, mapping, input.ownerUserId ?? "openwebui-gjc-adapter"), ), };
						} catch (error) {
							input.mappings.transitionOperation(turn.chatId, turn.userMessageId, "uncertain", hash);
							throw error;
						}
					}, );
				if (control.operation === "branch") {
					const { sessionId, sessionFile, attachment } = predecessor.applied;
					try {
						if (sessionId === undefined || sessionFile === undefined || attachment === undefined) throw new Error("GJC branch did not return an exact successor descriptor.");
						assertCurrentBranchPredecessor(input.mappings, turn.chatId, existing, turn.userMessageId);
						const successorPublished = await waitForSdkEndpoint(turn.project.cwd, sessionId);
						if (!sameAttachmentProof(attachment, successorPublished)) throw new SdkV3OperationError("endpoint_stale", "Branch successor descriptor changed between lifecycle phases");
						await input.testBarrierHook?.("between_branch_phases", {
							cwd: successorPublished.cwd, sessionId: successorPublished.sessionId, ...(successorPublished.authority === undefined ? {}
								: {
										generation: successorPublished.authority.generation, digestPrefix: successorPublished.authority.payloadDigest.slice(0, 12), }), });
						assertPublishedSdkAttachmentCurrent(successorPublished);
						if (!sameAttachmentProof(attachment, successorPublished)) throw new SdkV3OperationError("endpoint_stale", "Branch successor descriptor changed between lifecycle phases");
					} catch (error) {
						input.mappings.transitionOperation(turn.chatId, turn.userMessageId, "uncertain", hash);
						throw error;
					}
					return controlled.withLifecyclePublication( { cwd: turn.project.cwd, sessionRoot, projectId: existing.projectId, chatId: existing.chatId, sessionId, sessionFile, recoveryAttachment: attachment },
						async lifecycle => {
							try {
								assertCurrentBranchPredecessor(input.mappings, turn.chatId, existing, turn.userMessageId);
								await controlled.switchSession({ cwd: turn.project.cwd, sessionRoot, projectId: existing.projectId, chatId: existing.chatId, sessionId, sessionFile, recoveryAttachment: attachment, lifecycle });
								const state = await controlled.getState({ cwd: turn.project.cwd, sessionRoot, projectId: existing.projectId, chatId: existing.chatId, sessionId, sessionFile, recoveryAttachment: attachment, lifecycle });
								assertCurrentBranchPredecessor(input.mappings, turn.chatId, existing, turn.userMessageId);
								const result = await controlled.continueSession({
									cwd: turn.project.cwd, sessionRoot, projectId: existing.projectId, chatId: existing.chatId, sessionId, sessionFile,
									recoveryAttachment: attachment, userMessageId: turn.userMessageId, parentId: turn.userMessageParentId ?? undefined, text: turn.prompt,
									activeLeaf: state.activeLeaf, rawFrameCursor: state.rawFrameCursor, eventCursor: state.eventCursor, operationId: turn.userMessageId, lifecycle, });
								if (result.attachment === undefined) throw new Error("GJC branch successor did not return a validated current attachment.");
								assertCurrentBranchPredecessor(input.mappings, turn.chatId, existing, turn.userMessageId);
								const mapping = await lifecycle.publish(result.attachment, () => {
									const published = input.mappings.completeOperationWithMapping( turn.chatId, turn.userMessageId, hash,
										{ ...existing, sessionId, sessionFile, operationId: turn.userMessageId, assistantText: result.text, rawFrameCursor: result.rawFrameCursor, eventCursor: result.eventCursor, events: result.events, attachment: result.attachment },
										"control", );
									ensureProjectionRows(input.outbox, published, input.ownerUserId ?? "openwebui-gjc-adapter");
									return published;
								});
								return withCanonicalModel({ content: result.text, ...(result.events.length === 0 ? {} : { events: projectTurnEvents(result.events, undefined) }) }, mapping.modelSelection);
							} catch (error) {
								input.mappings.transitionOperation(turn.chatId, turn.userMessageId, "uncertain", hash);
								throw error;
							}
						}, );
				}
				const { applied, mapping } = predecessor;
				if (mapping === undefined) throw new Error("GJC control did not publish a mapping.");
				const result = applied.result;
				return withCanonicalModel(
					{ content: result?.text ?? mapping.assistantText ?? "", ...(result === undefined || result.events.length === 0 ? {} : { events: projectTurnEvents(result.events, mapping.modelSelection === undefined ? undefined : formatCanonicalModelId(mapping.modelSelection)) }) },
					mapping.modelSelection, );
			}
			const boundMapping = isSameProject(existing, turn) ? existing : undefined;
			const pendingPreflight = latestPendingWorkflowGate(boundMapping?.events ?? []);
			let boundSelection: NormalizedModelSelection | undefined;
			if (requestedModelId !== undefined && pendingPreflight !== null && boundMapping !== undefined) {
				boundSelection = assertBoundRequest(boundMapping, requestedModelId, "pending");
			}
			const gateReplyResult = pendingPreflight === null || boundMapping === undefined ? null : input.turnRunner.withLifecyclePublication === undefined ? (() => {
								throw new Error("GJC runner must provide lifecycle publication for workflow gates.");
							})() : await input.turnRunner.withLifecyclePublication( {
									cwd: turn.project.cwd, sessionRoot: turn.project.sessionRoot ?? `${turn.project.cwd}/.gjc/sessions`, projectId: boundMapping.projectId, chatId: boundMapping.chatId, sessionId: boundMapping.sessionId,
									sessionFile: boundMapping.sessionFile, recoveryAttachment: boundMapping.attachment, }, lifecycle => handleWorkflowGateReply(input, turn, boundMapping, lifecycle), );
			if (gateReplyResult !== null) return withCanonicalModel(gateReplyResult, boundSelection);
			const modelSelection = requestedModelId === undefined ? undefined : await resolveNormalSelection(input, turn, requestedModelId);

			let result: RouteGjcTurnResult;
			try {
				result = await routeGjcTurn({
					project: turn.project, chatId: turn.chatId, userMessageId: turn.userMessageId, parentId: turn.userMessageParentId ?? undefined, text: turn.prompt, runner: input.turnRunner, mappings: input.mappings,
					projectAssistantText: routed => {
						const pendingGate = latestPendingWorkflowGate(routed.events);
						return pendingGate === null ? routed.text : projectPendingWorkflowGateMessage(pendingGate);
					}, afterPublish: routed => ensureProjectionRows(input.outbox, routed.mapping, input.ownerUserId ?? "openwebui-gjc-adapter"), ...(modelSelection === undefined ? {} : { modelSelection }), });
			} catch (error) {
				if (isModelSelectionApplyFailure(error)) throw modelSelectionError("model_selection_apply_failed");
				throw error;
			}


			const canonicalModel = result.mapping.modelSelection === undefined ? undefined : formatCanonicalModelId(result.mapping.modelSelection);
			const projectedEvents = projectTurnEvents(result.events, canonicalModel);
			const pendingGate = latestPendingWorkflowGate(result.events);
			if (pendingGate !== null) {
				const response = projectedEvents.length > 0 ? { content: result.assistantText, events: projectedEvents }
						: { content: result.assistantText };
				return withCanonicalModel(response, result.mapping.modelSelection);
			}

			const response = projectedEvents.length > 0 ? { content: result.assistantText, events: projectedEvents }
					: { content: result.assistantText };
			return withCanonicalModel(response, result.mapping.modelSelection);
		}, };
}

function isSameProject(mapping: SessionMapping | undefined, turn: LiveGatewayRunnerInput): mapping is SessionMapping {
	return mapping !== undefined && mapping.projectId === turn.project.id;
}
function assertCurrentBranchPredecessor( mappings: SessionMappingStore, chatId: string, predecessor: SessionMapping, operationId: string, ): void {
	const current = mappings.get(chatId);
	const operation = mappings.operation(chatId, operationId);
	if ( current === undefined || current.projectId !== predecessor.projectId || current.chatId !== predecessor.chatId || current.sessionId !== predecessor.sessionId || current.sessionFile !== predecessor.sessionFile ||
		operation?.state !== "pending" ) throw new OpenWebUIControlError("branch_predecessor_replaced");
}
