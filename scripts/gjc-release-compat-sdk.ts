import { join, resolve } from "node:path";
import { lifecycle, router } from "@gajae-code/coding-agent/sdk";

export const lifecycleDeadlineMs = 15_000;
const lifecycleActor = { id: "gjc-release-compat", namespace: "release-compatibility" } as const;

type Observe = (name: string, action: () => Promise<unknown>) => Promise<unknown>;
type RequestOptions = { readonly timeoutMs?: number; readonly idempotencyKey?: string };
type FrameHandler = (frame: router.SessionRouterFrame) => void;

export type PublicSdkSession = {
	readonly sessionId: string;
	readonly generation: number;
	readonly attachment: router.SessionAttachment;
	query(query: string, input?: Record<string, unknown>, cursor?: string, options?: RequestOptions): Promise<unknown>;
	control(operation: string, input?: Record<string, unknown>, options?: RequestOptions): Promise<unknown>;
	onFrame(handler: FrameHandler): () => void;
	generationStatus(): Promise<router.SessionGenerationStatus>;
	close(): Promise<void>;
};

export type LifecycleAttachment = {
	readonly client: PublicSdkSession;
	readonly sessionId: string;
	readonly cwd: string;
	readonly generation: number;
};

type PublicSdkState = {
	readonly lifecycle: ReturnType<typeof lifecycle.createSessionLifecycleService>;
	readonly listeners: Set<{ readonly attachment: router.SessionAttachment; readonly handler: FrameHandler }>;
	readonly router: router.SessionRouter;
};

const states = new Map<string, PublicSdkState>();

function stateFor(directory: string): PublicSdkState {
	const key = resolve(directory);
	const existing = states.get(key);
	if (existing !== undefined) return existing;
	const listeners = new Set<{ readonly attachment: router.SessionAttachment; readonly handler: FrameHandler }>();
	const agentDir = join(key, ".gjc", "agent");
	const state = {} as PublicSdkState;
	const sdkRouter = new router.SessionRouter({
		agentDir,
		deps: {
			onFrame: (attachment, frame) => {
				for (const listener of listeners) if (listener.attachment === attachment) listener.handler(frame);
			},
		},
	});
	Object.assign(state, { lifecycle: lifecycle.createSessionLifecycleService(agentDir), listeners, router: sdkRouter });
	states.set(key, state);
	return state;
}

export async function startPublicSdk(directory: string): Promise<void> {
	await stateFor(directory).router.start();
}

export async function stopPublicSdk(directory: string): Promise<void> {
	const key = resolve(directory);
	const state = states.get(key);
	if (state === undefined) return;
	states.delete(key);
	await state.router.stop();
}

export function publicLifecycle(directory: string): ReturnType<typeof lifecycle.createSessionLifecycleService> {
	return stateFor(directory).lifecycle;
}

export async function connectFor(
	directory: string,
	sessionId: string,
	expectedGeneration?: number,
): Promise<PublicSdkSession> {
	const state = stateFor(directory);
	await startPublicSdk(directory);
	const deadline = Date.now() + lifecycleDeadlineMs;
	for (;;) {
		const attachment = state.router.attachment(sessionId, expectedGeneration);
		if (attachment?.isCurrent()) return sessionFor(state, attachment);
		const remaining = deadline - Date.now();
		if (remaining <= 0)
			throw new Error(`public SDK Router did not attach ${sessionId} before the lifecycle deadline`);
		await Bun.sleep(Math.min(100, remaining));
		await state.router.reconcile().catch(() => undefined);
	}
}

function sessionFor(state: PublicSdkState, attachment: router.SessionAttachment): PublicSdkSession {
	const sessionId = attachment.sessionId;
	const generation = attachment.generation;
	return {
		sessionId,
		generation,
		attachment,
		query: async (query, input = {}, cursor, options = {}) =>
			await state.router.request(
				sessionId,
				{ type: "query_request", query, input, ...(cursor === undefined ? {} : { cursor }) },
				generation,
				attachment,
				{ timeoutMs: options.timeoutMs },
			),
		control: async (operation, input = {}, options = {}) =>
			await state.router.request(
				sessionId,
				{
					type: "control_request",
					operation,
					input,
					...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
				},
				generation,
				attachment,
				{ timeoutMs: options.timeoutMs },
			),
		onFrame: handler => {
			const listener = { attachment, handler };
			state.listeners.add(listener);
			return () => state.listeners.delete(listener);
		},
		generationStatus: async () => await state.router.generationStatus(sessionId, generation),
		close: async () => undefined,
	};
}

export type PublicSessionIdentity = {
	readonly sessionId: string;
	readonly generation?: number;
};

export async function snapshotPublicSessions(directory: string): Promise<Map<string, PublicSessionIdentity>> {
	const response = await publicLifecycle(directory).list({
		actor: lifecycleActor,
		capability: "session.list",
		target: { cwd: resolve(directory) },
	});
	if (!response.ok || !Array.isArray(response.result.sessions))
		throw new Error("public lifecycle session.list returned an incomplete response");
	const sessions = new Map<string, PublicSessionIdentity>();
	for (const item of response.result.sessions) {
		if (!isRecord(item) || typeof item.sessionId !== "string") continue;
		const generation =
			typeof item.endpointGeneration === "number" && Number.isSafeInteger(item.endpointGeneration)
				? item.endpointGeneration
				: undefined;
		sessions.set(item.sessionId, { sessionId: item.sessionId, ...(generation === undefined ? {} : { generation }) });
	}
	return sessions;
}

export async function lifecycleSuccessor(
	_client: PublicSdkSession | undefined,
	operation: "session.create" | "session.resume" | "session.fork",
	input: Record<string, unknown>,
	workspace: string,
	observe: Observe,
	record: (name: string, value: unknown) => void,
	expectedSessionId?: string,
): Promise<LifecycleAttachment> {
	const before = await snapshotPublicSessions(workspace);
	const requestKey = `release-compat-${operation}-${crypto.randomUUID()}`;
	const service = publicLifecycle(workspace);
	const accepted = await observe(operation, () => {
		if (operation === "session.create")
			return service.create({
				actor: lifecycleActor,
				capability: "session.create",
				requestKey,
				target: input as lifecycle.SessionCreateTarget,
			});
		if (operation === "session.resume")
			return service.resume({
				actor: lifecycleActor,
				capability: "session.resume",
				requestKey,
				target: input as lifecycle.SessionResumeTarget,
			});
		return service.fork({
			actor: lifecycleActor,
			capability: "session.fork",
			requestKey,
			target: input as lifecycle.SessionForkTarget,
		});
	});
	const result = lifecycleResultFrom(accepted, operation);
	if (expectedSessionId !== undefined && operation !== "session.create" && result.sessionId !== expectedSessionId)
		throw new Error(`public lifecycle ${operation} returned the wrong target session`);
	const generation = result.endpointGeneration;
	await stateFor(workspace).router.reconcile();
	const successor = await connectFor(workspace, result.sessionId, generation);
	const metadata = sessionMetadataFrom(
		await observe(`${operation}.session.metadata`, () => successor.query("session.metadata", {}, undefined)),
	);
	if (metadata.sessionId !== successor.sessionId || metadata.cwd !== resolve(workspace))
		throw new Error(`public lifecycle ${operation} reattached to a metadata-mismatched session`);
	record(`${operation}.reattached`, {
		previousSessionCount: before.size,
		sessionId: successor.sessionId,
		generation: successor.generation,
		cwd: metadata.cwd,
		targetSessionId: expectedSessionId,
	});
	return { client: successor, sessionId: successor.sessionId, cwd: metadata.cwd, generation: successor.generation };
}

export async function closePublicSession(directory: string, sessionId: string, generation: number): Promise<unknown> {
	const requestKey = `release-compat-session-close-${sessionId}-${generation}-${crypto.randomUUID()}`;
	return await publicLifecycle(directory).close({
		actor: lifecycleActor,
		capability: "session.close",
		requestKey,
		target: { sessionId },
	});
}

function lifecycleResultFrom(
	value: unknown,
	operation: string,
): {
	readonly sessionId: string;
	readonly endpointGeneration?: number;
} {
	if (!isRecord(value) || value.ok !== true || !isRecord(value.result) || typeof value.result.sessionId !== "string")
		throw new Error(`public lifecycle ${operation} returned an unsuccessful or incomplete response`);
	const endpointGeneration =
		typeof value.result.endpointGeneration === "number" && Number.isSafeInteger(value.result.endpointGeneration)
			? value.result.endpointGeneration
			: undefined;
	return { sessionId: value.result.sessionId, endpointGeneration };
}

function sessionMetadataFrom(value: unknown): { readonly sessionId: string; readonly cwd: string } {
	if (
		!isRecord(value) ||
		value.ok !== true ||
		!isRecord(value.page) ||
		value.page.complete !== true ||
		!Array.isArray(value.page.items) ||
		value.page.items.length !== 1 ||
		!isRecord(value.page.items[0]) ||
		typeof value.page.items[0].sessionId !== "string" ||
		typeof value.page.items[0].cwd !== "string"
	)
		throw new Error("public SDK session.metadata returned an incomplete response");
	return { sessionId: value.page.items[0].sessionId, cwd: value.page.items[0].cwd };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
