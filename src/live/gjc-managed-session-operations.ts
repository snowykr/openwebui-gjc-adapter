import { createHash } from "node:crypto";
import type { NormalizedModelSelection } from "../contracts";
import type { ManagedSdkAttachment, ManagedSdkRuntime, TenantSessionKey } from "../gjc/managed-sdk-runtime";
import {
	GjcTurnCancelledError,
	type GjcTurnEvent,
	type GjcTurnResult,
	type ManagedTurnAuthority,
} from "../gjc/turn-runner";

const MAX_QUERY_PAGES = 256;
const MAX_QUERY_ITEMS = 100_000;

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
	readonly artifactProject?: (
		events: readonly GjcTurnEvent[],
	) => readonly GjcTurnEvent[] | Promise<readonly GjcTurnEvent[]>;
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
export function createManagedSessionOperations(runtime: ManagedSdkRuntime): ManagedSessionOperations {
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
		const attachment = await acquire(authority);
		throwIfAborted(options?.signal);
		return await runtime.request(attachment, frame, {
			timeoutMs: options?.timeoutMs,
			beforeDispatch: () => throwIfAborted(options?.signal),
			onDispatch: options?.onDispatch,
		});
	};
	const lifecycle = async (
		operation: "create" | "resume" | "fork" | "close" | "delete" | "list",
		input: ManagedLifecycleInput,
	): Promise<unknown> => {
		const authority = input.authority;
		const key = hasExactGeneration(authority) ? tenant(authority as ManagedTurnAuthority) : undefined;
		const actor = { namespace: "openwebui-gjc-adapter", id: authority.principalId };
		const requestKey = authority.requestKey;
		const target = lifecycleTarget(operation, input.target);
		const request =
			operation === "list"
				? { actor, capability: "session.list" as const, target, timeoutMs: input.timeoutMs }
				: { actor, capability: `session.${operation}`, requestKey, target, timeoutMs: input.timeoutMs };
		let outcome: unknown;
		try {
			outcome = await (operation === "create"
				? runtime.lifecycleService.createExternal(request as never)
				: operation === "resume"
					? runtime.lifecycleService.resumeExternal(request as never)
					: operation === "fork"
						? runtime.forkLifecycleSession(request as never)
						: operation === "close"
							? runtime.closeLifecycleSession(request as never)
							: operation === "delete"
								? runtime.deleteLifecycleSession(request as never)
								: runtime.listLifecycleSessions(request as never));
		} catch (error) {
			if ((operation === "close" || operation === "delete") && key !== undefined)
				await requireRetired(runtime, key, error);
			throw error;
		}
		outcome = externalOutcome(outcome);
		if (!isLifecycleSuccess(outcome)) {
			if (operation === "close" || operation === "delete") {
				if (key === undefined)
					throw new ManagedTurnUncertainError("Managed retirement lacks an exact generation authority.");
				await requireRetired(runtime, key);
				return outcome;
			}
			if (isUncertainLifecycleOutcome(outcome))
				throw new ManagedTurnUncertainError(`Managed session.${operation} outcome is uncertain.`);
			throw new Error(lifecycleMessage(outcome, `Managed session.${operation} failed.`));
		}
		if (operation === "close" || operation === "delete") {
			if (key === undefined)
				throw new ManagedTurnUncertainError("Managed retirement lacks an exact generation authority.");
			await requireRetired(runtime, key);
		} else if (operation !== "list") {
			const lifecycleTenant = tenantFromLifecycle(authority, outcome, operation, target);
			if (lifecycleTenant === undefined)
				throw new Error("Managed lifecycle acknowledgement lacks the expected session id and positive generation.");
			try {
				return {
					outcome,
					tenant: lifecycleTenant,
					attachment: await runtime.registerLifecycleTenant(lifecycleTenant),
				} satisfies ManagedLifecycleResult;
			} catch (error) {
				// A successful lifecycle acknowledgement without current attachment proof
				// cannot be reinterpreted as failure. Retire this exact generation first.
				try {
					await lifecycle("close", {
						authority: { ...lifecycleTenant, requestKey: authority.requestKey },
						target: { sessionId: lifecycleTenant.sessionId, endpointGeneration: lifecycleTenant.generation },
						timeoutMs: input.timeoutMs,
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
	const query = async (
		authority: ManagedTurnAuthority,
		name: string,
		input: Readonly<Record<string, unknown>> = {},
		timeoutMs?: number,
	) => {
		if (!name) throw new TypeError("Managed query is required.");
		const items: unknown[] = [];
		const cursors = new Set<string>();
		let cursor: string | undefined;
		for (let page = 0; page < MAX_QUERY_PAGES; page += 1) {
			const result = await invoke(
				authority,
				{ type: "query_request", query: name, input: { ...input }, ...(cursor === undefined ? {} : { cursor }) },
				{ authority, operation: name, timeoutMs },
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
	const runTurn = async (
		operation: "turn.prompt" | "turn.follow_up" | "turn.abort_and_prompt" | "workflow.gate_answer",
		input: ManagedTurnInput | ManagedGateInput,
	): Promise<GjcTurnResult> => {
		throwIfAborted(input.signal);
		const authority = input.authority;
		const attachment = await acquire(authority);
		const events: GjcTurnEvent[] = [];
		const eventIds = new Set<string>();
		const observe = async (event: GjcTurnEvent) => {
			const identity = event.id ?? payloadHash(event.payload ?? { type: event.type, text: event.text });
			if (eventIds.has(identity)) return;
			eventIds.add(identity);
			events.push(event);
			await (input as ManagedTurnInput | ManagedGateInput).observer?.(event);
		};
		let closed = false;
		const subscription = runtime.prepareFrameSubscription(attachment, operation, async observed => {
			if (closed) return;
			const event = normalizeFrame({
				...observed.frame.body,
				...(observed.frame.seq === undefined ? {} : { seq: observed.frame.seq }),
				...(observed.frame.publicationId === undefined ? {} : { publicationId: observed.frame.publicationId }),
			});
			if (event !== undefined) await observe(event);
		});
		let dispatched = false;
		let abortPromise: Promise<Readonly<Record<string, unknown>>> | undefined;
		const cancelAfterDispatch = () => {
			if (!dispatched || abortPromise !== undefined) return;
			abortPromise = request({
				authority,
				operation: "turn.abort",
				input: { mode: "terminal", scope: "turn" },
				idempotencyKey: authority.requestKey,
			});
			void abortPromise.catch(() => undefined);
		};
		input.signal?.addEventListener("abort", cancelAfterDispatch, { once: true });
		try {
			const response = await request({
				...input,
				operation,
				input:
					operation === "workflow.gate_answer"
						? {
								id: (input as ManagedGateInput).gateId,
								response: (input as ManagedGateInput).answer,
								expectedSessionId: authority.sessionId,
							}
						: {
								text: (input as ManagedTurnInput).text,
							},
				onDispatch: () => {
					dispatched = true;
					input.onDispatch?.();
					if (input.signal?.aborted) cancelAfterDispatch();
				},
			});
			subscription.bind(decodeAcknowledgedCorrelation(response, authority));
			if (input.signal?.aborted) {
				await abortPromise;
				throw new GjcTurnCancelledError();
			}
			for (const event of responseEventsFrom(response)) await observe(event);
			await subscription.drain();
			const projected =
				"artifactProject" in input && input.artifactProject !== undefined
					? await input.artifactProject(events)
					: events;
			return {
				text: finalizedText(response, projected),
				events: projected,
				rawFrameCursor: frameCursor(events),
				eventCursor: projected.length,
			};
		} finally {
			input.signal?.removeEventListener("abort", cancelAfterDispatch);
			closed = true;
			subscription();
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
function decodeAcknowledgedCorrelation(
	result: Readonly<Record<string, unknown>>,
	authority: ManagedTurnAuthority,
): Readonly<{ commandId?: string; turnId?: string; publicationId?: string }> {
	const value = isRecord(result.result) ? result.result : result;
	const correlation = isRecord(value.correlation) ? value.correlation : value;
	const commandId = correlation.commandId;
	const turnId = correlation.turnId;
	const publicationId = correlation.publicationId;
	if (typeof commandId !== "string" && typeof turnId !== "string" && typeof publicationId !== "string")
		throw new Error("Managed Router acknowledgement lacks correlation identity.");
	if (typeof value.sessionId === "string" && value.sessionId !== authority.sessionId)
		throw new Error("Managed Router acknowledgement references a foreign session.");
	return {
		...(typeof commandId === "string" ? { commandId } : {}),
		...(typeof turnId === "string" ? { turnId } : {}),
		...(typeof publicationId === "string" ? { publicationId } : {}),
	};
}
function responseEventsFrom(result: Readonly<Record<string, unknown>>): readonly GjcTurnEvent[] {
	const value = isRecord(result.result) ? result.result : result;
	return Array.isArray(value.events)
		? value.events.map(normalizeFrame).filter((event): event is GjcTurnEvent => event !== undefined)
		: [];
}
function normalizeFrame(frame: Record<string, unknown>): GjcTurnEvent | undefined {
	const value = frame.type === "event" && isRecord(frame.payload) ? frame.payload : frame;
	if (typeof value.type !== "string") return undefined;
	const text = typeof value.text === "string" ? value.text : typeof value.delta === "string" ? value.delta : undefined;
	return {
		type: value.type,
		...(text === undefined ? {} : { text }),
		...(typeof value.id === "string" ? { id: value.id } : {}),
		payload: value,
	};
}
function finalizedText(result: Readonly<Record<string, unknown>>, events: readonly GjcTurnEvent[]): string {
	const value = isRecord(result.result) ? result.result : result;
	if (typeof value.finalizedAssistantText === "string") return value.finalizedAssistantText;
	if (typeof value.text === "string") return value.text;
	return events
		.filter(event => event.type === "message_update" && typeof event.text === "string")
		.map(event => event.text)
		.join("");
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
