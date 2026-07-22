import type { NormalizedModelSelection } from "../contracts";
import {
	type RouteGjcTurnResult,
	routeGjcTurn,
	type SessionMapping,
	type SessionMappingStore,
} from "../gjc/session-router";
import type { GjcLifecycleTestBarrierHook } from "../gjc/turn-runner";
import { projectPendingWorkflowGateMessage } from "../projection/workflow-gates";
import type { OutboxStore } from "../state/outbox";
import type { LiveGatewayRunner, LiveGatewayRunnerInput, LiveGatewayRunnerResult } from "./chat-completions";
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
			const replayedOperation = await replayRoutingOperation(input, turn);
			if (replayedOperation !== null) return replayedOperation;

			const requestedModelId = turn.requestedModelId ?? input.requestedModelId?.(turn);
			const existing = input.mappings.get(turn.chatId);
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
			const gateReplyResult =
				pendingPreflight === null || boundMapping === undefined
					? null
					: input.turnRunner.withLifecyclePublication === undefined
						? (() => {
								throw new Error("GJC runner must provide lifecycle publication for workflow gates.");
							})()
						: await input.turnRunner.withLifecyclePublication(
								{
									cwd: turn.project.cwd,
									sessionRoot: turn.project.sessionRoot ?? `${turn.project.cwd}/.gjc/sessions`,
									projectId: boundMapping.projectId,
									chatId: boundMapping.chatId,
									sessionId: boundMapping.sessionId,
									sessionFile: boundMapping.sessionFile,
									recoveryAttachment: boundMapping.attachment,
								},
								lifecycle => handleWorkflowGateReply(input, turn, boundMapping, lifecycle),
							);
			if (gateReplyResult !== null) return withCanonicalModel(gateReplyResult, boundSelection);
			const modelSelection =
				requestedModelId === undefined ? undefined : await resolveNormalSelection(input, turn, requestedModelId);

			if (turn.onLiveEvents === undefined) {
				let result: RouteGjcTurnResult;
				try {
					result = await routeGjcTurn({
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
							ensureProjectionRows(input.outbox, routed.mapping, input.ownerUserId ?? "openwebui-gjc-adapter"),
						...(modelSelection === undefined ? {} : { modelSelection }),
					});
				} catch (error) {
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
			const queue = new LiveChunkQueue();
			let activityStarted = false;
			let observedTurnEvent = false;
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
			void routeGjcTurn({
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
					ensureProjectionRows(input.outbox, routed.mapping, input.ownerUserId ?? "openwebui-gjc-adapter"),
				onObservedTurn: async event => {
					markActivityStarted();
					observedTurnEvent = true;
					const payload = isRecord(event.payload) ? event.payload : undefined;
					const assistant =
						payload !== undefined && isRecord(payload.assistantMessageEvent)
							? payload.assistantMessageEvent
							: undefined;
					const assistantType =
						assistant !== undefined && typeof assistant.type === "string" ? assistant.type : undefined;
					if (event.type === "message_update" && assistantType === "text_delta") {
						if (typeof assistant?.delta === "string") await queue.push(assistant.delta);
						return;
					}
					const projected = projectTurnEvents(
						[event],
						modelSelection === undefined ? undefined : formatCanonicalModelId(modelSelection),
					).filter(
						projectedEvent =>
							projectedEvent.type !== "status" || projectedEvent.data.description !== "Unsupported GJC frame",
					);
					if (projected.length > 0) await turn.onLiveEvents?.(projected);
				},
				...(modelSelection === undefined ? {} : { modelSelection }),
			})
				.then(async result => {
					markActivityStarted();
					const canonicalModel =
						result.mapping.modelSelection === undefined
							? undefined
							: formatCanonicalModelId(result.mapping.modelSelection);
					const pendingGate = latestPendingWorkflowGate(result.events);
					if (!observedTurnEvent || pendingGate !== null) {
						const projected = projectTurnEvents(result.events, canonicalModel);
						if (projected.length > 0) await turn.onLiveEvents?.(projected);
					}
					await queue.finish(result.assistantText);
				})
				.catch(error => {
					const mappedError = isModelSelectionApplyFailure(error)
						? modelSelectionError("model_selection_apply_failed")
						: error;
					if (!activityStarted) rejectActivity(mappedError);
					queue.fail(mappedError);
				});
			await firstActivity;
			return withCanonicalModel({ chunks: queue }, modelSelection);
		},
	};
}

function isSameProject(mapping: SessionMapping | undefined, turn: LiveGatewayRunnerInput): mapping is SessionMapping {
	return mapping !== undefined && mapping.projectId === turn.project.id;
}
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null;
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
