import { assertPublishedSdkAttachmentCurrent } from "../gjc/public-sdk-session-port";
import { SdkV3OperationError } from "../gjc/sdk-v3-protocol";
import type { routeGjcTurn, SessionMapping, SessionMappingStore } from "../gjc/session-router";
import { scopedSessionMappingStore } from "../gjc/session-turn-router";
import { type GjcControlResult, type GjcLifecycleTestBarrierHook, GjcTurnCancelledError } from "../gjc/turn-runner";
import type { OutboxStore } from "../state/outbox";
import type { LiveGatewayRunnerInput, LiveGatewayRunnerResult } from "./chat-completions";
import { OpenWebUIControlError } from "./chat-completions-types";
import { waitForSdkEndpoint } from "./gjc-routing-endpoints";
import { sameAttachmentProof } from "./gjc-routing-proof";
import { controlOperationHash, controlOperationKind, publishControlMapping } from "./gjc-routing-publication";
import { withCanonicalModel } from "./gjc-routing-selection";
import { formatCanonicalModelId } from "./models";
import { ensureProjectionRows, projectTurnEvents } from "./workflow-gate-turns";
export interface RoutingControlDependencies {
	readonly turnRunner: Parameters<typeof routeGjcTurn>[0]["runner"];
	readonly mappings: SessionMappingStore;
	readonly outbox?: OutboxStore;
	readonly ownerUserId?: string;
	readonly testBarrierHook?: GjcLifecycleTestBarrierHook;
}
export async function runRoutingControl(
	input: RoutingControlDependencies,
	turn: LiveGatewayRunnerInput,
	existing: SessionMapping,
): Promise<LiveGatewayRunnerResult & { readonly model?: string }> {
	const controlled = input.turnRunner;
	const control = turn.control;
	if (control === undefined) throw new Error("OpenWebUI control request was not supplied.");
	if (controlled.runControl === undefined) throw new OpenWebUIControlError(control.operation);
	const runControl = controlled.runControl;
	const principalId = principalIdForTurn(turn);
	const projectionOwnerUserId = principalId ?? input.ownerUserId ?? "openwebui-gjc-adapter";
	const mappings =
		principalId === undefined ? input.mappings : scopedSessionMappingStore(input.mappings, principalId, turn.chatId);
	const scopedInput = mappings === input.mappings ? input : { ...input, mappings };
	const hash = controlOperationHash(turn);
	if (controlled.withLifecyclePublication === undefined)
		throw new Error("GJC runner must provide lifecycle publication for controls.");
	const sessionRoot = turn.project.sessionRoot ?? `${turn.project.cwd}/.gjc/sessions`;
	const cancellation = {
		projectId: existing.projectId,
		chatId: existing.chatId,
		sessionId: existing.sessionId,
		operationId: turn.userMessageId,
		...(principalId === undefined ? {} : { principalId }),
	};
	let cancellationRequested = false;
	const onAbort = () => {
		if (cancellationRequested) return;
		cancellationRequested = true;
		void Promise.resolve(controlled.cancelTurn?.(cancellation)).catch(() => undefined);
	};
	turn.signal?.addEventListener("abort", onAbort, { once: true });
	if (turn.signal?.aborted) onAbort();
	// The public SDK control runner reports the exact point at which a command
	// is handed to the SDK. Branch controls have a separate multi-phase flow and
	// remain conservatively uncertain; all other controls, including lifecycle
	// controls, expose this dispatch boundary.
	const dispatchIsTracked = control.operation !== "branch";
	let predecessor: { readonly applied: GjcControlResult; readonly mapping?: SessionMapping };
	try {
		throwIfAborted(turn.signal);
		predecessor = await controlled.withLifecyclePublication(
			{
				cwd: turn.project.cwd,
				sessionRoot,
				projectId: existing.projectId,
				chatId: existing.chatId,
				sessionId: existing.sessionId,
				sessionFile: existing.sessionFile,
				recoveryAttachment: existing.attachment,
			},
			async lifecycle => {
				throwIfAborted(turn.signal);
				let dispatchFired: boolean | undefined = dispatchIsTracked ? false : undefined;
				mappings.beginOperation(turn.chatId, {
					id: turn.userMessageId,
					kind: control.operation === "session.new" ? "create" : controlOperationKind(control.operation),
					ingressId: turn.userMessageId,
					detail: hash,
				});
				try {
					const applied = await runControl.call(
						controlled,
						turn,
						existing,
						lifecycle,
						control.operation === "session.new" || control.operation === "branch"
							? successor => {
									mappings.recordAcknowledgedSuccessor(turn.chatId, turn.userMessageId, hash, successor);
								}
							: undefined,
						() => {
							dispatchFired = true;
						},
					);
					throwIfAborted(turn.signal);
					if (control.operation === "branch") return { applied };
					return {
						applied,
						mapping: await publishControlMapping(mappings, lifecycle, turn, existing, applied, hash, mapping =>
							ensureProjectionRows(input.outbox, mapping, projectionOwnerUserId, principalId),
						),
					};
				} catch (error) {
					if (dispatchFired === false) {
						mappings.discardPendingOperation(turn.chatId, {
							id: turn.userMessageId,
							ingressId: turn.userMessageId,
							detail: hash,
						});
					} else {
						mappings.transitionOperation(turn.chatId, turn.userMessageId, "uncertain", hash);
					}
					throw error;
				}
			},
		);
	} finally {
		turn.signal?.removeEventListener("abort", onAbort);
		controlled.clearTurnCancellation?.(cancellation);
	}
	if (control.operation === "branch")
		return continueBranch(scopedInput, turn, existing, sessionRoot, hash, controlled, predecessor.applied);
	const { applied, mapping } = predecessor;
	if (mapping === undefined) throw new Error("GJC control did not publish a mapping.");
	const result = applied.result;
	return withCanonicalModel(
		{
			content: result?.text ?? mapping.assistantText ?? "",
			...(result === undefined || result.events.length === 0
				? {}
				: {
						events: projectTurnEvents(
							result.events,
							mapping.modelSelection === undefined ? undefined : formatCanonicalModelId(mapping.modelSelection),
						),
					}),
		},
		mapping.modelSelection,
	);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new GjcTurnCancelledError();
}

async function continueBranch(
	input: RoutingControlDependencies,
	turn: LiveGatewayRunnerInput,
	existing: SessionMapping,
	sessionRoot: string,
	hash: string,
	controlled: NonNullable<RoutingControlDependencies["turnRunner"]>,
	applied: Awaited<ReturnType<NonNullable<RoutingControlDependencies["turnRunner"]["runControl"]>>>,
): Promise<LiveGatewayRunnerResult & { readonly model?: string }> {
	const { sessionId, sessionFile, attachment } = applied;
	const principalId = principalIdForTurn(turn);
	const projectionOwnerUserId = principalId ?? input.ownerUserId ?? "openwebui-gjc-adapter";
	const cancellation = {
		projectId: existing.projectId,
		chatId: existing.chatId,
		...(sessionId === undefined ? {} : { sessionId }),
		operationId: turn.userMessageId,
		...(principalId === undefined ? {} : { principalId }),
	};
	let cancellationRequested = false;
	const onAbort = () => {
		if (cancellationRequested) return;
		cancellationRequested = true;
		void Promise.resolve(controlled.cancelTurn?.(cancellation)).catch(() => undefined);
	};
	turn.signal?.addEventListener("abort", onAbort, { once: true });
	if (turn.signal?.aborted) onAbort();
	try {
		throwIfAborted(turn.signal);
		if (sessionId === undefined || sessionFile === undefined || attachment === undefined)
			throw new Error("GJC branch did not return an exact successor descriptor.");
		assertCurrentBranchPredecessor(input.mappings, turn.chatId, existing, turn.userMessageId);
		const successorPublished = await waitForSdkEndpoint(turn.project.cwd, sessionId);
		throwIfAborted(turn.signal);
		if (!sameAttachmentProof(attachment, successorPublished))
			throw new SdkV3OperationError(
				"endpoint_stale",
				"Branch successor descriptor changed between lifecycle phases",
			);
		await input.testBarrierHook?.("between_branch_phases", {
			cwd: successorPublished.cwd,
			sessionId: successorPublished.sessionId,
			...(successorPublished.authority === undefined
				? {}
				: {
						generation: successorPublished.authority.generation,
						digestPrefix: successorPublished.authority.payloadDigest.slice(0, 12),
					}),
		});
		assertPublishedSdkAttachmentCurrent(successorPublished);
		if (!sameAttachmentProof(attachment, successorPublished))
			throw new SdkV3OperationError(
				"endpoint_stale",
				"Branch successor descriptor changed between lifecycle phases",
			);
	} catch (error) {
		input.mappings.transitionOperation(turn.chatId, turn.userMessageId, "uncertain", hash);
		turn.signal?.removeEventListener("abort", onAbort);
		controlled.clearTurnCancellation?.(cancellation);
		throw error;
	}
	try {
		return await controlled.withLifecyclePublication!(
			{
				cwd: turn.project.cwd,
				sessionRoot,
				projectId: existing.projectId,
				chatId: existing.chatId,
				sessionId,
				sessionFile,
				recoveryAttachment: attachment,
			},
			async lifecycle => {
				try {
					throwIfAborted(turn.signal);
					assertCurrentBranchPredecessor(input.mappings, turn.chatId, existing, turn.userMessageId);
					await controlled.switchSession({
						cwd: turn.project.cwd,
						sessionRoot,
						projectId: existing.projectId,
						chatId: existing.chatId,
						sessionId,
						sessionFile,
						recoveryAttachment: attachment,
						lifecycle,
					});
					const state = await controlled.getState({
						cwd: turn.project.cwd,
						sessionRoot,
						projectId: existing.projectId,
						chatId: existing.chatId,
						sessionId,
						sessionFile,
						recoveryAttachment: attachment,
						lifecycle,
					});
					throwIfAborted(turn.signal);
					assertCurrentBranchPredecessor(input.mappings, turn.chatId, existing, turn.userMessageId);
					const result = await controlled.continueSession({
						cwd: turn.project.cwd,
						sessionRoot,
						projectId: existing.projectId,
						chatId: existing.chatId,
						sessionId,
						sessionFile,
						recoveryAttachment: attachment,
						userMessageId: turn.userMessageId,
						parentId: turn.userMessageParentId ?? undefined,
						text: turn.prompt,
						activeLeaf: state.activeLeaf,
						rawFrameCursor: state.rawFrameCursor,
						eventCursor: state.eventCursor,
						operationId: turn.userMessageId,
						lifecycle,
						...(turn.signal === undefined ? {} : { signal: turn.signal }),
						...(principalId === undefined ? {} : { principalId }),
					});
					throwIfAborted(turn.signal);
					if (result.attachment === undefined)
						throw new Error("GJC branch successor did not return a validated current attachment.");
					assertCurrentBranchPredecessor(input.mappings, turn.chatId, existing, turn.userMessageId);
					const mapping = await lifecycle.publish(result.attachment, () => {
						throwIfAborted(turn.signal);
						const published = input.mappings.completeOperationWithMapping(
							turn.chatId,
							turn.userMessageId,
							hash,
							{
								...existing,
								sessionId,
								sessionFile,
								operationId: turn.userMessageId,
								assistantText: result.text,
								rawFrameCursor: result.rawFrameCursor,
								eventCursor: result.eventCursor,
								events: result.events,
								attachment: result.attachment,
							},
							"control",
						);
						ensureProjectionRows(input.outbox, published, projectionOwnerUserId, principalId);
						return published;
					});
					return withCanonicalModel(
						{
							content: result.text,
							...(result.events.length === 0 ? {} : { events: projectTurnEvents(result.events, undefined) }),
						},
						mapping.modelSelection,
					);
				} catch (error) {
					input.mappings.transitionOperation(turn.chatId, turn.userMessageId, "uncertain", hash);
					throw error;
				}
			},
		);
	} finally {
		turn.signal?.removeEventListener("abort", onAbort);
		controlled.clearTurnCancellation?.(cancellation);
	}
}
function principalIdForTurn(turn: LiveGatewayRunnerInput): string | undefined {
	const ownerUserId = turn.ownerUserId;
	return typeof ownerUserId === "string" && ownerUserId.trim().length > 0 ? ownerUserId : undefined;
}
function assertCurrentBranchPredecessor(
	mappings: SessionMappingStore,
	chatId: string,
	predecessor: SessionMapping,
	operationId: string,
): void {
	const current = mappings.get(chatId);
	const operation = mappings.operation(chatId, operationId);
	if (
		current === undefined ||
		current.projectId !== predecessor.projectId ||
		current.chatId !== predecessor.chatId ||
		current.sessionId !== predecessor.sessionId ||
		current.sessionFile !== predecessor.sessionFile ||
		operation?.state !== "pending"
	)
		throw new OpenWebUIControlError("branch_predecessor_replaced");
}
