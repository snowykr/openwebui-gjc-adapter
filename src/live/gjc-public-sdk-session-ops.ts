import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { CliLifecycleBackend } from "../gjc/cli-lifecycle-backend";
import type { PublicSdkSessionPort } from "../gjc/public-sdk-contract";
import { snapshotGjcSessionFiles, waitForFreshGjcSessionFile } from "../gjc/session-loader";
import type {
	GjcContinueSessionInput,
	GjcLifecycleTransaction,
	GjcSessionAddress,
	GjcSessionState,
	GjcSessionStateInput,
	GjcStartNewSessionInput,
	GjcSwitchSessionInput,
	GjcTurnResult,
} from "../gjc/turn-runner";
import { GjcTurnCancelledError } from "../gjc/turn-runner";
import {
	currentAttachmentProof,
	ensureAttachment,
	freshAttachmentProof,
	prompt,
	withMutationPort,
	withPort,
} from "./gjc-public-sdk-session-attachment";
import {
	addressFor,
	attachmentFor,
	attachmentKey,
	requireCurrentPublishedSdkEndpoint,
	requireLifecycleAttachment,
	waitForSdkEndpoint,
} from "./gjc-routing-endpoints";
import type { PublicSdkRunnerContext } from "./gjc-routing-lifecycle";
import { normalizeObservedSdkRecord, turnResult } from "./gjc-routing-proof";
import { runLifecycleTestBarrier } from "./gjc-routing-test-barrier";
import { projectSessionArtifactEvents } from "./gjc-session-artifact-events";
import { terminalAbortIdempotencyKey } from "./gjc-terminal-abort-key";

export type OwnedAbortRegistration = (
	address: GjcSessionAddress,
	principalId: string | undefined,
	operationId: string,
	abort: () => Promise<unknown>,
) => { readonly unregister: () => void; readonly cancelled: boolean };

export interface AbortDispatchObservation {
	readonly promise: Promise<unknown>;
	readonly dispatched: Promise<void>;
}

export function abortWithDispatch(
	port: PublicSdkSessionPort,
	key: string | undefined,
	timeoutMs: number | undefined,
): AbortDispatchObservation {
	let resolveDispatch!: () => void;
	const dispatched = new Promise<void>(resolve => {
		resolveDispatch = resolve;
	});
	let promise: Promise<unknown>;
	try {
		promise = port.abort(key, timeoutMs, resolveDispatch);
	} catch (error) {
		promise = Promise.reject(error);
	}
	void promise.catch(() => undefined);
	return { promise, dispatched };
}

/**
 * Wait until the abort control is acknowledged, or its frame has crossed the
 * transport boundary and had one I/O turn to reach the peer. The dispatch
 * marker itself remains synchronous; this grace only keeps an owner port alive
 * long enough for an unacknowledged abort frame to be delivered before detach.
 */
export async function awaitAbortDispatch(
	abortPromise: Promise<unknown>,
	dispatchPromise?: Promise<void>,
): Promise<void> {
	const flushed = dispatchPromise?.then(() => waitForTransportFlush());
	await Promise.race([
		abortPromise.then(
			() => undefined,
			() => undefined,
		),
		flushed ?? new Promise<void>(() => undefined),
	]);
}

function waitForTransportFlush(): Promise<void> {
	return new Promise(resolve => setImmediate(resolve));
}

export {
	currentAttachmentProof,
	ensureAttachment,
	freshAttachmentProof,
	prompt,
	withMutationPort,
	withPort,
} from "./gjc-public-sdk-session-attachment";

export async function startNewSession<T>(
	context: PublicSdkRunnerContext,
	input: GjcStartNewSessionInput,
	publish: (result: GjcSessionAddress & GjcTurnResult, lifecycle: GjcLifecycleTransaction) => Promise<T>,
	beforePrompt: (
		address: GjcSessionAddress,
		attachment: import("../gjc/session-authority").SessionAttachmentProof,
		lifecycle: GjcLifecycleTransaction,
	) => Promise<void>,
	onFailure?: (lifecycle: GjcLifecycleTransaction, error: unknown) => Promise<void>,
	registerOwnedAbort?: OwnedAbortRegistration,
): Promise<T> {
	throwIfAborted(input.signal);
	await mkdir(input.sessionRoot, { recursive: true });
	const baseline = await snapshotGjcSessionFiles(input.sessionRoot);
	const backend = new CliLifecycleBackend({
		cliPath: context.input.cliPath,
		cwd: input.cwd,
		childEnvironment: context.input.runtimeLocations.childEnvironment,
	});
	let lifecycleAttachment: ReturnType<typeof requireLifecycleAttachment> | undefined;
	let cleanupPromise: ReturnType<CliLifecycleBackend["fallbackBeforeCloseAcknowledgement"]> | undefined;
	let provisionalAuthorityPersisted = false;
	let promptStarted = false;
	try {
		const lifecyclePromise = backend.createEphemeral({ sessionRoot: input.sessionRoot });
		void lifecyclePromise.then(
			result => {
				if (!input.signal?.aborted || result.status !== "closed") return;
				void cleanupOwnedPane(result.value).catch(() => undefined);
			},
			() => undefined,
		);
		const createdAttachment = requireLifecycleAttachment(await awaitWithAbort(lifecyclePromise, input.signal));
		lifecycleAttachment = createdAttachment;
		throwIfAborted(input.signal);
		const address = {
			...addressFor(input, createdAttachment.sessionId),
		};
		const initialPublished = await awaitWithAbort(
			waitForSdkEndpoint(input.cwd, createdAttachment.sessionId),
			input.signal,
		);
		throwIfAborted(input.signal);
		await runLifecycleTestBarrier(context.input.testBarrierHook, "post_cli_pre_bind", initialPublished);
		const published = await requireCurrentPublishedSdkEndpoint(input.cwd, initialPublished);
		const attachment = attachmentFor(address, { ...createdAttachment, published });
		context.attachments.set(attachmentKey(address), attachment);
		const { withLifecycle } = await import("./gjc-public-sdk-close");
		return await withLifecycle(
			context,
			address,
			async lifecycle => {
				try {
					const provisionalProof = await currentAttachmentProof(published, attachment, lifecycle);
					requireExactProvisionalProof(provisionalProof);
					await beforePrompt(address, provisionalProof, lifecycle);
					provisionalAuthorityPersisted = true;
					const result = await withMutationPort(context, attachment, lifecycle, async port => {
						let cancelledBeforePrompt = false;
						let rejectCancelled!: (error: Error) => void;
						const cancellation = new Promise<never>((_resolve, reject) => {
							rejectCancelled = reject;
						});
						const registration = registerOwnedAbort?.(
							address,
							input.principalId,
							input.userMessageId,
							async () => {
								cancelledBeforePrompt = true;
								try {
									const abort = abortWithDispatch(
										port,
										terminalAbortIdempotencyKey(input.chatId, input.userMessageId),
										context.input.turnTimeoutMs,
									);
									await awaitAbortDispatch(abort.promise, abort.dispatched);
								} finally {
									rejectCancelled(new GjcTurnCancelledError());
								}
							},
						);
						try {
							throwIfAborted(input.signal, registration?.cancelled);
							return await Promise.race([
								prompt(
									context,
									port,
									input.text,
									input.modelSelection,
									input.observer,
									() => throwIfAborted(input.signal, cancelledBeforePrompt),
									() => {
										promptStarted = true;
									},
									() => throwIfAborted(input.signal, cancelledBeforePrompt),
								),
								cancellation,
							]);
						} finally {
							registration?.unregister();
						}
					});
					const transcript = await waitForFreshGjcSessionFile(
						input.sessionRoot,
						baseline,
						createdAttachment.sessionId,
						resolve(input.cwd),
					);
					const addressWithSessionFile = { ...address, sessionFile: transcript.filePath };
					const durableAttachment = attachmentFor(addressWithSessionFile, {
						...createdAttachment,
						sessionPath: transcript.filePath,
						published: await requireCurrentPublishedSdkEndpoint(input.cwd, attachment.published!),
					});
					context.attachments.set(attachmentKey(addressWithSessionFile), durableAttachment);
					const currentProof = await currentAttachmentProof(
						durableAttachment.published!,
						durableAttachment,
						lifecycle,
					);
					return publish(
						{
							...addressWithSessionFile,
							...turnResult(
								await withSessionArtifactEvents(result.outcome, transcript.filePath, input.text),
								transcript.filePath,
								result.modelSelection,
								currentProof,
							),
						},
						lifecycle,
					);
				} catch (error) {
					if (promptStarted) await onFailure?.(lifecycle, error);
					throw error;
				}
			},
			false,
		);
	} catch (error) {
		if (lifecycleAttachment === undefined) throw error;
		if (provisionalAuthorityPersisted && promptStarted) throw error;
		context.attachments.delete(attachmentKey(addressFor(input, lifecycleAttachment.sessionId)));
		try {
			const fallback = await cleanupOwnedPane(lifecycleAttachment);
			if (fallback.status !== "closed") throw new Error(fallback.message);
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "new GJC session pre-prompt cleanup is uncertain");
		}
		throw error;
	}

	function cleanupOwnedPane(attachment: ReturnType<typeof requireLifecycleAttachment>) {
		if (cleanupPromise === undefined) cleanupPromise = backend.fallbackBeforeCloseAcknowledgement(attachment);
		return cleanupPromise;
	}
}

export async function switchSession(context: PublicSdkRunnerContext, input: GjcSwitchSessionInput): Promise<void> {
	await ensureAttachment(context, input, input.lifecycle);
}

export async function getState(context: PublicSdkRunnerContext, input: GjcSessionStateInput): Promise<GjcSessionState> {
	const attachment = await ensureAttachment(context, input, input.lifecycle);
	const published = await requireCurrentPublishedSdkEndpoint(input.cwd, attachment.published!);
	return {
		...(input.sessionFile === undefined ? {} : { sessionFile: input.sessionFile }),
		rawFrameCursor: 0,
		eventCursor: 0,
		attachment: await currentAttachmentProof(published, attachment, input.lifecycle),
	};
}

export async function continueSession(
	context: PublicSdkRunnerContext,
	input: GjcContinueSessionInput,
	registerOwnedAbort?: OwnedAbortRegistration,
): Promise<GjcTurnResult> {
	throwIfAborted(input.signal);
	const attachment = await ensureAttachment(context, input, input.lifecycle);
	throwIfAborted(input.signal);
	const result = await withMutationPort(context, attachment, input.lifecycle, async port => {
		let cancelledBeforePrompt = false;
		let promptDispatched = false;
		let rejectCancelled!: (error: Error) => void;
		const cancellation = new Promise<never>((_resolve, reject) => {
			rejectCancelled = reject;
		});
		const registration = registerOwnedAbort?.(input, input.principalId, input.operationId, async () => {
			cancelledBeforePrompt = true;
			if (!promptDispatched) {
				rejectCancelled(new GjcTurnCancelledError());
				return;
			}
			try {
				const abort = abortWithDispatch(
					port,
					terminalAbortIdempotencyKey(input.chatId, input.userMessageId),
					context.input.turnTimeoutMs,
				);
				await awaitAbortDispatch(abort.promise, abort.dispatched);
			} finally {
				rejectCancelled(new GjcTurnCancelledError());
			}
		});
		try {
			throwIfAborted(input.signal, registration?.cancelled);
			return await Promise.race([
				prompt(
					context,
					port,
					input.text,
					input.modelSelection,
					input.observer,
					() => throwIfAborted(input.signal, cancelledBeforePrompt),
					() => {
						promptDispatched = true;
						input.onDispatch?.();
					},
					() => throwIfAborted(input.signal, cancelledBeforePrompt),
				),
				cancellation,
			]);
		} finally {
			registration?.unregister();
		}
	});
	return turnResult(
		await withSessionArtifactEvents(result.outcome, input.sessionFile, input.text),
		input.sessionFile,
		result.modelSelection,
		await freshAttachmentProof(input.cwd, attachment, input.lifecycle),
	);
}

export async function getAvailableModels(
	context: PublicSdkRunnerContext,
	input: GjcSessionStateInput,
): Promise<readonly unknown[]> {
	const attachment = await ensureAttachment(context, input, input.lifecycle);
	return withPort(context, attachment, input.lifecycle, port => port.getAvailableModels(context.input.turnTimeoutMs));
}

export async function respondWorkflowGate(
	context: PublicSdkRunnerContext,
	input: import("../gjc/turn-runner").GjcRespondWorkflowGateInput,
	registerOwnedAbort?: OwnedAbortRegistration,
): Promise<GjcTurnResult> {
	throwIfAborted(input.signal);
	const attachment = await ensureAttachment(context, input, input.lifecycle);
	throwIfAborted(input.signal);
	const gate = {
		gateId: input.gateId,
		correlation: input.gateCorrelation ?? {
			sessionId: attachment.sessionId,
			commandId: input.operationId,
			turnId: input.operationId,
		},
		payload: {},
	};
	const outcome = await withMutationPort(context, attachment, input.lifecycle, async port => {
		let cancelled = false;
		let rejectCancelled!: (error: Error) => void;
		const cancellation = new Promise<never>((_resolve, reject) => {
			rejectCancelled = reject;
		});
		const registration = registerOwnedAbort?.(input, input.principalId, input.operationId, async () => {
			cancelled = true;
			try {
				const abort = abortWithDispatch(
					port,
					terminalAbortIdempotencyKey(input.chatId, input.userMessageId),
					context.input.turnTimeoutMs,
				);
				await awaitAbortDispatch(abort.promise, abort.dispatched);
			} finally {
				rejectCancelled(new GjcTurnCancelledError());
			}
		});
		try {
			throwIfAborted(input.signal, registration?.cancelled);
			return await Promise.race([
				port.answerGate(
					gate,
					input.answer,
					input.idempotencyKey,
					context.input.turnTimeoutMs,
					input.observer === undefined ? undefined : event => input.observer?.(normalizeObservedSdkRecord(event)),
					input.onDispatch,
					() => throwIfAborted(input.signal, cancelled),
				),
				cancellation,
			]);
		} finally {
			registration?.unregister();
		}
	});
	return turnResult(
		await withSessionArtifactEvents(outcome, input.sessionFile, input.promptText),
		input.sessionFile,
		undefined,
		await freshAttachmentProof(input.cwd, attachment, input.lifecycle),
	);
}

function throwIfAborted(signal: AbortSignal | undefined, cancelled = false): void {
	if (cancelled || signal?.aborted) throw new GjcTurnCancelledError();
}

function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (signal === undefined) return promise;
	if (signal.aborted) {
		void promise.catch(() => undefined);
		return Promise.reject(new GjcTurnCancelledError());
	}
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const cleanup = () => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			cleanup();
			reject(new GjcTurnCancelledError());
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			value => {
				cleanup();
				resolve(value);
			},
			error => {
				cleanup();
				reject(error);
			},
		);
		if (signal.aborted) onAbort();
	});
}
async function withSessionArtifactEvents(
	outcome: import("../gjc/public-sdk-contract").PublicSdkTurnOutcome,
	sessionFile: string | undefined,
	promptText: string,
): Promise<import("../gjc/public-sdk-contract").PublicSdkTurnOutcome> {
	if (hasNativeLifecycleEvents(outcome)) return outcome;
	const artifactEvents = await projectSessionArtifactEvents(sessionFile, promptText);
	if (artifactEvents.length === 0) return outcome;
	return mergeSessionArtifactEvents(outcome, artifactEvents);
}

export function mergeSessionArtifactEvents(
	outcome: import("../gjc/public-sdk-contract").PublicSdkTurnOutcome,
	artifactEvents: readonly { readonly type: string; readonly payload?: Readonly<Record<string, unknown>> }[],
): import("../gjc/public-sdk-contract").PublicSdkTurnOutcome {
	if (hasNativeLifecycleEvents(outcome)) return outcome;
	const projected = artifactEvents.map(event => ({
		type: event.type,
		...(event.payload === undefined ? {} : event.payload),
	}));
	const terminalIndex = outcome.events.findIndex(event =>
		["agent_end", "agent_failed", "action_needed"].includes(String(event.type)),
	);
	const insertionIndex = terminalIndex === -1 ? outcome.events.length : terminalIndex;
	return {
		...outcome,
		events: [...outcome.events.slice(0, insertionIndex), ...projected, ...outcome.events.slice(insertionIndex)],
	};
}
function hasNativeLifecycleEvents(outcome: import("../gjc/public-sdk-contract").PublicSdkTurnOutcome): boolean {
	return outcome.events.some(event => {
		const type = String(event.type);
		if (["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(type)) return true;
		if (type !== "message_update") return false;
		const payload = isRecord(event.payload) ? event.payload : event;
		const assistant = isRecord(payload.assistantMessageEvent) ? payload.assistantMessageEvent : undefined;
		return (
			typeof assistant?.type === "string" &&
			[
				"thinking_start",
				"thinking_delta",
				"reasoning_summary_delta",
				"thinking_end",
				"thinking",
				"tool_call",
				"toolcall_start",
				"toolcall_end",
			].includes(assistant.type)
		);
	});
}
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requireExactProvisionalProof(proof: import("../gjc/session-authority").SessionAttachmentProof): void {
	if (
		proof.tmuxSocket === undefined ||
		proof.tmuxPane === undefined ||
		proof.tmuxPanePid === undefined ||
		proof.tmuxOwnershipTag === undefined
	)
		throw new Error("New GJC session provisional authority requires an exact owned pane proof.");
}
