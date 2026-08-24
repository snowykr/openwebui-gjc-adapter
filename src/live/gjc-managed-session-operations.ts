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
	readonly authority: ManagedTurnAuthority;
	readonly target: Readonly<Record<string, unknown>>;
	readonly timeoutMs?: number;
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
	readonly correlation: Readonly<{ commandId: string; turnId: string; sessionId: string }>;
	readonly observer?: (event: GjcTurnEvent) => void | Promise<void>;
}

export interface ManagedSessionOperations {
	readonly runtime: ManagedSdkRuntime;
	tenant(authority: ManagedTurnAuthority): TenantSessionKey;
	payloadHash(payload: unknown): string;
	create(input: ManagedLifecycleInput): Promise<unknown>;
	resume(input: ManagedLifecycleInput): Promise<unknown>;
	fork(input: ManagedLifecycleInput): Promise<unknown>;
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
	getState(authority: ManagedTurnAuthority, timeoutMs?: number): Promise<readonly unknown[]>;
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
		const key = tenant(authority);
		const actor = { namespace: "openwebui-gjc-adapter", id: authority.principalId };
		const requestKey = authority.requestKey;
		const target = { ...input.target };
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
			if (operation === "close" || operation === "delete") await requireRetired(runtime, key, error);
			throw error;
		}
		outcome = externalOutcome(outcome);
		if (!isLifecycleSuccess(outcome)) {
			if (operation === "close" || operation === "delete") {
				await requireRetired(runtime, key);
				return outcome;
			}
			if (isUncertainLifecycleOutcome(outcome))
				throw new ManagedTurnUncertainError(`Managed session.${operation} outcome is uncertain.`);
			throw new Error(lifecycleMessage(outcome, `Managed session.${operation} failed.`));
		}
		if (operation === "close" || operation === "delete") await requireRetired(runtime, key);
		else {
			try {
				await acquire(authority);
			} catch (error) {
				// A successful lifecycle acknowledgement without current attachment proof
				// cannot be reinterpreted as failure. Retire this exact generation first.
				try {
					await lifecycle("close", {
						authority,
						target: { sessionId: authority.sessionId, endpointGeneration: authority.generation },
						timeoutMs: input.timeoutMs,
					});
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
		return await invoke(
			input.authority,
			{
				type: "control_request",
				operation: input.operation,
				input: { ...(input.input ?? {}) },
				idempotencyKey: input.idempotencyKey ?? input.authority.requestKey,
			},
			input,
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
			const parsed = parsePage(result, name);
			if (items.length + parsed.items.length > MAX_QUERY_ITEMS)
				throw new Error(`Managed ${name} query exceeded item bound.`);
			items.push(...parsed.items);
			if (parsed.cursor === undefined) return items;
			if (cursors.has(parsed.cursor)) throw new Error(`Managed ${name} query repeated a continuation cursor.`);
			cursors.add(parsed.cursor);
			cursor = parsed.cursor;
		}
		throw new Error(`Managed ${name} query exceeded page bound.`);
	};
	const runTurn = async (
		operation: "turn.prompt" | "turn.follow_up" | "workflow.gate_answer",
		input: ManagedTurnInput | ManagedGateInput,
	): Promise<GjcTurnResult> => {
		throwIfAborted(input.signal);
		const authority = input.authority;
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
		let response: Readonly<Record<string, unknown>>;
		try {
			response = await request({
				...input,
				operation,
				input:
					operation === "workflow.gate_answer"
						? {
								id: (input as ManagedGateInput).gateId,
								response: (input as ManagedGateInput).answer,
								expectedSessionId: authority.sessionId,
							}
						: { text: (input as ManagedTurnInput).text },
				onDispatch: () => {
					dispatched = true;
					input.onDispatch?.();
					if (input.signal?.aborted) cancelAfterDispatch();
				},
			});
		} finally {
			input.signal?.removeEventListener("abort", cancelAfterDispatch);
		}
		if (input.signal?.aborted) {
			await abortPromise;
			throw new GjcTurnCancelledError();
		}
		throwIfAborted(input.signal);
		const correlation = "correlation" in input ? input.correlation : correlationFrom(response, authority.requestKey);
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
		const attachment = await acquire(authority);
		const unsubscribe = runtime.subscribeFrames(attachment, operation, correlation, async observed => {
			if (closed) return;
			const event = normalizeFrame(observed.frame as unknown as Record<string, unknown>);
			if (event === undefined) return;
			await observe(event);
		});
		try {
			// Router.request is the sole request settler. Subscriptions only project ordered frames.
			const responseEvents = responseEventsFrom(response);
			for (const event of responseEvents) {
				await observe(event);
			}
			const projected =
				"artifactProject" in input && input.artifactProject !== undefined
					? await input.artifactProject(events)
					: events;
			return {
				text: finalizedText(response, projected),
				events: projected,
				rawFrameCursor: 0,
				eventCursor: projected.length,
			};
		} finally {
			closed = true;
			unsubscribe();
		}
	};
	return {
		runtime,
		tenant,
		payloadHash,
		create: input => lifecycle("create", input),
		resume: input => lifecycle("resume", input),
		fork: input => lifecycle("fork", input),
		close: input => lifecycle("close", input),
		delete: input => lifecycle("delete", input),
		list: input => lifecycle("list", input),
		acquire,
		request,
		query,
		getState: (authority, timeoutMs) => query(authority, "session.state", {}, timeoutMs),
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
function isLifecycleSuccess(value: unknown): boolean {
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
function parsePage(
	frame: Readonly<Record<string, unknown>>,
	query: string,
): { readonly items: readonly unknown[]; readonly cursor?: string } {
	const result = isRecord(frame.result) ? frame.result : frame;
	if (!Array.isArray(result.items)) throw new Error(`Managed ${query} query response has no items array.`);
	const cursor = result.continuationCursor ?? result.cursor;
	if (cursor !== undefined && (typeof cursor !== "string" || cursor.length === 0))
		throw new Error(`Managed ${query} query has an invalid continuation cursor.`);
	return { items: result.items, ...(cursor === undefined ? {} : { cursor }) };
}
function correlationFrom(
	result: Readonly<Record<string, unknown>>,
	fallback: string,
): { readonly commandId: string; readonly turnId: string } {
	const value = isRecord(result.result) ? result.result : result;
	return {
		commandId: typeof value.commandId === "string" ? value.commandId : fallback,
		turnId: typeof value.turnId === "string" ? value.turnId : fallback,
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
	return { type: value.type, ...(typeof value.id === "string" ? { id: value.id } : {}), payload: value };
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
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
