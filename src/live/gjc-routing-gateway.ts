import type { NormalizedModelSelection } from "../contracts";
import {
	type RouteGjcTurnResult,
	routeGjcTurn,
	type SessionMapping,
	type SessionMappingStore,
} from "../gjc/session-router";
import { scopedSessionMappingStore } from "../gjc/session-turn-router";
import type { GjcLifecycleTestBarrierHook } from "../gjc/turn-runner";
import { projectPendingWorkflowGateMessage } from "../projection/workflow-gates";
import type { OutboxStore } from "../state/outbox";
import type { LiveGatewayRunner, LiveGatewayRunnerInput, LiveGatewayRunnerResult } from "./chat-completions";
import { isWorkspaceLeaseUncertainError } from "./chat-completions";
import { runRoutingControl } from "./gjc-routing-control";
import { replayRoutingOperation } from "./gjc-routing-operation-replay";
import {
	assertBoundRequest,
	isModelSelectionApplyFailure,
	resolveNormalSelection,
	withCanonicalModel,
} from "./gjc-routing-selection";
import type { ModelReader, ModelReaderFactory } from "./model-reader";
import { modelSelectionError } from "./model-selection-errors";
import { formatCanonicalModelId } from "./models";
import {
	ensureProjectionRows,
	handleWorkflowGateReply,
	latestPendingWorkflowGate,
	projectTurnEvents,
} from "./workflow-gate-turns";

function principalIdForTurn(turn: LiveGatewayRunnerInput): string | undefined {
	const ownerUserId = turn.ownerUserId;
	return typeof ownerUserId === "string" && ownerUserId.trim().length > 0 ? ownerUserId : undefined;
}

export type GjcSessionTurnRunner = Parameters<typeof routeGjcTurn>[0]["runner"];
export interface CreateGjcRoutingLiveGatewayRunnerInput {
	readonly turnRunner: GjcSessionTurnRunner;
	readonly mappings: SessionMappingStore;
	readonly outbox?: OutboxStore;
	readonly ownerUserId?: string;
	readonly requestedModelId?: (turn: LiveGatewayRunnerInput) => string;
	readonly createNeutralModelReader?: (
		turn: LiveGatewayRunnerInput,
	) => NeutralModelReader | Promise<NeutralModelReader>;
	readonly modelReaderFactory?: ModelReaderFactory;
	/** Test-only synchronization point; it never receives endpoint credentials. */ readonly testBarrierHook?: GjcLifecycleTestBarrierHook;
}

export type NeutralModelReader = ModelReader;
export type { ModelReader, ModelReaderFactory } from "./model-reader";

export type GjcRoutingLiveGatewayRunnerResult = LiveGatewayRunnerResult & { readonly model?: string };

export interface GjcRoutingLiveGatewayRunner extends LiveGatewayRunner {
	run(turn: LiveGatewayRunnerInput): Promise<GjcRoutingLiveGatewayRunnerResult>;
}

export function createGjcRoutingLiveGatewayRunner(
	input: CreateGjcRoutingLiveGatewayRunnerInput,
): GjcRoutingLiveGatewayRunner {
	return {
		async stop(): Promise<void> {
			await input.turnRunner.stop?.();
		},
		async run(turn: LiveGatewayRunnerInput): Promise<GjcRoutingLiveGatewayRunnerResult> {
			const principalId = principalIdForTurn(turn);
			const projectionOwnerUserId = principalId ?? input.ownerUserId ?? "openwebui-gjc-adapter";
			const scopedMappings =
				principalId === undefined
					? input.mappings
					: scopedSessionMappingStore(input.mappings, principalId, turn.chatId);
			let existing = scopedMappings.get(turn.chatId);
			const priorProvisional = scopedMappings.provisionalOperation(turn.chatId, turn.userMessageId);
			if (
				priorProvisional !== undefined &&
				(priorProvisional.projectId !== turn.project.id ||
					(existing !== undefined && existing.projectId !== priorProvisional.projectId))
			)
				throw new Error(`GJC operation ${turn.userMessageId} is not authorized for project ${turn.project.id}.`);
			const priorAuthority = scopedMappings.operationAuthority(turn.chatId, turn.userMessageId);
			if (
				priorAuthority !== undefined &&
				("retiredAt" in priorAuthority || priorAuthority.projectId !== turn.project.id)
			)
				throw new Error(`GJC operation ${turn.userMessageId} is not authorized for project ${turn.project.id}.`);
			const reassignmentSource =
				existing !== undefined && existing.projectId !== turn.project.id ? existing.projectId : undefined;
			if (reassignmentSource !== undefined) existing = undefined;
			let reassignmentStarted = false;
			const beginReassignment = () => {
				if (reassignmentSource === undefined || reassignmentStarted) return;
				scopedMappings.beginProjectReassignment(turn.chatId, reassignmentSource, turn.project.id);
				reassignmentStarted = true;
			};
			const rollbackReassignment = (cause: unknown) => {
				if (reassignmentSource === undefined || !reassignmentStarted) return;
				try {
					scopedMappings.rollbackProjectReassignment(turn.chatId, reassignmentSource);
				} catch (rollbackError) {
					const committed = scopedMappings.get(turn.chatId);
					if (committed?.projectId === turn.project.id) {
						reassignmentStarted = false;
						return;
					}
					throw new AggregateError(
						[cause, rollbackError],
						`Failed to roll back project reassignment for chat ${turn.chatId}.`,
					);
				}
				reassignmentStarted = false;
			};
			const replayedOperation = await replayRoutingOperation(input, turn);
			if (replayedOperation !== null) return replayedOperation;

			const requestedModelId = turn.requestedModelId ?? input.requestedModelId?.(turn);
			if (
				requestedModelId !== undefined &&
				isSameProject(existing, turn) &&
				existing.operationId === turn.userMessageId
			) {
				const selection = assertBoundRequest(existing, requestedModelId, "duplicate");
				const events = projectTurnEvents(existing.events ?? [], formatCanonicalModelId(selection));
				const result =
					events.length === 0
						? { content: existing.assistantText ?? "" }
						: { content: existing.assistantText ?? "", events };
				return withCanonicalModel(result, selection);
			}
			if (turn.control !== undefined && isSameProject(existing, turn))
				return runRoutingControl(input, turn, existing);
			const boundMapping = isSameProject(existing, turn) ? existing : undefined;
			const pendingPreflight = latestPendingWorkflowGate(boundMapping?.events ?? []);
			let boundSelection: NormalizedModelSelection | undefined;
			if (pendingPreflight !== null && boundMapping !== undefined) {
				const selection = assertBoundRequest(boundMapping, requestedModelId, "pending");
				if (requestedModelId !== undefined) boundSelection = selection;
			}
			let gateReplyResult: LiveGatewayRunnerResult | null = null;
			if (pendingPreflight !== null && boundMapping !== undefined) {
				if (input.turnRunner.withLifecyclePublication === undefined)
					throw new Error("GJC runner must provide lifecycle publication for workflow gates.");
				const gateAddress = {
					cwd: turn.project.cwd,
					sessionRoot: turn.project.sessionRoot ?? `${turn.project.cwd}/.gjc/sessions`,
					projectId: boundMapping.projectId,
					chatId: boundMapping.chatId,
					sessionId: boundMapping.sessionId,
					sessionFile: boundMapping.sessionFile,
					recoveryAttachment: boundMapping.attachment,
				};
				if (turn.onLiveEvents === undefined) {
					gateReplyResult = await input.turnRunner.withLifecyclePublication(gateAddress, lifecycle =>
						handleWorkflowGateReply({ ...input, mappings: scopedMappings }, turn, boundMapping, lifecycle),
					);
				} else {
					const queue = new LiveChunkQueue();
					let activityStarted = false;
					let observedNativeLifecycle = false;
					let leaseFailed = false;
					const terminalEvents: ReturnType<typeof projectTurnEvents>[number][] = [];
					let resolveActivity!: () => void;
					let rejectActivity!: (error: unknown) => void;
					const firstActivity = new Promise<void>((resolve, reject) => {
						resolveActivity = resolve;
						rejectActivity = reject;
					});
					const markActivityStarted = () => {
						if (activityStarted) return;
						activityStarted = true;
						resolveActivity();
					};
					const observer = async (event: import("../gjc/turn-runner").GjcTurnEvent) => {
						if (isNativeLifecycleEvent(event.type)) observedNativeLifecycle = true;
						if (event.type !== "agent_failed") markActivityStarted();
						const payload = isRecord(event.payload) ? event.payload : undefined;
						const assistant =
							payload !== undefined && isRecord(payload.assistantMessageEvent)
								? payload.assistantMessageEvent
								: undefined;
						if (
							event.type === "message_update" &&
							assistant?.type === "text_delta" &&
							(typeof assistant.delta === "string" || typeof assistant.text === "string")
						) {
							await queue.push(
								typeof assistant.delta === "string" ? assistant.delta : (assistant.text as string),
							);
							return;
						}
						const projected = projectTurnEvents(
							[event],
							boundSelection === undefined ? undefined : formatCanonicalModelId(boundSelection),
						);
						if (isTerminalEvent(event.type)) {
							terminalEvents.push(...projected);
							return;
						}
						if (projected.length > 0) {
							try {
								await deliverLiveEvents(turn, projected);
							} catch (error) {
								leaseFailed = true;
								// Re-throw so routeGjcTurn/continueSession abort the
								// background turn promptly instead of deferring to the
								// final .then (which only runs after the turn settles).
								throw error;
							}
						}
					};
					const backgroundRoute = input.turnRunner
						.withLifecyclePublication(gateAddress, lifecycle =>
							handleWorkflowGateReply(
								{ ...input, mappings: scopedMappings },
								turn,
								boundMapping,
								lifecycle,
								observer,
							),
						)
						.then(async result => {
							markActivityStarted();
							if (leaseFailed) throw new Error("Workspace lease was lost during the streamed turn.");
							if (result === null) throw new Error("Pending workflow gate disappeared before its reply.");
							const completionEvents = observedNativeLifecycle ? terminalEvents : (result.events ?? []);
							if (completionEvents.length > 0) await deliverLiveEvents(turn, completionEvents);
							await queue.finish(result.content ?? "");
						})
						.catch(error => {
							if (!activityStarted) rejectActivity(error);
							queue.fail(error);
						});
					await firstActivity;
					return withCanonicalModel({ chunks: queue, abandon: () => backgroundRoute }, boundSelection);
				}
			}
			if (gateReplyResult !== null) return withCanonicalModel(gateReplyResult, boundSelection);
			const modelSelection =
				requestedModelId === undefined ? undefined : await resolveNormalSelection(input, turn, requestedModelId);

			if (turn.onLiveEvents === undefined) beginReassignment();
			if (turn.onLiveEvents === undefined) {
				let result: RouteGjcTurnResult;
				try {
					result = await routeGjcTurn({
						...(principalId === undefined ? {} : { principalId }),
						project: turn.project,
						chatId: turn.chatId,
						userMessageId: turn.userMessageId,
						parentId: turn.userMessageParentId ?? undefined,
						text: turn.prompt,
						runner: input.turnRunner,
						mappings: input.mappings,
						projectAssistantText: routed => {
							const pendingGate = latestPendingWorkflowGate(routed.events);
							return pendingGate === null ? routed.text : projectPendingWorkflowGateMessage(pendingGate);
						},
						afterPublish: routed =>
							ensureProjectionRows(input.outbox, routed.mapping, projectionOwnerUserId, principalId),
						...(turn.signal === undefined ? {} : { signal: turn.signal }),
						...(modelSelection === undefined ? {} : { modelSelection }),
					});
					reassignmentStarted = false;
				} catch (error) {
					rollbackReassignment(error);
					if (isModelSelectionApplyFailure(error)) throw modelSelectionError("model_selection_apply_failed");
					throw error;
				}
				const projectedEvents = projectTurnEvents(
					result.events,
					result.mapping.modelSelection === undefined
						? undefined
						: formatCanonicalModelId(result.mapping.modelSelection),
				);
				const response =
					projectedEvents.length > 0
						? { content: result.assistantText, events: projectedEvents }
						: { content: result.assistantText };
				return withCanonicalModel(response, result.mapping.modelSelection);
			}
			beginReassignment();
			const queue = new LiveChunkQueue();
			let activityStarted = false;
			let observedNativeLifecycle = false;
			let agentStartDelivered = false;
			let leaseFailed = false;
			let resolveActivity!: () => void;
			let rejectActivity!: (error: unknown) => void;
			const firstActivity = new Promise<void>((resolve, reject) => {
				resolveActivity = resolve;
				rejectActivity = reject;
			});
			const markActivityStarted = () => {
				if (activityStarted) return;
				activityStarted = true;
				resolveActivity();
			};
			const backgroundRoute = routeGjcTurn({
				...(principalId === undefined ? {} : { principalId }),
				project: turn.project,
				chatId: turn.chatId,
				userMessageId: turn.userMessageId,
				parentId: turn.userMessageParentId ?? undefined,
				text: turn.prompt,
				runner: input.turnRunner,
				mappings: input.mappings,
				projectAssistantText: routed => {
					const pendingGate = latestPendingWorkflowGate(routed.events);
					return pendingGate === null ? routed.text : projectPendingWorkflowGateMessage(pendingGate);
				},
				afterPublish: routed =>
					ensureProjectionRows(input.outbox, routed.mapping, projectionOwnerUserId, principalId),
				...(turn.signal === undefined ? {} : { signal: turn.signal }),
				onObservedTurn: async event => {
					if (event.type !== "agent_failed") markActivityStarted();
					if (isNativeLifecycleEvent(event.type)) observedNativeLifecycle = true;
					if (isTerminalEvent(event.type)) return;
					const payload = isRecord(event.payload) ? event.payload : undefined;
					const assistant =
						payload !== undefined && isRecord(payload.assistantMessageEvent)
							? payload.assistantMessageEvent
							: undefined;
					const assistantType =
						assistant !== undefined && typeof assistant.type === "string" ? assistant.type : undefined;
					if (event.type === "message_update" && assistantType === "text_delta") {
						const delta =
							typeof assistant?.delta === "string"
								? assistant.delta
								: typeof assistant?.text === "string"
									? assistant.text
									: undefined;
						if (delta !== undefined) await queue.push(delta);
						return;
					}
					const projected = projectTurnEvents(
						[event],
						modelSelection === undefined ? undefined : formatCanonicalModelId(modelSelection),
					).filter(
						projectedEvent =>
							projectedEvent.type !== "status" || projectedEvent.data.description !== "Unsupported GJC frame",
					);
					if (projected.length > 0) {
						if (event.type === "agent_start") agentStartDelivered = true;
						try {
							await deliverLiveEvents(turn, projected);
						} catch (error) {
							leaseFailed = true;
							// Re-throw so routeGjcTurn/continueSession abort the
							// background turn promptly instead of deferring to the
							// final .then (which only runs after the turn settles).
							throw error;
						}
					}
				},
				...(modelSelection === undefined ? {} : { modelSelection }),
			})
				.then(async result => {
					reassignmentStarted = false;
					markActivityStarted();
					if (leaseFailed) throw new Error("Workspace lease was lost during the streamed turn.");
					const canonicalModel =
						result.mapping.modelSelection === undefined
							? undefined
							: formatCanonicalModelId(result.mapping.modelSelection);
					const pendingGate = latestPendingWorkflowGate(result.events);
					const completionEvents =
						pendingGate !== null
							? result.events
							: observedNativeLifecycle
								? result.events.filter(event => isTerminalEvent(event.type))
								: result.events.filter(event => !(agentStartDelivered && event.type === "agent_start"));
					const projected = projectTurnEvents(completionEvents, canonicalModel);
					if (projected.length > 0) await deliverLiveEvents(turn, projected);
					await queue.finish(result.assistantText);
				})
				.catch(error => {
					let mappedError: unknown = isModelSelectionApplyFailure(error)
						? modelSelectionError("model_selection_apply_failed")
						: error;
					try {
						rollbackReassignment(mappedError);
					} catch (rollbackError) {
						mappedError = rollbackError;
					}
					if (!activityStarted) rejectActivity(mappedError);
					queue.fail(mappedError);
				});
			await firstActivity;
			return withCanonicalModel({ chunks: queue, abandon: () => backgroundRoute }, modelSelection);
		},
	};
}

function isSameProject(mapping: SessionMapping | undefined, turn: LiveGatewayRunnerInput): mapping is SessionMapping {
	return mapping !== undefined && mapping.projectId === turn.project.id;
}
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null;
}
function isNativeLifecycleEvent(type: unknown): boolean {
	return (
		typeof type === "string" &&
		["message_update", "tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(type)
	);
}
function isTerminalEvent(type: unknown): boolean {
	return typeof type === "string" && ["agent_end", "agent_failed", "action_needed"].includes(type);
}
class LiveChunkQueue implements AsyncIterable<string> {
	private readonly items: string[] = [];
	private readonly waiters: Array<{
		readonly resolve: (result: IteratorResult<string>) => void;
		readonly reject: (error: unknown) => void;
	}> = [];
	private pendingBytes = 0;
	private failure: unknown;
	private accumulated = "";
	private closed = false;
	async push(value: string): Promise<void> {
		if (this.closed || this.failure !== undefined) throw this.failure ?? new Error("Live stream is closed.");
		this.accumulated += value;
		const waiter = this.waiters.shift();
		if (waiter !== undefined) {
			waiter.resolve({ value, done: false });
			return;
		}
		if (this.items.length >= 256 || this.pendingBytes + value.length > 1024 * 1024)
			throw new Error("Live stream backpressure limit exceeded.");
		this.items.push(value);
		this.pendingBytes += value.length;
	}
	async finish(finalText: string): Promise<void> {
		if (finalText.length > 0 && this.accumulated.length === 0) await this.push(finalText);
		else if (!finalText.startsWith(this.accumulated))
			throw new Error("Live stream diverged from final assistant text.");
		else if (finalText.length > this.accumulated.length) await this.push(finalText.slice(this.accumulated.length));
		this.closed = true;
		while (this.waiters.length > 0) this.waiters.shift()?.resolve({ value: undefined, done: true });
	}
	fail(error: unknown): void {
		this.failure = error;
		while (this.waiters.length > 0) this.waiters.shift()?.reject(error);
	}
	[Symbol.asyncIterator](): AsyncIterator<string> {
		return {
			next: () => {
				if (this.failure !== undefined) return Promise.reject(this.failure);
				const value = this.items.shift();
				if (value !== undefined) {
					this.pendingBytes -= value.length;
					return Promise.resolve({ value, done: false });
				}
				return this.closed
					? Promise.resolve({ value: undefined, done: true })
					: new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
			},
		};
	}
}
async function deliverLiveEvents(
	turn: LiveGatewayRunnerInput,
	events: NonNullable<LiveGatewayRunnerResult["events"]>,
): Promise<void> {
	try {
		await turn.onLiveEvents?.(events);
	} catch (error) {
		// A lost workspace fence is not a best-effort delivery failure: the
		// streamed turn must abort so its background route cannot keep mutating
		// the workspace after another process may have taken the lease.
		if (isWorkspaceLeaseUncertainError(error)) throw error;
		// OpenWebUI progress delivery is best-effort and cannot invalidate an accepted GJC turn.
	}
}
