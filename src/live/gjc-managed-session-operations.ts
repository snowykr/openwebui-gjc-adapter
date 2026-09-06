import { createHash } from "node:crypto";
import type { NormalizedModelSelection } from "../contracts";
import {
	type ManagedSdkAttachment,
	type ManagedSdkObservedFrame,
	ManagedSdkOperationError,
	type ManagedSdkRuntime,
	type TenantSessionKey,
} from "../gjc/managed-sdk-runtime";
import { SESSION_AUTHORITY_V3_EPOCH } from "../gjc/session-authority-v3";
import {
	GjcTurnCancelledError,
	type GjcTurnEvent,
	type GjcTurnResult,
	type ManagedTurnAuthority,
} from "../gjc/turn-runner";

const MAX_QUERY_PAGES = 256;
const MAX_QUERY_ITEMS = 100_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 60_000;
const ATTACHMENT_CHECK_MS = 100;

export class ManagedTurnUncertainError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ManagedTurnUncertainError";
	}
}

export interface ManagedLifecycleInput {
	readonly authority: Omit<ManagedTurnAuthority, "sessionId" | "generation"> &
		Partial<Pick<ManagedTurnAuthority, "sessionId" | "generation">>;
	readonly target: Readonly<Record<string, unknown>>;
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
	/** Durable owner acknowledgement, before registration, cancellation handling, or currentness proof. */
	readonly onAcknowledged?: (authority: ManagedTurnAuthority) => void | Promise<void>;
}

/** A lifecycle acknowledgement whose identity has been adopted, fenced, and proven current. */
export interface ManagedLifecycleResult {
	readonly outcome: Readonly<Record<string, unknown>>;
	readonly tenant: TenantSessionKey;
	readonly attachment: ManagedSdkAttachment;
}

export interface ManagedRouterPage {
	readonly items: readonly unknown[];
	readonly complete: boolean;
	readonly continuationCursor?: string;
}

export interface ManagedRequestInput {
	readonly authority: ManagedTurnAuthority;
	readonly operation: string;
	readonly input?: Readonly<Record<string, unknown>>;
	readonly timeoutMs?: number;
	readonly idempotencyKey?: string;
	readonly signal?: AbortSignal;
	readonly onDispatch?: () => void;
}

export interface ManagedTurnInput extends ManagedRequestInput {
	readonly text: string;
	readonly observer?: (event: GjcTurnEvent) => void | Promise<void>;
}

export interface ManagedGateInput extends ManagedRequestInput {
	readonly gateId: string;
	readonly answer: unknown;
	readonly observer?: (event: GjcTurnEvent) => void | Promise<void>;
}

export interface ManagedSessionOperations {
	readonly runtime: ManagedSdkRuntime;
	tenant(authority: ManagedTurnAuthority): TenantSessionKey;
	payloadHash(payload: unknown): string;
	create(input: ManagedLifecycleInput): Promise<ManagedLifecycleResult>;
	resume(input: ManagedLifecycleInput): Promise<ManagedLifecycleResult>;
	fork(input: ManagedLifecycleInput): Promise<ManagedLifecycleResult>;
	close(input: ManagedLifecycleInput): Promise<unknown>;
	delete(input: ManagedLifecycleInput): Promise<unknown>;
	list(input: ManagedLifecycleInput): Promise<unknown>;
	acquire(authority: ManagedTurnAuthority): Promise<ManagedSdkAttachment>;
	request(input: ManagedRequestInput): Promise<Readonly<Record<string, unknown>>>;
	query(
		authority: ManagedTurnAuthority,
		query: string,
		input?: Readonly<Record<string, unknown>>,
		timeoutMs?: number,
	): Promise<readonly unknown[]>;
	getModels(authority: ManagedTurnAuthority, timeoutMs?: number): Promise<readonly unknown[]>;
	getProviders(authority: ManagedTurnAuthority, timeoutMs?: number): Promise<readonly unknown[]>;
	getBranchCandidates(authority: ManagedTurnAuthority, timeoutMs?: number): Promise<readonly unknown[]>;
	setModel(
		authority: ManagedTurnAuthority,
		selection: NormalizedModelSelection,
		timeoutMs?: number,
	): Promise<Readonly<Record<string, unknown>>>;
	setThinking(
		authority: ManagedTurnAuthority,
		thinkingLevel: string,
		timeoutMs?: number,
	): Promise<Readonly<Record<string, unknown>>>;
	prompt(input: ManagedTurnInput): Promise<GjcTurnResult>;
	followUp(input: ManagedTurnInput): Promise<GjcTurnResult>;
	abortAndPrompt(input: ManagedTurnInput): Promise<GjcTurnResult>;
	answerGate(input: ManagedGateInput): Promise<GjcTurnResult>;
	abort(input: ManagedRequestInput): Promise<Readonly<Record<string, unknown>>>;
}

/**
 * Isolated managed traffic adapter. It deliberately owns no descriptors, clients,
 * credentials, shells, or fallback transport: every remote action is a Router request.
 */
export function createManagedSessionOperations(
	runtime: ManagedSdkRuntime,
	defaultTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
): ManagedSessionOperations {
	if (!Number.isSafeInteger(defaultTimeoutMs) || defaultTimeoutMs <= 0 || defaultTimeoutMs > 2_147_483_647)
		throw new TypeError("Managed timeoutMs must be a positive finite timer-safe integer.");
	const tenant = (authority: ManagedTurnAuthority): TenantSessionKey => {
		assertAuthority(authority);
		return {
			principalId: authority.principalId,
			projectId: authority.projectId,
			canonicalWorkspace: authority.canonicalWorkspace,
			chatId: authority.chatId,
			sessionId: authority.sessionId,
			generation: authority.generation,
			leaseId: authority.leaseId,
			epoch: authority.epoch,
		};
	};
	const acquire = async (authority: ManagedTurnAuthority) => {
		const key = tenant(authority);
		await runtime.reconcile();
		return await runtime.acquireAttachment(key);
	};
	const invoke = async (
		authority: ManagedTurnAuthority,
		frame: Record<string, unknown>,
		options?: ManagedRequestInput,
	) => {
		throwIfAborted(options?.signal);
		const deadline = new ManagedOperationDeadline(
			options?.timeoutMs ?? defaultTimeoutMs,
			options?.operation ?? "request",
		);
		const onAbort = () => deadline.fail(new GjcTurnCancelledError());
		options?.signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const key = tenant(authority);
			await deadline.wait(runtime.reconcile());
			const attachment = await deadline.wait(runtime.acquireAttachment(key));
			throwIfAborted(options?.signal);
			return await deadline.wait(
				runtime.request(attachment, frame, {
					timeoutMs: deadline.remaining(),
					beforeDispatch: () => {
						deadline.remaining();
						throwIfAborted(options?.signal);
					},
					onDispatch: options?.onDispatch,
				}),
			);
		} finally {
			options?.signal?.removeEventListener("abort", onAbort);
			deadline.close();
		}
	};
	const lifecycle = async (
		operation: "create" | "resume" | "fork" | "close" | "delete" | "list",
		input: ManagedLifecycleInput,
	): Promise<unknown> => {
		throwIfAborted(input.signal);
		const deadline = new ManagedOperationDeadline(input.timeoutMs ?? defaultTimeoutMs, `session.${operation}`);
		try {
			const authority = input.authority;
			const key = hasExactGeneration(authority) ? tenant(authority as ManagedTurnAuthority) : undefined;
			const actor = { namespace: "openwebui-gjc-adapter", id: authority.principalId };
			const requestKey = authority.requestKey;
			const target = lifecycleTarget(operation, input.target);
			const invokeLifecycle = () => {
				throwIfAborted(input.signal);
				const timeoutMs = deadline.remaining();
				switch (operation) {
					case "create":
						return runtime.createPreparedExternalLifecycleSession(authority, {
							actor,
							capability: "session.create",
							requestKey,
							target: { kind: "existing_path", path: requiredTargetString(target, "path") },
							readinessTimeoutMs: timeoutMs,
						});
					case "resume":
						return runtime.resumeExternalLifecycleSession(requireExactTenant(key), {
							actor,
							capability: "session.resume",
							requestKey,
							target: {
								sessionIdOrPrefix: requiredTargetString(target, "sessionIdOrPrefix"),
								path:
									target.path === undefined
										? authority.canonicalWorkspace
										: requiredTargetString(target, "path"),
							},
							readinessTimeoutMs: timeoutMs,
						});
					case "fork":
						return runtime.forkLifecycleSession(requireExactTenant(key), {
							actor,
							capability: "session.fork",
							requestKey,
							target: {
								sourceSessionId: requiredTargetString(target, "sourceSessionId"),
								cwd: requiredTargetString(target, "cwd"),
							},
							timeoutMs,
						});
					case "close":
						return runtime.closeLifecycleSession(requireExactTenant(key), {
							actor,
							capability: "session.close",
							requestKey,
							target: {
								sessionId: requiredTargetString(target, "sessionId"),
								endpointGeneration:
									target.endpointGeneration === undefined ? key!.generation : requiredTargetGeneration(target),
								...(target.endpointIncarnation === undefined
									? {}
									: { endpointIncarnation: requiredTargetString(target, "endpointIncarnation") }),
							},
							timeoutMs,
						});
					case "delete":
						return runtime.deleteLifecycleSession(requireExactTenant(key), {
							actor,
							capability: "session.delete",
							requestKey,
							target: {
								sessionId: requiredTargetString(target, "sessionId"),
								cwd: authority.canonicalWorkspace,
							},
							timeoutMs,
						});
					case "list":
						if (Object.keys(target).some(field => field !== "cwd"))
							throw new Error("Managed lifecycle list rejects unreviewed scope options.");
						return runtime.listLifecycleSessions(requireExactTenant(key), {
							actor,
							capability: "session.list",
							target: {
								cwd:
									target.cwd === undefined
										? authority.canonicalWorkspace
										: requiredTargetString(target, "cwd"),
								resolveSessionId: key!.sessionId,
							},
							timeoutMs,
						});
				}
			};
			const outcome = externalOutcome(await deadline.wait<unknown>(invokeLifecycle()));
			if (!isLifecycleSuccess(outcome)) {
				if (operation === "close" || operation === "delete") {
					throw new ManagedTurnUncertainError(
						`Managed session.${operation} lacks a successful lifecycle acknowledgement.`,
					);
				}
				if (isUncertainLifecycleOutcome(outcome))
					throw new ManagedTurnUncertainError(`Managed session.${operation} outcome is uncertain.`);
				throw new Error(lifecycleMessage(outcome, `Managed session.${operation} failed.`));
			}
			if (operation === "close" || operation === "delete") {
				if (key === undefined)
					throw new ManagedTurnUncertainError("Managed retirement lacks an exact generation authority.");
				if (!isRecord(outcome) || !isRecord(outcome.result) || outcome.result.sessionId !== key.sessionId)
					throw new ManagedTurnUncertainError(
						`Managed session.${operation} acknowledgement does not match the exact session.`,
					);
				await deadline.wait(requireRetired(runtime, key));
			} else if (operation !== "list") {
				const lifecycleTenant = tenantFromLifecycle(authority, outcome, operation, target);
				if (lifecycleTenant === undefined)
					throw new Error(
						"Managed lifecycle acknowledgement lacks the expected session id and positive generation.",
					);
				const acknowledged = { ...lifecycleTenant, requestKey, authorityEpoch: SESSION_AUTHORITY_V3_EPOCH };
				await deadline.wait(Promise.resolve(input.onAcknowledged?.(acknowledged)));
				try {
					throwIfAborted(input.signal);
					return {
						outcome,
						tenant: lifecycleTenant,
						attachment: await deadline.wait(runtime.registerLifecycleTenant(lifecycleTenant)),
					} satisfies ManagedLifecycleResult;
				} catch (error) {
					// A successful lifecycle acknowledgement without current attachment proof
					// cannot be reinterpreted as failure. Retire this exact generation first.
					try {
						await lifecycle("close", {
							authority: { ...lifecycleTenant, requestKey: authority.requestKey },
							target: { sessionId: lifecycleTenant.sessionId, endpointGeneration: lifecycleTenant.generation },
							timeoutMs: deadline.remaining(),
						});
						runtime.unregisterTenant(lifecycleTenant);
					} catch (cleanup) {
						throw new AggregateError([error, cleanup], "Managed lifecycle success has uncertain cleanup.");
					}
					throw new ManagedTurnUncertainError("Managed lifecycle success lacks current exact-generation proof.", {
						cause: error,
					});
				}
			}
			return outcome;
		} finally {
			deadline.close();
		}
	};
	const request = async (input: ManagedRequestInput) => {
		if (!input.operation) throw new TypeError("Managed operation is required.");
		return decodeControlResponse(
			await invoke(
				input.authority,
				{
					type: "control_request",
					operation: input.operation,
					input: { ...(input.input ?? {}) },
					idempotencyKey: input.idempotencyKey ?? input.authority.requestKey,
				},
				input,
			),
			input.operation,
		);
	};
	const queryPages = async (
		authority: ManagedTurnAuthority,
		name: string,
		input: Readonly<Record<string, unknown>>,
		deadline: ManagedOperationDeadline,
	) => {
		if (!name) throw new TypeError("Managed query is required.");
		const items: unknown[] = [];
		const cursors = new Set<string>();
		let cursor: string | undefined;
		for (let page = 0; page < MAX_QUERY_PAGES; page += 1) {
			const attachment = await deadline.wait(acquire(authority));
			const result = await deadline.wait(
				runtime.request(
					attachment,
					{ type: "query_request", query: name, input: { ...input }, ...(cursor === undefined ? {} : { cursor }) },
					{
						timeoutMs: deadline.remaining(),
						beforeDispatch: () => {
							deadline.remaining();
						},
					},
				),
			);
			const parsed = decodeRouterPage(result, name);
			if (items.length + parsed.items.length > MAX_QUERY_ITEMS)
				throw new Error(`Managed ${name} query exceeded item bound.`);
			items.push(...parsed.items);
			if (parsed.complete) return items;
			if (parsed.continuationCursor === undefined)
				throw new Error(`Managed ${name} query is incomplete without a continuation cursor.`);
			if (cursors.has(parsed.continuationCursor))
				throw new Error(`Managed ${name} query repeated a continuation cursor.`);
			cursors.add(parsed.continuationCursor);
			cursor = parsed.continuationCursor;
		}
		throw new Error(`Managed ${name} query exceeded page bound.`);
	};
	const query = async (
		authority: ManagedTurnAuthority,
		name: string,
		input: Readonly<Record<string, unknown>> = {},
		timeoutMs?: number,
	) => {
		const deadline = new ManagedOperationDeadline(timeoutMs ?? defaultTimeoutMs, name);
		try {
			return await queryPages(authority, name, input, deadline);
		} finally {
			deadline.close();
		}
	};
	const runTurn = async (
		operation: "turn.prompt" | "turn.follow_up" | "turn.abort_and_prompt" | "workflow.gate_answer",
		input: ManagedTurnInput | ManagedGateInput,
	): Promise<GjcTurnResult> => {
		throwIfAborted(input.signal);
		const deadline = new ManagedOperationDeadline(input.timeoutMs ?? defaultTimeoutMs, operation);
		const authority = input.authority;
		const events: GjcTurnEvent[] = [];
		const eventIds = new Set<string>();
		const observe = async (event: GjcTurnEvent) => {
			const identity =
				event.id === undefined
					? payloadHash(event.payload ?? { type: event.type, text: event.text })
					: `${event.type}:${event.id}:${event.payload?.seq ?? ""}`;
			if (eventIds.has(identity)) return;
			eventIds.add(identity);
			events.push(event);
			await input.observer?.(event);
		};
		let closed = false;
		let subscription: ReturnType<ManagedSdkRuntime["prepareFrameSubscription"]> | undefined;
		let attachmentCheck: ReturnType<typeof setInterval> | undefined;
		let dispatched = false;
		let abortPromise: Promise<Readonly<Record<string, unknown>>> | undefined;
		const cancelAfterDispatch = () => {
			if (dispatched && abortPromise === undefined) {
				abortPromise = request({
					authority,
					operation: "turn.abort",
					input: { mode: "terminal", scope: "turn" },
					idempotencyKey: authority.requestKey,
					timeoutMs: Math.max(1, deadline.expiresAt - Date.now()),
				});
				void abortPromise.catch(() => undefined);
			}
			deadline.fail(new GjcTurnCancelledError());
		};
		input.signal?.addEventListener("abort", cancelAfterDispatch, { once: true });
		try {
			const attachment = await deadline.wait(acquire(authority));
			const assertCurrent = () => {
				throwIfAborted(input.signal);
				deadline.remaining();
				if (runtime.state !== "running" || !attachment.isCurrent())
					throw new ManagedTurnUncertainError("Managed turn lost its current runtime attachment.");
			};
			assertCurrent();
			attachmentCheck = setInterval(() => {
				try {
					assertCurrent();
				} catch (error) {
					deadline.fail(error);
				}
			}, ATTACHMENT_CHECK_MS);
			attachmentCheck.unref?.();
			const baseline = new Set(
				(await queryPages(authority, "workflow.gates.list", {}, deadline)).map(durableGateId),
			);
			assertCurrent();
			let correlation: ReturnType<typeof decodeAcknowledgedCorrelation> | undefined;
			let terminal: GjcTurnEvent | undefined;
			let complete!: (gate: Record<string, unknown> | undefined) => void;
			const completion = new Promise<Record<string, unknown> | undefined>(resolve => {
				complete = resolve;
			});
			const checkedActions = new Set<string>();
			subscription = runtime.prepareFrameSubscription(attachment, operation, async observed => {
				if (closed || terminal !== undefined || correlation === undefined) return;
				try {
					assertCurrent();
					const event = correlatedEvent(observed, correlation, authority);
					if (event === undefined || event.type === "workflow_gate") return;
					if (event.type === "agent_failed")
						throw new ManagedSdkOperationError("prompt_failed", terminalFailureMessage(event.payload));
					if (event.type === "agent_end") {
						if (typeof event.payload?.finalText !== "string")
							throw new ManagedSdkOperationError("invalid_result", "Managed agent_end omitted finalText.");
						terminal = event;
					}
					await observe(event);
					if (event.type === "agent_end") complete(undefined);
					if (event.type !== "action_needed" || event.payload?.kind !== "ask") return;
					const actionId = event.payload.actionId ?? event.id;
					if (!nonEmptyString(actionId) || checkedActions.has(actionId)) return;
					if (checkedActions.size >= MAX_QUERY_PAGES)
						throw new ManagedSdkOperationError("invalid_result", "Managed turn exceeded action query bound.");
					checkedActions.add(actionId);
					const accepted = correlation;
					// Do not block ordered frame delivery on a query: a terminal may arrive while it is pending.
					void queryPages(authority, "workflow.gates.list", {}, deadline)
						.then(gates => {
							if (closed || terminal !== undefined) return;
							const gate = resolveDurableGate(gates, baseline, event.payload!, accepted, authority);
							if (gate !== undefined) complete(gate);
						})
						.catch(error => {
							if (!closed && terminal === undefined) deadline.fail(error);
						});
				} catch (error) {
					deadline.fail(error);
					throw error;
				}
			});
			const response = decodeControlResponse(
				await deadline.wait(
					runtime.request(
						attachment,
						{
							type: "control_request",
							operation,
							input:
								operation === "workflow.gate_answer"
									? {
											id: (input as ManagedGateInput).gateId,
											response: (input as ManagedGateInput).answer,
											expectedSessionId: authority.sessionId,
										}
									: { text: (input as ManagedTurnInput).text },
							idempotencyKey: input.idempotencyKey ?? authority.requestKey,
						},
						{
							timeoutMs: deadline.remaining(),
							beforeDispatch: assertCurrent,
							onDispatch: () => {
								dispatched = true;
								input.onDispatch?.();
								if (input.signal?.aborted && abortPromise === undefined) cancelAfterDispatch();
							},
						},
					),
				),
				operation,
			);
			correlation = decodeAcknowledgedCorrelation(response, authority);
			subscription.bind(correlation);
			const gate = await deadline.wait(completion);
			await deadline.wait(subscription.drain());
			closed = true;
			subscription();
			if (terminal === undefined && gate !== undefined) {
				await deadline.wait(
					observe({
						type: "workflow_gate",
						id: durableGateId(gate),
						payload: { ...gate, ...correlation, sessionId: authority.sessionId },
					}),
				);
			}
			const current = await deadline.wait(runtime.acquireAttachment(tenant(authority)));
			assertCurrent();
			if (current !== attachment)
				throw new ManagedTurnUncertainError("Managed turn attachment changed before completion.");
			return {
				text: terminal === undefined ? accumulatedText(events) : (terminal.payload!.finalText as string),
				events,
				rawFrameCursor: frameCursor(events),
				eventCursor: events.length,
			};
		} finally {
			input.signal?.removeEventListener("abort", cancelAfterDispatch);
			if (attachmentCheck !== undefined) clearInterval(attachmentCheck);
			closed = true;
			subscription?.();
			deadline.close();
		}
	};
	return {
		runtime,
		tenant,
		payloadHash,
		create: input => lifecycle("create", input) as Promise<ManagedLifecycleResult>,
		resume: input => lifecycle("resume", input) as Promise<ManagedLifecycleResult>,
		fork: input => lifecycle("fork", input) as Promise<ManagedLifecycleResult>,
		close: input => lifecycle("close", input),
		delete: input => lifecycle("delete", input),
		list: input => lifecycle("list", input),
		acquire,
		request,
		query,
		getModels: (authority, timeoutMs) => query(authority, "models.list/current", {}, timeoutMs),
		getProviders: (authority, timeoutMs) => query(authority, "providers.list/active", {}, timeoutMs),
		getBranchCandidates: (authority, timeoutMs) => query(authority, "session.branch_candidates", {}, timeoutMs),
		setModel: (authority, selection, timeoutMs) =>
			request({
				authority,
				operation: "model.set",
				input: { id: `${selection.provider}/${selection.modelId}`, thinkingLevel: selection.thinkingLevel },
				timeoutMs,
			}),
		setThinking: (authority, thinkingLevel, timeoutMs) =>
			request({ authority, operation: "thinking.set", input: { level: thinkingLevel }, timeoutMs }),
		prompt: input => runTurn("turn.prompt", input),
		followUp: input => runTurn("turn.follow_up", input),
		abortAndPrompt: input => runTurn("turn.abort_and_prompt", input),
		answerGate: input => runTurn("workflow.gate_answer", input),
		abort: input => request({ ...input, operation: "turn.abort", input: { mode: "terminal", scope: "turn" } }),
	};
}

function assertAuthority(authority: ManagedTurnAuthority): void {
	if (
		!authority.principalId ||
		!authority.projectId ||
		!authority.canonicalWorkspace ||
		!authority.chatId ||
		!authority.sessionId ||
		!authority.leaseId ||
		!authority.epoch ||
		!authority.requestKey ||
		!Number.isSafeInteger(authority.generation) ||
		authority.generation <= 0
	)
		throw new TypeError("Complete positive ManagedTurnAuthority is required.");
}
function payloadHash(payload: unknown): string {
	return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}
function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new GjcTurnCancelledError();
}
function isLifecycleSuccess(value: unknown): value is Readonly<Record<string, unknown>> & { readonly ok: true } {
	return isRecord(value) && value.ok === true;
}
function externalOutcome(value: unknown): unknown {
	return isRecord(value) && value.kind === "result" && "outcome" in value ? value.outcome : value;
}
function isUncertainLifecycleOutcome(value: unknown): boolean {
	return isRecord(value) && (value.certainty === "uncertain" || value.certainty === "cleanup_pending");
}
function lifecycleMessage(value: unknown, fallback: string): string {
	return isRecord(value) && isRecord(value.error) && typeof value.error.message === "string"
		? value.error.message
		: fallback;
}
async function requireRetired(runtime: ManagedSdkRuntime, key: TenantSessionKey, cause?: unknown): Promise<void> {
	await runtime.reconcile();
	const status = await runtime.generationStatus(key);
	if (status.status !== "retired")
		throw new ManagedTurnUncertainError(
			"Exact managed generation retirement is not proven.",
			cause === undefined ? undefined : { cause },
		);
}
export function decodeRouterPage(frame: unknown, query: string): ManagedRouterPage {
	if (!isRecord(frame) || frame.type !== "query_response")
		throw new Error(`Managed ${query} query response has an invalid envelope.`);
	if (frame.ok !== true) throw new Error(routerErrorMessage(frame, `Managed ${query} query failed.`));
	if (!isRecord(frame.page) || !Array.isArray(frame.page.items) || typeof frame.page.complete !== "boolean")
		throw new Error(`Managed ${query} query response has an invalid page.`);
	const continuationCursor = frame.page.continuationCursor;
	if (continuationCursor !== undefined && (typeof continuationCursor !== "string" || continuationCursor.length === 0))
		throw new Error(`Managed ${query} query has an invalid continuation cursor.`);
	if (frame.page.complete && continuationCursor !== undefined)
		throw new Error(`Managed ${query} query returned a cursor on a complete page.`);
	return {
		items: frame.page.items,
		complete: frame.page.complete,
		...(continuationCursor === undefined ? {} : { continuationCursor }),
	};
}

export function decodeControlResponse(frame: unknown, operation: string): Readonly<Record<string, unknown>> {
	if (!isRecord(frame) || frame.type !== "control_response")
		throw new Error(`Managed ${operation} control response has an invalid envelope.`);
	if (frame.ok !== true) throw new Error(routerErrorMessage(frame, `Managed ${operation} control request failed.`));
	if (!isRecord(frame.result)) throw new Error(`Managed ${operation} control response has no result.`);
	return frame.result;
}

function routerErrorMessage(frame: Record<string, unknown>, fallback: string): string {
	return isRecord(frame.error) && typeof frame.error.message === "string" ? frame.error.message : fallback;
}

function lifecycleTarget(
	operation: "create" | "resume" | "fork" | "close" | "delete" | "list",
	target: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
	if (operation === "create") {
		if (typeof target.path !== "string" || target.path.length === 0)
			throw new TypeError("Managed session.create requires an existing_path target path.");
		return { kind: "existing_path", path: target.path };
	}
	if (operation === "resume") {
		if (typeof target.sessionIdOrPrefix !== "string" || target.sessionIdOrPrefix.length === 0)
			throw new TypeError("Managed session.resume requires a sessionIdOrPrefix target.");
		if (target.path !== undefined && (typeof target.path !== "string" || target.path.length === 0))
			throw new TypeError("Managed session.resume target path must be a non-empty string.");
		return {
			sessionIdOrPrefix: target.sessionIdOrPrefix,
			...(target.path === undefined ? {} : { path: target.path }),
		};
	}
	return { ...target };
}

function requiredTargetString(target: Readonly<Record<string, unknown>>, field: string): string {
	const value = target[field];
	if (typeof value !== "string" || value.length === 0)
		throw new TypeError(`Managed lifecycle target ${field} must be a non-empty string.`);
	return value;
}

function requiredTargetGeneration(target: Readonly<Record<string, unknown>>): number {
	const value = target.endpointGeneration;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
		throw new TypeError("Managed lifecycle target generation must be a positive safe integer.");
	return value;
}

function tenantFromLifecycle(
	authority: ManagedLifecycleInput["authority"],
	outcome: unknown,
	operation: "create" | "resume" | "fork" | "close" | "delete" | "list",
	target: Readonly<Record<string, unknown>>,
): TenantSessionKey | undefined {
	if (!isRecord(outcome) || outcome.ok !== true || !isRecord(outcome.result)) return undefined;
	const sessionId = outcome.result.sessionId;
	const generation = outcome.result.endpointGeneration;
	if (
		typeof sessionId !== "string" ||
		sessionId.length === 0 ||
		typeof generation !== "number" ||
		!Number.isSafeInteger(generation) ||
		generation <= 0
	)
		return undefined;
	if (operation === "resume" && target.sessionIdOrPrefix !== sessionId) return undefined;
	return { ...authority, sessionId, generation };
}

function hasExactGeneration(authority: ManagedLifecycleInput["authority"]): authority is ManagedTurnAuthority {
	return (
		typeof authority.sessionId === "string" &&
		authority.sessionId.length > 0 &&
		typeof authority.generation === "number" &&
		Number.isSafeInteger(authority.generation) &&
		authority.generation > 0
	);
}

function requireExactTenant(key: TenantSessionKey | undefined): TenantSessionKey {
	if (key === undefined) throw new TypeError("Complete positive ManagedTurnAuthority is required.");
	return key;
}
function decodeAcknowledgedCorrelation(
	result: Readonly<Record<string, unknown>>,
	authority: ManagedTurnAuthority,
): Readonly<{ commandId: string; turnId: string }> {
	const value = isRecord(result.result) ? result.result : result;
	const correlation = isRecord(value.correlation) ? value.correlation : value;
	const commandId = correlation.commandId;
	const turnId = correlation.turnId;
	if (!nonEmptyString(commandId) || !nonEmptyString(turnId))
		throw new ManagedSdkOperationError(
			"invalid_result",
			"Managed Router acknowledgement lacks command and turn correlation identity.",
		);
	for (const record of [result, value, correlation]) {
		if (
			(record.sessionId !== undefined && record.sessionId !== authority.sessionId) ||
			(record.commandId !== undefined && record.commandId !== commandId) ||
			(record.turnId !== undefined && record.turnId !== turnId)
		)
			throw new ManagedSdkOperationError(
				"invalid_result",
				"Managed Router acknowledgement references a foreign correlation.",
			);
	}
	return { commandId, turnId };
}
function normalizeFrame(frame: Record<string, unknown>): GjcTurnEvent | undefined {
	const value = frame.type === "event" && isRecord(frame.payload) ? frame.payload : frame;
	if (typeof value.type !== "string") return undefined;
	const assistant = isRecord(value.assistantMessageEvent) ? value.assistantMessageEvent : undefined;
	const text =
		assistant === undefined
			? typeof value.text === "string"
				? value.text
				: typeof value.delta === "string"
					? value.delta
					: undefined
			: assistant.type === "text_delta"
				? typeof assistant.delta === "string"
					? assistant.delta
					: typeof assistant.text === "string"
						? assistant.text
						: undefined
				: undefined;
	return {
		type: value.type,
		...(text === undefined ? {} : { text }),
		...(typeof value.id === "string" ? { id: value.id } : {}),
		payload: value,
	};
}
function accumulatedText(events: readonly GjcTurnEvent[]): string {
	return events
		.filter(event => event.type === "message_update" && typeof event.text === "string")
		.map(event => event.text)
		.join("");
}
function correlatedEvent(
	observed: ManagedSdkObservedFrame,
	correlation: Readonly<{ commandId: string; turnId: string }>,
	authority: ManagedTurnAuthority,
): GjcTurnEvent | undefined {
	const frame = observed.frame;
	if (
		frame.sessionId !== authority.sessionId ||
		frame.generation !== authority.generation ||
		frame.commandId !== correlation.commandId ||
		frame.turnId !== correlation.turnId
	)
		return undefined;
	const event = normalizeFrame(frame.body);
	if (event === undefined) return undefined;
	const expected = { ...correlation, sessionId: authority.sessionId };
	for (const record of [frame.body, event.payload, event.payload?.correlation]) {
		if (record === undefined) continue;
		if (!isRecord(record)) return undefined;
		for (const key of ["sessionId", "commandId", "turnId"] as const)
			if (record[key] !== undefined && record[key] !== expected[key]) return undefined;
	}
	return {
		...event,
		payload: {
			...event.payload,
			...expected,
			...(frame.seq === undefined ? {} : { seq: frame.seq }),
			...(frame.publicationId === undefined ? {} : { publicationId: frame.publicationId }),
		},
	};
}
function durableGateId(value: unknown): string {
	const id = isRecord(value) ? (value.gate_id ?? value.gateId ?? value.id) : undefined;
	if (!nonEmptyString(id))
		throw new ManagedSdkOperationError("invalid_result", "Durable workflow gate omitted its id.");
	return id;
}
function resolveDurableGate(
	items: readonly unknown[],
	baseline: ReadonlySet<string>,
	action: Readonly<Record<string, unknown>>,
	correlation: Readonly<{ commandId: string; turnId: string }>,
	authority: ManagedTurnAuthority,
): Record<string, unknown> | undefined {
	if (action.workflowGateId !== undefined && !nonEmptyString(action.workflowGateId))
		throw new ManagedSdkOperationError("invalid_result", "action_needed.workflowGateId must be non-empty.");
	const expected = { ...correlation, sessionId: authority.sessionId };
	const matches = items.filter((value): value is Record<string, unknown> => {
		const id = durableGateId(value);
		if (!isRecord(value) || (action.workflowGateId !== undefined && action.workflowGateId !== id)) return false;
		if (value.status !== undefined && value.status !== "pending") return false;
		const nested = value.correlation;
		if (nested !== undefined && !isRecord(nested)) return false;
		const records = isRecord(nested) ? [value, nested] : [value];
		let complete = false;
		for (const record of records) {
			for (const key of ["sessionId", "commandId", "turnId"] as const) {
				if (record[key] === undefined) continue;
				if (record[key] !== expected[key]) return false;
			}
			if (
				record.sessionId === expected.sessionId &&
				record.commandId === expected.commandId &&
				record.turnId === expected.turnId
			)
				complete = true;
		}
		return complete || (action.workflowGateId === id && !baseline.has(id));
	});
	if (matches.length > 1)
		throw new ManagedSdkOperationError(
			"invalid_result",
			"Managed turn opened multiple matching durable workflow gates.",
		);
	return matches[0];
}
function terminalFailureMessage(payload: Readonly<Record<string, unknown>> | undefined): string {
	if (isRecord(payload?.error) && nonEmptyString(payload.error.message)) return payload.error.message;
	return "Managed SDK agent failed.";
}
function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/** One finite budget, including attachment acquisition, every page, observers and publication fencing. */
export class ManagedOperationDeadline {
	readonly expiresAt: number;
	readonly #failure: Promise<never>;
	readonly #timer: ReturnType<typeof setTimeout>;
	readonly #timeout: ManagedSdkOperationError;
	#reject!: (error: unknown) => void;
	#stopped = false;
	#error: unknown;
	constructor(timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS, operation: string) {
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
			throw new TypeError("Managed timeoutMs must be a positive finite timer-safe integer.");
		this.expiresAt = Date.now() + timeoutMs;
		this.#timeout = new ManagedSdkOperationError("timeout", `Managed ${operation} timed out after ${timeoutMs}ms.`);
		this.#failure = new Promise<never>((_resolve, reject) => {
			this.#reject = reject;
		});
		void this.#failure.catch(() => undefined);
		this.#timer = setTimeout(() => this.fail(this.#timeout), timeoutMs);
		this.#timer.unref?.();
	}
	remaining(): number {
		if (this.#stopped) throw this.#error;
		const remaining = this.expiresAt - Date.now();
		if (remaining <= 0) {
			this.fail(this.#timeout);
			throw this.#timeout;
		}
		return remaining;
	}
	async wait<T>(promise: Promise<T>): Promise<T> {
		// Attach the rejection handler even when this budget has already failed.
		const pending = Promise.race([promise, this.#failure]);
		const value = await pending;
		this.remaining();
		return value;
	}
	fail(error: unknown): void {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#error = error;
		clearTimeout(this.#timer);
		this.#reject(error);
	}
	close(): void {
		this.fail(new ManagedSdkOperationError("operation_closed", "Managed operation observation is closed."));
	}
}
function frameCursor(events: readonly GjcTurnEvent[]): number {
	let cursor = 0;
	for (const event of events) {
		const seq = event.payload?.seq;
		if (typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0) cursor = Math.max(cursor, seq);
	}
	return cursor;
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
