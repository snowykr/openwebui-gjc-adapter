import { resolve } from "node:path";
import type { PublicSdkSessionAttachment, PublicSdkSessionPort } from "../gjc/public-sdk-contract";
import { SdkV3OperationError } from "../gjc/sdk-v3-protocol";
import type { AcknowledgedSuccessor } from "../gjc/session-authority-types";
import { snapshotGjcSessionFiles } from "../gjc/session-loader";
import type { SessionMapping } from "../gjc/session-router";
import { type GjcControlResult, type GjcLifecycleTransaction, GjcTurnCancelledError } from "../gjc/turn-runner";
import type { LiveGatewayRunnerInput } from "./chat-completions";
import { OpenWebUIControlError } from "./chat-completions-types";
import {
	abortWithDispatch,
	awaitAbortDispatch,
	ensureAttachment,
	freshAttachmentProof,
	type OwnedAbortRegistration,
	withMutationPort,
} from "./gjc-public-sdk-session-ops";
import {
	discoverSuccessorSessionFile,
	endpointSuccessorProof,
	handoffAcknowledgedNewSessionSuccessor,
	retainedSuccessorPane,
	runBranchControl,
	successorAttachmentProof,
} from "./gjc-public-sdk-successor-authority";
import { attachmentKey, validatePersistedSessionIdentity } from "./gjc-routing-endpoints";
import type { PublicSdkRunnerContext } from "./gjc-routing-lifecycle";
import { attachmentProof, type SessionAttachment, turnResult } from "./gjc-routing-proof";
import { runLifecycleTestBarrier } from "./gjc-routing-test-barrier";
import { terminalAbortIdempotencyKey } from "./gjc-terminal-abort-key";

export async function runControl(
	context: PublicSdkRunnerContext,
	input: LiveGatewayRunnerInput,
	mapping: SessionMapping,
	lifecycle: GjcLifecycleTransaction,
	onAcknowledgedSuccessor?: (successor: AcknowledgedSuccessor) => Promise<void> | void,
	registerOwnedAbort?: OwnedAbortRegistration,
	onDispatch?: () => void,
): Promise<GjcControlResult> {
	const control = input.control;
	if (control === undefined) throw new Error("OpenWebUI control request was not supplied.");
	if (control.operation === "unsupported") throw new OpenWebUIControlError(control.surface);
	if (
		control.operation === "session.new" ||
		control.operation === "session.resume" ||
		control.operation === "session.switch"
	) {
		return runSessionControl(context, input, mapping, lifecycle, onAcknowledgedSuccessor, registerOwnedAbort);
	}
	if (control.operation === "branch") {
		const principalId =
			typeof input.ownerUserId === "string" && input.ownerUserId.trim().length > 0 ? input.ownerUserId : undefined;
		const terminalAbortKey = terminalAbortIdempotencyKey(input.chatId, input.userMessageId);
		let cancelled = false;
		let activePort: PublicSdkSessionPort | undefined;
		let rejectCancelled!: (error: Error) => void;
		const cancellation = new Promise<never>((_resolve, reject) => {
			rejectCancelled = reject;
		});
		let abortDispatch: ReturnType<typeof abortWithDispatch> | undefined;
		let branchOperation: Promise<GjcControlResult> | undefined;
		const dispatchAbort = (port: PublicSdkSessionPort): Promise<unknown> => {
			if (abortDispatch !== undefined) return abortDispatch.promise;
			abortDispatch = abortWithDispatch(port, terminalAbortKey, context.input.turnTimeoutMs);
			return abortDispatch.promise;
		};
		const registration = registerOwnedAbort?.(
			mappedAddress(input, mapping),
			principalId,
			input.userMessageId,
			async () => {
				cancelled = true;
				let abortRequest: Promise<unknown> | undefined;
				try {
					// The branch operation may still be between lifecycle phases. Without an
					// attached owner port there is no C04 dispatch to await; reject the local
					// race and let onPortAvailable dispatch once the owner is attached.
					if (activePort === undefined) return;
					abortRequest = dispatchAbort(activePort);
					await awaitAbortDispatch(abortRequest, abortDispatch?.dispatched);
				} finally {
					rejectCancelled(new GjcTurnCancelledError());
				}
			},
		);
		try {
			if (registration?.cancelled || input.signal?.aborted) throw new GjcTurnCancelledError();
			branchOperation = runBranchControl(
				context,
				input,
				mapping,
				lifecycle,
				async successor => {
					if (cancelled || input.signal?.aborted) throw new GjcTurnCancelledError();
					await onAcknowledgedSuccessor?.(successor);
					if (cancelled || input.signal?.aborted) throw new GjcTurnCancelledError();
				},
				async port => {
					activePort = port;
					if (cancelled) await awaitAbortDispatch(dispatchAbort(port), abortDispatch?.dispatched);
				},
				() => {
					if (cancelled || input.signal?.aborted) throw new GjcTurnCancelledError();
				},
			);
			const branched = await Promise.race([branchOperation, cancellation]);
			if (cancelled || input.signal?.aborted) throw new GjcTurnCancelledError();
			return branched;
		} finally {
			registration?.unregister();
			void branchOperation?.catch(() => undefined);
		}
	}
	const attachment = await ensureAttachment(context, mappedAddress(input, mapping), lifecycle);
	const idempotencyKey = `${input.chatId}:${input.userMessageId}`;
	const terminalAbortKey = terminalAbortIdempotencyKey(input.chatId, input.userMessageId);
	const principalId =
		typeof input.ownerUserId === "string" && input.ownerUserId.trim().length > 0 ? input.ownerUserId : undefined;
	const mutate = <T>(
		operation: (port: PublicSdkSessionPort, beforeDispatch: () => void, onDispatch: () => void) => Promise<T>,
	) =>
		withMutationPort(context, attachment, lifecycle, async port => {
			let cancelled = false;
			let operationDispatched = false;
			let rejectCancelled!: (error: Error) => void;
			const cancellation = new Promise<never>((_resolve, reject) => {
				rejectCancelled = reject;
			});
			const registration = registerOwnedAbort?.(
				mappedAddress(input, mapping),
				principalId,
				input.userMessageId,
				async () => {
					cancelled = true;
					if (!operationDispatched) {
						rejectCancelled(new GjcTurnCancelledError());
						return;
					}
					try {
						const abort = abortWithDispatch(port, terminalAbortKey, context.input.turnTimeoutMs);
						await awaitAbortDispatch(abort.promise, abort.dispatched);
					} finally {
						rejectCancelled(new GjcTurnCancelledError());
					}
				},
			);
			const beforeDispatch = () => {
				if (cancelled || input.signal?.aborted) throw new GjcTurnCancelledError();
			};
			const dispatch = () => {
				operationDispatched = true;
				onDispatch?.();
			};
			try {
				if (registration?.cancelled || input.signal?.aborted) throw new GjcTurnCancelledError();
				return await Promise.race([operation(port, beforeDispatch, dispatch), cancellation]);
			} finally {
				registration?.unregister();
			}
		});
	if (control.operation === "abort") {
		await mutate((port, beforeDispatch, dispatch) =>
			port.abort(terminalAbortKey, context.input.turnTimeoutMs, dispatch, beforeDispatch),
		);
		return { attachment: await freshAttachmentProof(input.project.cwd, attachment, lifecycle) };
	}
	if (control.operation === "steer") {
		await mutate((port, beforeDispatch, dispatch) =>
			port.steer(
				control.text ?? input.prompt,
				idempotencyKey,
				context.input.turnTimeoutMs,
				dispatch,
				beforeDispatch,
			),
		);
		return { attachment: await freshAttachmentProof(input.project.cwd, attachment, lifecycle) };
	}
	if (control.operation === "follow_up" || control.operation === "abort_and_prompt") {
		const outcome = await mutate((port, beforeDispatch, dispatch) =>
			control.operation === "follow_up"
				? port.followUp(
						control.text ?? input.prompt,
						idempotencyKey,
						context.input.turnTimeoutMs,
						undefined,
						dispatch,
						beforeDispatch,
					)
				: port.abortAndPrompt(
						control.text ?? input.prompt,
						idempotencyKey,
						context.input.turnTimeoutMs,
						undefined,
						dispatch,
						beforeDispatch,
					),
		);
		return {
			result: turnResult(
				outcome,
				mapping.sessionFile,
				undefined,
				await freshAttachmentProof(input.project.cwd, attachment, lifecycle),
			),
		};
	}
	if (control.operation === "action_reply") {
		await mutate((port, beforeDispatch, dispatch) =>
			port.replyToAction(
				control.actionId,
				control.answer,
				idempotencyKey,
				context.input.turnTimeoutMs,
				dispatch,
				beforeDispatch,
			),
		);
		return { attachment: await freshAttachmentProof(input.project.cwd, attachment, lifecycle) };
	}
	if (control.operation !== "workflow.plan_approve")
		throw new Error(`Unsupported OpenWebUI control surface: ${control.operation}.`);
	await mutate((port, beforeDispatch, dispatch) =>
		port.planApprove(control.input, idempotencyKey, context.input.turnTimeoutMs, dispatch, beforeDispatch),
	);
	return { attachment: await freshAttachmentProof(input.project.cwd, attachment, lifecycle) };
}

async function runSessionControl(
	context: PublicSdkRunnerContext,
	input: LiveGatewayRunnerInput,
	mapping: SessionMapping,
	lifecycle: GjcLifecycleTransaction,
	onAcknowledgedSuccessor?: (successor: AcknowledgedSuccessor) => Promise<void> | void,
	registerOwnedAbort?: OwnedAbortRegistration,
): Promise<GjcControlResult> {
	const control = input.control;
	if (
		control === undefined ||
		(control.operation !== "session.new" &&
			control.operation !== "session.resume" &&
			control.operation !== "session.switch")
	) {
		throw new Error("OpenWebUI session control request was not supplied.");
	}
	const sessionRoot = resolve(input.project.sessionRoot ?? `${input.project.cwd}/.gjc/sessions`);
	const attachment = await ensureAttachment(context, mappedAddress(input, mapping, sessionRoot), lifecycle);
	const isNewSession = control.operation === "session.new";
	const baseline = isNewSession ? await snapshotGjcSessionFiles(sessionRoot) : undefined;
	let sessionTarget: { readonly sessionId: string; readonly sessionFile: string } | undefined;
	if (control.operation !== "session.new") {
		const sessionFile = control.sessionFile;
		if (sessionFile === undefined)
			throw new SdkV3OperationError(
				"endpoint_stale",
				"A persisted GJC session file is required for lifecycle target authority",
			);
		sessionTarget = { sessionId: control.sessionId, sessionFile };
		await validatePersistedSessionIdentity({
			cwd: resolve(input.project.cwd),
			sessionRoot,
			projectId: mapping.projectId,
			chatId: mapping.chatId,
			sessionId: sessionTarget.sessionId,
			sessionFile: sessionTarget.sessionFile,
		});
	}
	const target = sessionTarget;
	const key = `${input.chatId}:${input.userMessageId}`;
	const terminalAbortKey = terminalAbortIdempotencyKey(input.chatId, input.userMessageId);
	const principalId =
		typeof input.ownerUserId === "string" && input.ownerUserId.trim().length > 0 ? input.ownerUserId : undefined;
	let cancelled = false;
	let rejectCancelled!: (error: Error) => void;
	const cancellation = new Promise<never>((_resolve, reject) => {
		rejectCancelled = reject;
	});
	let unregisterOwnedAbort: (() => void) | undefined;
	const acknowledgeDiscoveredSuccessor = async (successor: PublicSdkSessionAttachment) => {
		if (cancelled || input.signal?.aborted) throw new GjcTurnCancelledError();
		await onAcknowledgedSuccessor?.({
			sessionId: successor.sessionId,
			attachment: endpointSuccessorProof(attachmentProof(successor, {})),
		});
		if (cancelled || input.signal?.aborted) throw new GjcTurnCancelledError();
	};
	try {
		const mutation = withMutationPort(context, attachment, lifecycle, async port => {
			const registration = registerOwnedAbort?.(
				mappedAddress(input, mapping, sessionRoot),
				principalId,
				input.userMessageId,
				async () => {
					cancelled = true;
					try {
						const abort = abortWithDispatch(port, terminalAbortKey, context.input.turnTimeoutMs);
						await awaitAbortDispatch(abort.promise, abort.dispatched);
					} finally {
						rejectCancelled(new GjcTurnCancelledError());
					}
				},
			);
			unregisterOwnedAbort = registration?.unregister;
			if (registration?.cancelled || input.signal?.aborted) throw new GjcTurnCancelledError();
			let operation: Promise<PublicSdkSessionAttachment>;
			if (control.operation === "session.new") {
				operation = port.newSession({}, key, context.input.turnTimeoutMs, acknowledgeDiscoveredSuccessor);
			} else if (target === undefined) {
				throw new SdkV3OperationError(
					"endpoint_stale",
					"A persisted GJC session file is required for lifecycle target authority",
				);
			} else if (control.operation === "session.resume") {
				operation = port.resumeSession(
					{ sessionId: target.sessionId, sessionPath: target.sessionFile },
					key,
					context.input.turnTimeoutMs,
				);
			} else {
				operation = port.switchSession(
					{ sessionId: target.sessionId, sessionPath: target.sessionFile },
					key,
					context.input.turnTimeoutMs,
				);
			}
			return await Promise.race([operation, cancellation]);
		});
		const successor = await Promise.race([mutation, cancellation]);
		if (cancelled || input.signal?.aborted) throw new GjcTurnCancelledError();
		if (
			successor.cwd !== resolve(input.project.cwd) ||
			(isNewSession && successor.sessionId === attachment.sessionId) ||
			(!isNewSession && successor.sessionId !== target?.sessionId)
		)
			throw new SdkV3OperationError(
				"endpoint_stale",
				"Lifecycle operation did not bind to the expected successor in the mapped workspace",
			);
		const successorProof = await Promise.race([
			successorAttachmentProof(context, attachment, successor),
			cancellation,
		]);
		if (cancelled || input.signal?.aborted) throw new GjcTurnCancelledError();
		if (isNewSession) {
			await Promise.race([
				handoffAcknowledgedNewSessionSuccessor(
					lifecycle,
					{ cwd: input.project.cwd, sessionRoot, chatId: mapping.chatId },
					mapping,
					successor,
					successorProof,
				),
				cancellation,
			]);
			await Promise.race([
				runLifecycleTestBarrier(context.input.testBarrierHook, "post_ack_pre_transcript", successor),
				cancellation,
			]);
		}
		const sessionFile = isNewSession
			? await Promise.race([
					discoverSuccessorSessionFile(
						sessionRoot,
						baseline ?? new Set<string>(),
						successor.sessionId,
						input.project.cwd,
					),
					cancellation,
				])
			: target?.sessionFile;
		if (sessionFile === undefined)
			throw new SdkV3OperationError(
				"endpoint_stale",
				"A persisted GJC session file is required for lifecycle target authority",
			);
		if (cancelled || input.signal?.aborted) throw new GjcTurnCancelledError();
		await Promise.race([
			validatePersistedSessionIdentity({
				cwd: input.project.cwd,
				sessionRoot,
				projectId: mapping.projectId,
				chatId: mapping.chatId,
				sessionId: successor.sessionId,
				sessionFile,
			}),
			cancellation,
		]);
		if (cancelled || input.signal?.aborted) throw new GjcTurnCancelledError();
		const retainedPane = retainedSuccessorPane(attachment, successorProof);
		const successorAttachment: SessionAttachment = {
			cwd: resolve(input.project.cwd),
			sessionRoot,
			projectId: mapping.projectId,
			sessionId: successor.sessionId,
			sessionPath: sessionFile,
			published: successor,
			...(retainedPane === undefined ? {} : { pane: retainedPane }),
		};
		const proof = successorProof;
		const address = {
			cwd: input.project.cwd,
			sessionRoot,
			projectId: mapping.projectId,
			chatId: mapping.chatId,
			sessionId: successor.sessionId,
			sessionFile,
			recoveryAttachment: proof,
		};
		if (cancelled || input.signal?.aborted) throw new GjcTurnCancelledError();
		context.attachments.set(attachmentKey(address), successorAttachment);
		try {
			await Promise.race([lifecycle.handoff(address, proof), cancellation]);
		} catch (error) {
			if (cancelled || input.signal?.aborted) context.attachments.delete(attachmentKey(address));
			throw error;
		}
		if (cancelled || input.signal?.aborted) {
			context.attachments.delete(attachmentKey(address));
			throw new GjcTurnCancelledError();
		}
		return { sessionId: successor.sessionId, sessionFile, attachment: proof };
	} finally {
		unregisterOwnedAbort?.();
	}
}

function mappedAddress(
	input: LiveGatewayRunnerInput,
	mapping: SessionMapping,
	sessionRoot = input.project.sessionRoot ?? `${input.project.cwd}/.gjc/sessions`,
) {
	return {
		cwd: input.project.cwd,
		sessionRoot,
		projectId: mapping.projectId,
		recoveryAttachment: mapping.attachment,
		chatId: mapping.chatId,
		sessionId: mapping.sessionId,
		sessionFile: mapping.sessionFile,
	};
}
