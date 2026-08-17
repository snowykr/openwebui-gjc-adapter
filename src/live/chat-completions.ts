import { randomUUID } from "node:crypto";
import { GjcTurnCancelledError } from "../gjc/turn-runner";
import { resolveForwardedPrincipal } from "../openwebui/auth";
import { parseOpenWebUIHeaders } from "../openwebui/headers";
import type { WorkspaceLease } from "../security/workspace-lease";
import { deliverChatCompletion } from "./chat-completion-delivery";
import {
	type HandleChatCompletionsInput,
	type LiveChatCompletionsResult,
	type LiveGatewayRunnerResult,
	LiveGatewayUnavailableError,
	OpenWebUIControlError,
	WorkflowGateReplyError,
} from "./chat-completions-types";
import { latestUserText } from "./chat-content";
import { controlFromMetadata } from "./chat-control-metadata";
import { deliverRunnerEvents } from "./chat-delivery";
import { buildCompletion, buildOpenAIErrorResponse } from "./chat-response-format";
import { appendResolvedFileContexts } from "./file-contexts";
import { ModelSelectionError, modelSelectionError } from "./model-selection-errors";
import { createModelSelectionPolicy } from "./model-selection-policy";
import { classifyGjcModelId, formatCanonicalModelId, normalizeOpenWebUIModelId } from "./models";
import { resolveLiveProjectContext } from "./project-context";

export type {
	HandleChatCompletionsInput,
	LiveChatCompletionsResult,
	LiveGatewayRunner,
	LiveGatewayRunnerInput,
	LiveGatewayRunnerResult,
} from "./chat-completions-types";
export type { LiveGatewayEventDeliveryInput, LiveGatewayEventSink, LiveGatewayMessageSink } from "./chat-delivery";
export { LiveGatewayUnavailableError, WorkflowGateReplyError };

export async function handleChatCompletions(input: HandleChatCompletionsInput): Promise<LiveChatCompletionsResult> {
	const headers = parseOpenWebUIHeaders(input.headers);
	if (!headers.ok) {
		return errorResult(
			400,
			"invalid_request_error",
			"invalid_openwebui_headers",
			headers.errors.map(error => error.message).join("; "),
		);
	}

	const principalResolution =
		input.principal === undefined
			? resolveForwardedPrincipal(input.owner, headers.userId)
			: { ok: true as const, principal: input.principal };
	if (!principalResolution.ok) {
		return errorResult(
			401,
			"authentication_error",
			principalResolution.reason,
			"A non-empty forwarded OpenWebUI user ID is required.",
		);
	}
	const principal = principalResolution.principal;
	const workspace =
		principal.role === "user"
			? await raceWithAbort(() => input.workspaceRegistry?.open(principal.userId), input.signal)
			: undefined;
	if (principal.role === "user" && workspace === undefined) {
		throwIfAborted(input.signal);
		return errorResult(
			503,
			"server_error",
			"workspace_unavailable",
			"Private OpenWebUI workspace could not be prepared.",
		);
	}

	const created = Math.floor((input.now ?? new Date()).getTime() / 1000);
	const id = input.idFactory?.() ?? `chatcmpl-${created}`;
	const requestedModelId = normalizeOpenWebUIModelId(input.request.model);
	const classifiedModel = classifyGjcModelId(requestedModelId);
	if (classifiedModel.kind === "malformed")
		return selectionErrorResult(modelSelectionError("model_selection_invalid_id"));
	if (classifiedModel.kind === "foreign")
		return selectionErrorResult(modelSelectionError("model_not_found", input.request.model));

	if (headers.isBackgroundTask) {
		let backgroundLease: WorkspaceLeaseAdmission | undefined;
		try {
			if (input.modelReaderFactory === undefined) {
				throw modelSelectionError(
					classifiedModel.kind === "canonical"
						? "model_selection_not_available"
						: "model_selection_default_read_failed",
				);
			}
			const sourceModelReaderFactory = input.modelReaderFactory;
			if (principal.role === "user") {
				if (workspace === undefined || input.workspaceLeaseManager === undefined) {
					throwIfAborted(input.signal);
					return workspaceLeaseErrorResult();
				}
				try {
					backgroundLease = await acquireWorkspaceLease(input, workspace.safeKey);
				} catch (error) {
					if (isWorkspaceAdmissionCancelledError(error)) throw error;
					throwIfAborted(input.signal);
					// A busy workspace is retryable, not a missing/bad model.
					return workspaceLeaseErrorResult();
				}
			}
			const modelReaderFactory =
				principal.role === "user"
					? (_context?: unknown, signal?: AbortSignal) =>
							sourceModelReaderFactory(
								{
									principal,
									workspace,
									lease: backgroundLease,
									correlationId: `background:${headers.chatId}`,
								},
								signal,
							)
					: sourceModelReaderFactory;
			const selection = await createModelSelectionPolicy(modelReaderFactory).resolve(requestedModelId, input.signal);
			throwIfAborted(input.signal);
			await assertWorkspaceLease(backgroundLease);
			return await finishWorkspaceLeaseWithCancellation(
				backgroundLease,
				{
					ok: true,
					status: 200,
					body: buildCompletion({
						id,
						created,
						model: formatCanonicalModelId(selection),
						content: "",
						metadata: { task: headers.task, noop: true },
					}),
				},
				input.signal,
			);
		} catch (error) {
			if (isWorkspaceAdmissionCancelledError(error)) throw error;
			if (error instanceof GjcTurnCancelledError) {
				await closeWorkspaceLease(backgroundLease);
				throw error;
			}
			if (error instanceof WorkspaceLeaseUncertainError) {
				return await finishWorkspaceLeaseWithCancellation(
					backgroundLease,
					workspaceLeaseErrorResult(),
					input.signal,
				);
			}
			const result =
				error instanceof ModelSelectionError
					? selectionErrorResult(error)
					: selectionErrorResult(
							modelSelectionError(
								classifiedModel.kind === "canonical"
									? "model_selection_not_available"
									: "model_selection_default_read_failed",
							),
						);
			return await finishWorkspaceLeaseWithCancellation(backgroundLease, result, input.signal);
		}
	}

	if (!Array.isArray(input.request.messages)) {
		return errorResult(
			400,
			"invalid_request_error",
			"invalid_request_body",
			"Request body must include a messages array.",
		);
	}

	const latestPrompt = latestUserText(input.request.messages, input.request.files);
	if (latestPrompt === null) {
		return errorResult(
			400,
			"invalid_request_error",
			"missing_user_message",
			"A chat completion requires a user message with text content.",
		);
	}

	let leaseAdmission: WorkspaceLeaseAdmission | undefined;
	if (principal.role === "user") {
		if (workspace === undefined || input.workspaceLeaseManager === undefined) {
			throwIfAborted(input.signal);
			return workspaceLeaseErrorResult();
		}
		try {
			leaseAdmission = await acquireWorkspaceLease(input, workspace.safeKey);
		} catch (error) {
			if (isWorkspaceAdmissionCancelledError(error)) throw error;
			throwIfAborted(input.signal);
			return workspaceLeaseErrorResult();
		}
	}

	let runnerResult: LiveGatewayRunnerResult | undefined;
	try {
		const projects =
			principal.role === "admin" && input.projectProvider !== undefined
				? await raceWithAbort(() => input.projectProvider!(), input.signal)
				: input.projects;
		const projectContext = await raceWithAbort(
			() =>
				resolveLiveProjectContext({
					projects,
					modelId: requestedModelId,
					ownerUserId: principal.userId,
					chatId: headers.chatId,
					repository: input.projectContextRepository,
					neutralWorkspace: workspace?.root ?? input.neutralWorkspace,
					allowFolderProject: principal.role === "admin",
					now: input.now,
				}),
			input.signal,
		);
		if (!projectContext.ok) {
			throwIfAborted(input.signal);
			const finished = await finishWorkspaceLeaseWithCancellation(
				leaseAdmission,
				errorResult(503, "server_error", projectContext.code, projectContext.message),
				input.signal,
			);
			return finished;
		}
		const project = projectContext.project;
		let prompt: string;
		try {
			prompt = await raceWithAbort(
				() =>
					appendResolvedFileContexts({
						prompt: latestPrompt,
						messages: input.request.messages,
						files: input.request.files,
						project,
						chatId: headers.chatId,
						userMessageId: headers.userMessageId,
						resolver: input.fileContextResolver,
						ownerUserId: principal.userId,
					}),
				input.signal,
			);
		} catch {
			throwIfAborted(input.signal);
			const finished = await finishWorkspaceLeaseWithCancellation(
				leaseAdmission,
				errorResult(
					503,
					"server_error",
					"attachment_resolution_failed",
					"OpenWebUI attachment files could not be resolved.",
				),
				input.signal,
			);
			return finished;
		}

		await assertWorkspaceLease(leaseAdmission);
		throwIfAborted(input.signal);
		let liveEventsDelivered = false;
		const guardedEventSink =
			input.eventSink === undefined
				? undefined
				: async (event: Parameters<NonNullable<typeof input.eventSink>>[0]) => {
						await assertWorkspaceLease(leaseAdmission);
						await input.eventSink?.(event);
					};
		runnerResult = await input.runner.run({
			project,
			prompt,
			chatId: headers.chatId,
			messageId: headers.messageId,
			userMessageId: headers.userMessageId,
			userMessageParentId: headers.userMessageParentId,
			continued: headers.userMessageParentId !== null,
			requestedModelId,
			ownerUserId: principal.userId,
			...(workspace === undefined
				? {}
				: {
						modelReaderContext: {
							principal,
							workspace,
							...(leaseAdmission === undefined ? {} : { lease: leaseAdmission }),
							correlationId: `${headers.chatId}:${headers.userMessageId}`,
						},
					}),
			...(input.request.metadata === undefined ? {} : { messageMetadata: input.request.metadata }),
			...(controlFromMetadata(input.request.metadata) === undefined
				? {}
				: { control: controlFromMetadata(input.request.metadata) }),
			...(input.eventSink === undefined || input.request.stream !== true
				? {}
				: {
						onLiveEvents: async events => {
							if (events.length === 0) return;
							await assertWorkspaceLease(leaseAdmission);
							await guardedEventSink?.({
								chatId: headers.chatId,
								messageId: headers.messageId,
								ownerUserId: principal.userId,
								projectId: project.id,
								events,
							});
							liveEventsDelivered = true;
						},
					}),
			...(input.signal === undefined ? {} : { signal: input.signal }),
		});
		// A stream owns lease finalization after the runner hands its result to the
		// response. If the heartbeat fails while that result is being prepared,
		// preserve the stream handoff so the stream wrapper can retain admission
		// until the caller abandons it and then fail closed before yielding data.
		await assertWorkspaceLeaseForStreamHandoff(leaseAdmission, input.request.stream === true);
		throwIfAborted(input.signal);

		const resultModel = runnerResult.model;
		if (resultModel === undefined || classifyGjcModelId(resultModel).kind !== "canonical") {
			await abandonRunnerResult(runnerResult);
			runnerResult = undefined;
			return finishWorkspaceLease(
				leaseAdmission,
				errorResult(
					503,
					"server_error",
					"live_runner_error",
					"GJC live runner returned an invalid model selection.",
				),
			);
		}

		const guardedMessageSink =
			input.messageSink === undefined
				? undefined
				: async (message: Parameters<NonNullable<typeof input.messageSink>>[0]) => {
						await assertWorkspaceLease(leaseAdmission);
						await input.messageSink?.(message);
					};
		await deliverRunnerEvents({
			eventSink: guardedEventSink,
			events: input.request.stream === true && liveEventsDelivered ? undefined : runnerResult.events,
			chatId: headers.chatId,
			messageId: headers.messageId,
			ownerUserId: principal.userId,
			projectId: project.id,
		});
		await assertWorkspaceLeaseForStreamHandoff(leaseAdmission, input.request.stream === true);
		throwIfAborted(input.signal);

		const completion = await deliverChatCompletion({
			stream: input.request.stream === true,
			runnerResult,
			id,
			created,
			model: resultModel,
			messageSink: guardedMessageSink,
			chatId: headers.chatId,
			messageId: headers.messageId,
			ownerUserId: principal.userId,
			projectId: project.id,
		});
		throwIfAborted(input.signal);
		if ("stream" in completion) {
			const stream =
				leaseAdmission === undefined
					? completion.stream
					: manageWorkspaceLeaseStream(completion.stream, leaseAdmission);
			runnerResult = undefined;
			return { ...completion, stream };
		}
		runnerResult = undefined;
		const finished = await finishWorkspaceLease(leaseAdmission, completion);
		throwIfAborted(input.signal);
		return finished;
	} catch (error) {
		if (runnerResult !== undefined) {
			await abandonRunnerResult(runnerResult);
			runnerResult = undefined;
		}
		const leaseClosed = await closeWorkspaceLease(leaseAdmission);
		if (leaseAdmission !== undefined && (!leaseClosed || leaseAdmission.failed)) return workspaceLeaseErrorResult();
		if (isWorkspaceAdmissionCancelledError(error)) throw error;
		if (error instanceof WorkspaceLeaseUncertainError) return workspaceLeaseErrorResult();
		if (error instanceof LiveGatewayUnavailableError)
			return errorResult(503, "server_error", error.code, error.message);
		if (error instanceof OpenWebUIControlError)
			return errorResult(400, "invalid_request_error", error.code, error.message);
		if (error instanceof WorkflowGateReplyError)
			return errorResult(400, "invalid_request_error", error.code, error.message);
		if (error instanceof ModelSelectionError) return selectionErrorResult(error);
		throw error;
	}
}
const DEFAULT_WORKSPACE_LEASE_DURATION_MS = 210_000;
const DEFAULT_WORKSPACE_ADMISSION_QUEUE_LIMIT = 32;
const DEFAULT_WORKSPACE_ADMISSION_TIMEOUT_MS = DEFAULT_WORKSPACE_LEASE_DURATION_MS;

export function isWorkspaceLeaseUncertainError(error: unknown): boolean {
	return (
		error instanceof WorkspaceLeaseUncertainError ||
		(error instanceof Error && error.name === "WorkspaceLeaseUncertainError")
	);
}
function isWorkspaceAdmissionCancelledError(error: unknown): boolean {
	return (
		error instanceof WorkspaceAdmissionCancelledError ||
		(error instanceof Error && error.name === "WorkspaceAdmissionCancelledError")
	);
}
class WorkspaceLeaseUncertainError extends Error {
	constructor() {
		super("Workspace lease admission is uncertain.");
		this.name = "WorkspaceLeaseUncertainError";
	}
}
class WorkspaceAdmissionCancelledError extends Error {
	constructor() {
		super("Workspace lease admission was cancelled.");
		this.name = "WorkspaceAdmissionCancelledError";
	}
}

class WorkspaceLeaseAdmission {
	#lease: WorkspaceLease;
	readonly #durationMs: number;
	#heartbeat: ReturnType<typeof setInterval> | undefined;
	#renewal: Promise<void> | undefined;
	#finishPromise: Promise<boolean> | undefined;
	#releaseAdmission: (() => void) | undefined;
	#failure = false;
	#stopping = false;

	constructor(lease: WorkspaceLease, durationMs: number, heartbeatMs: number, releaseAdmission: () => void) {
		this.#lease = lease;
		this.#durationMs = durationMs;
		this.#heartbeat = setInterval(() => this.#scheduleRenewal(), heartbeatMs);
		this.#releaseAdmission = releaseAdmission;
		(this.#heartbeat as unknown as { unref?: () => void }).unref?.();
	}

	get failed(): boolean {
		return this.#failure;
	}

	async assertFence(): Promise<void> {
		if (this.failed) throw new WorkspaceLeaseUncertainError();
		try {
			await this.#lease.assertFence();
		} catch (error) {
			this.#markFailure(error);
			throw new WorkspaceLeaseUncertainError();
		}
		if (this.failed) throw new WorkspaceLeaseUncertainError();
	}

	async finish(): Promise<boolean> {
		if (this.#finishPromise === undefined) this.#finishPromise = this.#finish();
		return this.#finishPromise;
	}

	async #finish(): Promise<boolean> {
		try {
			this.#stopping = true;
			if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat);
			if (this.#renewal !== undefined) await this.#renewal;
			let healthy = true;
			try {
				await this.#lease.assertFence();
			} catch (error) {
				this.#markFailure(error);
				healthy = false;
			}
			try {
				await this.#lease.release();
			} catch {
				healthy = false;
			}
			return healthy && !this.#failure;
		} finally {
			const releaseAdmission = this.#releaseAdmission;
			this.#releaseAdmission = undefined;
			releaseAdmission?.();
		}
	}

	#scheduleRenewal(): void {
		if (this.#stopping || this.failed || this.#renewal !== undefined) return;
		const renewal = this.#renew();
		this.#renewal = renewal;
		void renewal.then(
			() => {
				if (this.#renewal === renewal) this.#renewal = undefined;
			},
			() => {
				if (this.#renewal === renewal) this.#renewal = undefined;
			},
		);
	}

	async #renew(): Promise<void> {
		try {
			this.#lease = await this.#lease.renew(this.#durationMs);
		} catch (error) {
			this.#markFailure(error);
		}
	}

	#markFailure(_error: unknown): void {
		if (this.#failure) return;
		this.#failure = true;
	}
}
type WorkspaceAdmissionWaiter = {
	readonly resolve: (release: () => void) => void;
	readonly reject: (error: Error) => void;
	readonly signal?: AbortSignal;
	onAbort?: () => void;
	timer: ReturnType<typeof setTimeout>;
	settled: boolean;
};

class WorkspaceAdmissionGate {
	#queue: WorkspaceAdmissionWaiter[] = [];
	#queued = 0;
	#active = false;

	constructor(readonly onIdle: () => void) {}

	async acquire(timeoutMs: number, queueLimit: number, signal?: AbortSignal): Promise<() => void> {
		if (signal?.aborted) throw new WorkspaceAdmissionCancelledError();
		if (this.#queued >= queueLimit) throw new WorkspaceLeaseUncertainError();
		this.#queued += 1;
		const result = new Promise<() => void>((resolve, reject) => {
			const waiter: WorkspaceAdmissionWaiter = {
				resolve,
				reject,
				signal,
				onAbort: undefined,
				timer: undefined as unknown as ReturnType<typeof setTimeout>,
				settled: false,
			};
			const onAbort = () => this.#cancel(waiter, true);
			waiter.onAbort = onAbort;
			waiter.timer = setTimeout(() => this.#cancel(waiter), timeoutMs);
			(waiter.timer as unknown as { unref?: () => void }).unref?.();
			signal?.addEventListener("abort", onAbort, { once: true });
			this.#queue.push(waiter);
			if (signal?.aborted) this.#cancel(waiter, true);
		});
		this.#pump();
		return result;
	}

	#pump(): void {
		if (this.#active) return;
		const waiter = this.#queue.shift();
		if (waiter === undefined) {
			if (this.#queued === 0) this.onIdle();
			return;
		}
		if (waiter.settled) {
			this.#pump();
			return;
		}
		waiter.settled = true;
		clearTimeout(waiter.timer);
		waiter.signal?.removeEventListener("abort", waiter.onAbort!);
		this.#active = true;
		let released = false;
		waiter.resolve(() => {
			if (released) return;
			released = true;
			this.#active = false;
			this.#queued -= 1;
			this.#pump();
		});
	}

	#cancel(waiter: WorkspaceAdmissionWaiter, cancelled = false): void {
		if (waiter.settled) return;
		waiter.settled = true;
		clearTimeout(waiter.timer);
		waiter.signal?.removeEventListener("abort", waiter.onAbort!);
		const index = this.#queue.indexOf(waiter);
		if (index === -1) return;
		this.#queue.splice(index, 1);
		this.#queued -= 1;
		waiter.reject(cancelled ? new WorkspaceAdmissionCancelledError() : new WorkspaceLeaseUncertainError());
		if (this.#queued === 0) this.onIdle();
	}
}

const workspaceAdmissionGates = new WeakMap<object, Map<string, WorkspaceAdmissionGate>>();

function workspaceAdmissionGateFor(manager: object, safeKey: string): WorkspaceAdmissionGate {
	let gates = workspaceAdmissionGates.get(manager);
	if (gates === undefined) {
		gates = new Map();
		workspaceAdmissionGates.set(manager, gates);
	}
	let gate = gates.get(safeKey);
	if (gate === undefined) {
		gate = new WorkspaceAdmissionGate(() => {
			if (gates?.get(safeKey) === gate) gates.delete(safeKey);
		});
		gates.set(safeKey, gate);
	}
	return gate;
}

/** Acquires the same-process workspace admission queue for a normal-user operation. */
export async function acquireWorkspaceAdmission(
	manager: object,
	safeKey: string,
	timeoutMs: number,
	queueLimit: number,
	signal?: AbortSignal,
): Promise<() => void> {
	return workspaceAdmissionGateFor(manager, safeKey).acquire(timeoutMs, queueLimit, signal);
}

async function acquireWorkspaceLease(
	input: HandleChatCompletionsInput,
	safeKey: string,
): Promise<WorkspaceLeaseAdmission> {
	if (input.workspaceLeaseManager === undefined) throw new WorkspaceLeaseUncertainError();
	const durationMs = resolveWorkspaceLeaseDuration(input.workspaceLeaseDurationMs);
	const heartbeatMs = resolveWorkspaceLeaseHeartbeat(input.workspaceLeaseHeartbeatMs, durationMs);
	const timeoutMs = resolveWorkspaceAdmissionTimeout(input.workspaceAdmissionTimeoutMs ?? durationMs);
	const queueLimit = resolveWorkspaceAdmissionQueueLimit(input.workspaceAdmissionQueueLimit);
	const releaseAdmission = await acquireWorkspaceAdmission(
		input.workspaceLeaseManager,
		safeKey,
		timeoutMs,
		queueLimit,
		input.signal,
	);
	try {
		if (input.signal?.aborted) throw new WorkspaceAdmissionCancelledError();
		const lease = await input.workspaceLeaseManager.acquire({
			safeKey,
			holderId: `gjc-turn-${process.pid}-${randomUUID()}`,
			operation: "turn",
			leaseMs: durationMs,
		});
		if (lease === undefined) throw new WorkspaceLeaseUncertainError();
		const admission = new WorkspaceLeaseAdmission(lease, durationMs, heartbeatMs, releaseAdmission);
		if (input.signal?.aborted) {
			if (!(await admission.finish())) throw new WorkspaceLeaseUncertainError();
			throw new WorkspaceAdmissionCancelledError();
		}
		return admission;
	} catch (error) {
		releaseAdmission();
		throw error;
	}
}
function resolveWorkspaceAdmissionTimeout(value: number | undefined): number {
	const timeoutMs = value ?? DEFAULT_WORKSPACE_ADMISSION_TIMEOUT_MS;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new WorkspaceLeaseUncertainError();
	return timeoutMs;
}

function resolveWorkspaceAdmissionQueueLimit(value: number | undefined): number {
	const queueLimit = value ?? DEFAULT_WORKSPACE_ADMISSION_QUEUE_LIMIT;
	if (!Number.isSafeInteger(queueLimit) || queueLimit <= 0) throw new WorkspaceLeaseUncertainError();
	return queueLimit;
}

function resolveWorkspaceLeaseDuration(value: number | undefined): number {
	const durationMs = value ?? DEFAULT_WORKSPACE_LEASE_DURATION_MS;
	if (!Number.isSafeInteger(durationMs) || durationMs <= 0) throw new WorkspaceLeaseUncertainError();
	return durationMs;
}

function resolveWorkspaceLeaseHeartbeat(value: number | undefined, durationMs: number): number {
	const heartbeatMs = value ?? Math.max(1, Math.floor(durationMs / 4));
	if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs <= 0 || heartbeatMs * 3 >= durationMs)
		throw new WorkspaceLeaseUncertainError();
	return heartbeatMs;
}

async function assertWorkspaceLease(admission: WorkspaceLeaseAdmission | undefined): Promise<void> {
	await admission?.assertFence();
}

async function assertWorkspaceLeaseForStreamHandoff(
	admission: WorkspaceLeaseAdmission | undefined,
	streaming: boolean,
): Promise<void> {
	if (!streaming) {
		await assertWorkspaceLease(admission);
		return;
	}
	if (admission?.failed) return;
	try {
		await assertWorkspaceLease(admission);
	} catch (error) {
		if (!isWorkspaceLeaseUncertainError(error)) throw error;
	}
}

async function finishWorkspaceLease(
	admission: WorkspaceLeaseAdmission | undefined,
	result: LiveChatCompletionsResult,
): Promise<LiveChatCompletionsResult> {
	if (admission === undefined) return result;
	if (!(await admission.finish())) return workspaceLeaseErrorResult();
	return result;
}

async function finishWorkspaceLeaseWithCancellation(
	admission: WorkspaceLeaseAdmission | undefined,
	result: LiveChatCompletionsResult,
	signal?: AbortSignal,
): Promise<LiveChatCompletionsResult> {
	throwIfAborted(signal);
	const finished = await finishWorkspaceLease(admission, result);
	throwIfAborted(signal);
	return finished;
}

async function closeWorkspaceLease(admission: WorkspaceLeaseAdmission | undefined): Promise<boolean> {
	if (admission === undefined) return true;
	return admission.finish();
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new GjcTurnCancelledError();
}

function raceWithAbort<T>(operation: () => Promise<T> | T, signal?: AbortSignal): Promise<T> {
	if (signal?.aborted) return Promise.reject(new GjcTurnCancelledError());
	let promise: Promise<T>;
	try {
		promise = Promise.resolve(operation());
	} catch (error) {
		promise = Promise.reject(error);
	}
	if (signal === undefined) return promise;
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
				if (signal.aborted) {
					reject(new GjcTurnCancelledError());
					return;
				}
				resolve(value);
			},
			error => {
				cleanup();
				reject(signal.aborted ? new GjcTurnCancelledError() : error);
			},
		);
		if (signal.aborted) onAbort();
	});
}

function workspaceLeaseErrorResult(): LiveChatCompletionsResult {
	return errorResult(
		503,
		"server_error",
		"workspace_lease_uncertain",
		"Workspace operation is temporarily unavailable.",
	);
}

function manageWorkspaceLeaseStream(
	source: AsyncIterable<string>,
	admission: WorkspaceLeaseAdmission,
): AsyncIterable<string> & { abandon: () => Promise<void> } {
	const sourceAbandon =
		"abandon" in source && typeof source.abandon === "function" ? source.abandon.bind(source) : undefined;
	let finalization: Promise<void> | undefined;
	let sourceCompleted = false;
	const complete = (): Promise<void> => {
		if (finalization === undefined) {
			finalization = (async () => {
				if (!(await admission.finish())) throw new WorkspaceLeaseUncertainError();
			})();
		}
		return finalization;
	};
	const abandon = (): Promise<void> => {
		if (finalization === undefined) {
			finalization = (async () => {
				let sourceFailure: unknown;
				try {
					await sourceAbandon?.();
				} catch (error) {
					sourceFailure = error;
				}
				const released = await admission.finish();
				if (sourceFailure !== undefined) throw sourceFailure;
				if (!released) throw new WorkspaceLeaseUncertainError();
			})();
		}
		return finalization;
	};
	return {
		abandon,
		[Symbol.asyncIterator](): AsyncIterator<string> {
			const iterator = source[Symbol.asyncIterator]();
			return {
				async next(value) {
					if (sourceCompleted) return iterator.next(value);
					if (admission.failed) {
						await abandon();
						throw new WorkspaceLeaseUncertainError();
					}
					try {
						await admission.assertFence();
						const result = await iterator.next(value);
						if (result.done) {
							sourceCompleted = true;
							await complete();
						} else if (result.value === "data: [DONE]\n\n") {
							sourceCompleted = true;
							await complete();
						} else {
							await admission.assertFence();
						}
						if (admission.failed) {
							await abandon();
							throw new WorkspaceLeaseUncertainError();
						}
						return result;
					} catch (error) {
						try {
							await abandon();
						} catch (cleanupError) {
							if (cleanupError instanceof WorkspaceLeaseUncertainError) throw cleanupError;
						}
						throw error;
					}
				},
				async return(value) {
					let failure: unknown;
					try {
						await abandon();
					} catch (error) {
						failure = error;
					}
					try {
						const returned = await iterator.return?.(value);
						if (failure !== undefined) throw failure;
						return returned ?? { done: true, value };
					} catch (error) {
						throw failure ?? error;
					}
				},
				async throw(error) {
					let failure: unknown;
					try {
						await abandon();
					} catch (caught) {
						failure = caught;
					}
					try {
						const thrown = await iterator.throw?.(error);
						if (failure !== undefined) throw failure;
						if (thrown !== undefined) return thrown;
						throw error;
					} catch (caught) {
						throw failure ?? caught;
					}
				},
			};
		},
	};
}

async function abandonRunnerResult(result: LiveGatewayRunnerResult): Promise<void> {
	if (!("abandon" in result) || result.abandon === undefined) return;
	try {
		await result.abandon();
	} catch {
		// Preserve the original request failure after the stream owner finalizes itself.
	}
}
function selectionErrorResult(error: ModelSelectionError): LiveChatCompletionsResult {
	return errorResult(error.status, error.type, error.code, error.message);
}

function errorResult(
	status: 400 | 401 | 404 | 409 | 503,
	type: string,
	code: string,
	message: string,
): LiveChatCompletionsResult {
	return {
		ok: false,
		status,
		body: buildOpenAIErrorResponse({ message, type, code }),
	};
}
