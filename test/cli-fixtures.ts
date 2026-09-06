import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { ManagedSdkRuntimeDependency } from "../src/gjc/managed-sdk-dependency";
import type {
	ManagedSdkAttachment,
	ManagedSdkFrameCorrelation,
	ManagedSdkFrameSubscription,
	ManagedSdkObservedFrame,
	ManagedSdkOwnerState,
	ManagedSdkPendingFrameSubscription,
	TenantSessionKey,
} from "../src/gjc/managed-sdk-runtime";
import { MANAGED_SESSION_AUTHORITY_EPOCH } from "../src/gjc/managed-session-authority";
import { SESSION_AUTHORITY_V3_EPOCH } from "../src/gjc/session-authority-v3";
import type {
	GjcContinueSessionInput,
	GjcSessionAddress,
	GjcSessionState,
	GjcSessionStateInput,
	GjcStartNewSessionInput,
	GjcTurnEvent,
	GjcTurnResult,
	GjcTurnRunner,
	ManagedGenerationProof,
	ManagedPreparedTurnAuthority,
	ManagedTurnAuthority,
} from "../src/gjc/turn-runner";
import { lifecycleFixture, managedPreparedAuthority as managedSessionAuthority } from "./gjc-lifecycle-fixtures";

export async function writeDirectV3Authority(sessionRoot: string): Promise<void> {
	await mkdir(sessionRoot, { recursive: true });
	const canonicalPath = path.join(sessionRoot, "openwebui-session-mappings.json");
	const canonical = Buffer.from(
		`${JSON.stringify({
			kind: "openwebui-gjc-session-authority",
			version: 3,
			authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
			mappings: [],
			provisionalOperations: [],
		})}\n`,
	);
	await writeFile(canonicalPath, canonical);
	await writeFile(
		`${canonicalPath}.v3-active.json`,
		`${JSON.stringify({
			kind: "openwebui-gjc-session-authority-active",
			version: 1,
			authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
			activationV3Digest: createHash("sha256").update(canonical).digest("hex"),
			source: { baseDigest: "0".repeat(64), walDigest: "0".repeat(64), walPresent: false },
		})}\n`,
	);
}

export function managedPreparedAuthority(options: {
	readonly principalId?: string;
	readonly projectId: string;
	readonly canonicalWorkspace: string;
	readonly chatId: string;
	readonly leaseId?: string;
	readonly requestKey: string;
}): ManagedPreparedTurnAuthority {
	return {
		principalId: options.principalId ?? "owner-test",
		projectId: options.projectId,
		canonicalWorkspace: path.resolve(options.canonicalWorkspace),
		chatId: options.chatId,
		leaseId: options.leaseId ?? "fixture-lease",
		epoch: SESSION_AUTHORITY_V3_EPOCH,
		requestKey: options.requestKey,
	};
}

export interface FakeManagedRequest {
	readonly operation: string;
	readonly tenant: TenantSessionKey;
	readonly input: Readonly<Record<string, unknown>>;
}

interface FakeManagedSession {
	tenant?: TenantSessionKey;
	status: "current" | "retired";
}

interface FakeManagedFrameSubscription {
	readonly managed: ManagedSdkAttachment;
	readonly operation: string;
	enqueue(frame: ManagedSdkObservedFrame["frame"]): void;
	detach(): void;
	drain(): Promise<void>;
}

/**
 * In-process direct managed-runtime fixture. It models the process-owned
 * Runtime/Router/lifecycle boundary rather than exposing a legacy turn runner
 * or endpoint/attachment injection seam to adapter startup.
 */
export class FakeManagedSdkRuntime implements ManagedSdkRuntimeDependency {
	state: ManagedSdkOwnerState = "new";
	events: GjcTurnEvent[] = [{ type: "assistant", text: "assistant from gjc" }];
	readonly requests: FakeManagedRequest[] = [];
	readonly tenants: TenantSessionKey[] = [];
	#nextSession = 1;
	#nextTurn = 1;
	readonly #sessions = new Map<string, FakeManagedSession>();
	readonly #attachments = new Map<string, ManagedSdkAttachment>();
	readonly #subscriptions = new Set<FakeManagedFrameSubscription>();

	async start(): Promise<void> {
		if (this.state === "new") this.state = "running";
	}

	async reconcile(): Promise<void> {
		if (this.state !== "running") throw new Error(`Fake managed runtime is ${this.state}.`);
	}

	async dispose(): Promise<void> {
		const subscriptions = [...this.#subscriptions];
		for (const subscription of subscriptions) subscription.detach();
		this.state = "stopped";
		await Promise.all(subscriptions.map(subscription => subscription.drain()));
	}

	registerTenant(key: TenantSessionKey): void {
		const existing = this.tenants.find(candidate => sameTenant(candidate, key));
		if (existing === undefined) this.tenants.push({ ...key });
	}

	unregisterTenant(key: TenantSessionKey): void {
		const index = this.tenants.findIndex(candidate => sameTenant(candidate, key));
		if (index >= 0) {
			this.tenants.splice(index, 1);
			this.#attachments.delete(sessionIdentity(key));
		}
	}

	async registerLifecycleTenant(key: TenantSessionKey): Promise<ManagedSdkAttachment> {
		this.registerTenant(key);
		return await this.acquireAttachment(key);
	}
	async proveLifecycleTenant(key: TenantSessionKey): Promise<ManagedSdkAttachment> {
		return this.registerLifecycleTenant(key);
	}

	async acquireAttachment(key: TenantSessionKey): Promise<ManagedSdkAttachment> {
		if (this.state !== "running") throw new Error("Fake managed runtime is not running.");
		if (!this.tenants.some(candidate => sameTenant(candidate, key)))
			throw new Error("Fake managed tenant is not registered.");
		const identity = sessionIdentity(key);
		const session = this.#sessions.get(identity);
		if (session?.status === "retired") throw new Error("Fake managed generation is retired.");
		if (session === undefined) this.#sessions.set(identity, { tenant: { ...key }, status: "current" });
		else if (session.tenant === undefined) session.tenant = { ...key };
		else if (!sameTenant(session.tenant, key)) throw new Error("Fake managed tenant authority changed.");
		let attachment = this.#attachments.get(identity);
		if (attachment === undefined) {
			const tenant = Object.freeze({ ...key });
			const token: ManagedSdkAttachment = Object.freeze({
				tenant,
				generation: tenant.generation,
				isCurrent: () =>
					this.state === "running" &&
					this.#attachments.get(identity) === token &&
					this.tenants.some(candidate => sameTenant(candidate, tenant)) &&
					this.#sessions.get(identity)?.status === "current",
			});
			attachment = token;
			this.#attachments.set(identity, attachment);
		}
		return attachment;
	}

	async generationStatus(key: TenantSessionKey): Promise<any> {
		return { status: this.#sessions.get(sessionIdentity(key))?.status ?? "current" };
	}

	prepareFrameSubscription(
		managed: ManagedSdkAttachment,
		operation: string,
		listener: (frame: ManagedSdkObservedFrame) => void | Promise<void>,
	): ManagedSdkPendingFrameSubscription {
		this.assertManagedAttachment(managed);
		if (this.state !== "running" || operation.trim().length === 0)
			throw new Error("Fake managed subscription requires a running runtime and operation.");
		const attachment = managed;
		let active = true;
		let correlation: ManagedSdkFrameCorrelation | undefined;
		let tail = Promise.resolve();
		const buffered: ManagedSdkObservedFrame["frame"][] = [];
		const enqueue = (frame: ManagedSdkObservedFrame["frame"]) => {
			if (!active) return;
			if (correlation === undefined) {
				buffered.push(frame);
				return;
			}
			const bound = correlation;
			if (
				(bound.commandId !== undefined && bound.commandId !== frame.commandId) ||
				(bound.turnId !== undefined && bound.turnId !== frame.turnId) ||
				(bound.publicationId !== undefined && bound.publicationId !== frame.publicationId)
			)
				return;
			tail = tail.then(async () => {
				if (!active) return;
				this.assertManagedAttachment(attachment);
				await listener({ tenant: attachment.tenant, operation, correlation: bound, frame });
			});
			void tail.catch(() => undefined);
		};
		const pending = (() => {
			active = false;
			buffered.length = 0;
			this.#subscriptions.delete(subscription);
		}) as ManagedSdkPendingFrameSubscription;
		pending.bind = acknowledged => {
			if (!active || correlation !== undefined)
				throw new Error("Fake managed subscription is closed or already bound.");
			this.assertManagedAttachment(attachment);
			if (
				![acknowledged.commandId, acknowledged.turnId, acknowledged.publicationId].some(
					value => typeof value === "string" && value.length > 0,
				)
			)
				throw new Error("Fake managed subscription requires acknowledged correlation.");
			correlation = { ...acknowledged };
			for (const frame of buffered) enqueue(frame);
			buffered.length = 0;
		};
		pending.drain = async () => {
			for (;;) {
				const current = tail;
				await current;
				if (current === tail) return;
			}
		};
		const subscription: FakeManagedFrameSubscription = {
			managed: attachment,
			operation,
			enqueue,
			detach: pending,
			drain: pending.drain,
		};
		this.#subscriptions.add(subscription);
		return pending;
	}

	subscribeFrames(
		managed: ManagedSdkAttachment,
		operation: string,
		correlation: ManagedSdkFrameCorrelation,
		listener: (frame: ManagedSdkObservedFrame) => void | Promise<void>,
	): ManagedSdkFrameSubscription {
		const subscription = this.prepareFrameSubscription(managed, operation, listener);
		try {
			subscription.bind(correlation);
		} catch (error) {
			subscription();
			throw error;
		}
		return subscription;
	}

	async request(
		managed: ManagedSdkAttachment,
		frame: Record<string, unknown>,
		options?: {
			readonly timeoutMs?: number;
			readonly beforeDispatch?: () => void | Promise<void>;
			readonly onDispatch?: () => void;
		},
	): Promise<Record<string, unknown>> {
		this.assertManagedAttachment(managed);
		await options?.beforeDispatch?.();
		options?.onDispatch?.();
		const operation = typeof frame.operation === "string" ? frame.operation : undefined;
		const query = typeof frame.query === "string" ? frame.query : undefined;
		const input = isRecord(frame.input) ? frame.input : {};
		if (operation === undefined && query === undefined) throw new Error("Fake managed request lacks operation.");
		this.requests.push({ operation: operation ?? query!, tenant: { ...managed.tenant }, input });
		if (query !== undefined) return this.queryResponse(query);
		if (operation === "model.set") {
			const id = typeof input.id === "string" ? input.id : "fixture/model";
			const separator = id.indexOf("/");
			return {
				type: "control_response",
				ok: true,
				result: {
					provider: separator < 0 ? "fixture" : id.slice(0, separator),
					modelId: separator < 0 ? id : id.slice(separator + 1),
					thinkingLevel: typeof input.thinkingLevel === "string" ? input.thinkingLevel : "off",
				},
			};
		}
		if (operation === "thinking.set") return { type: "control_response", ok: true, result: { changed: true } };
		if (operation === "turn.prompt" || operation === "turn.follow_up" || operation === "turn.abort_and_prompt") {
			const text = typeof input.text === "string" ? input.text : "";
			const turn = this.#nextTurn++;
			const correlation = { commandId: `command-fixture-${turn}`, turnId: `turn-fixture-${turn}` };
			const events = [...this.events, { type: "agent_end", finalText: `assistant from gjc: ${text}` }];
			for (const [index, event] of events.entries()) {
				const observed: ManagedSdkObservedFrame["frame"] = {
					name: "event",
					sessionId: managed.tenant.sessionId,
					generation: managed.generation,
					...correlation,
					seq: index + 1,
					body: { ...event, sessionId: managed.tenant.sessionId, ...correlation },
				};
				for (const subscription of this.#subscriptions) {
					if (subscription.operation === operation && sameTenant(subscription.managed.tenant, managed.tenant))
						subscription.enqueue(observed);
				}
			}
			return {
				type: "control_response",
				ok: true,
				result: { accepted: true, ...correlation },
			};
		}
		return {
			type: "control_response",
			ok: true,
			result: { accepted: true, commandId: "command-fixture", turnId: "turn-fixture" },
		};
	}

	async createPreparedExternalLifecycleSession(
		authority: ManagedPreparedTurnAuthority,
		_request: Readonly<Record<string, unknown>>,
	): Promise<Record<string, unknown>> {
		return this.createSession(authority);
	}

	async createExternalLifecycleSession(_request: any, _second?: any): Promise<any> {
		return this.createSession();
	}

	async createLifecycleSession(_request: any, _second?: any): Promise<any> {
		return this.createSession();
	}

	async resumeExternalLifecycleSession(_request: any, _second?: any): Promise<any> {
		return { ok: true, result: { sessionId: "session-fixture-resumed", endpointGeneration: 1 } };
	}

	async resumeLifecycleSession(_request: any, _second?: any): Promise<any> {
		return { ok: true, result: { sessionId: "session-fixture-resumed", endpointGeneration: 1 } };
	}

	async closeLifecycleSession(_tenantOrRequest: any, request?: any): Promise<any> {
		const first = isRecord(_tenantOrRequest) ? _tenantOrRequest : {};
		const target = isRecord(request?.target) ? request.target : isRecord(first.target) ? first.target : {};
		const sessionId = typeof target.sessionId === "string" ? target.sessionId : undefined;
		const generation = typeof target.endpointGeneration === "number" ? target.endpointGeneration : undefined;
		if (sessionId !== undefined && generation !== undefined) {
			const session = this.#sessions.get(`${sessionId}:${generation}`);
			if (session !== undefined) session.status = "retired";
		}
		return { ok: true, operation: "session.close", result: { sessionId } };
	}

	async deleteLifecycleSession(_tenantOrRequest: any, request?: any): Promise<any> {
		return await this.closeLifecycleSession(_tenantOrRequest, request);
	}

	private createSession(authority?: ManagedPreparedTurnAuthority): Record<string, unknown> {
		const sessionId = `session-fixture-${this.#nextSession++}`;
		const generation = 1;
		const tenant: TenantSessionKey = {
			principalId: authority?.principalId ?? "fixture-principal",
			projectId: authority?.projectId ?? "fixture-project",
			canonicalWorkspace: authority?.canonicalWorkspace ?? "/fixture/workspace",
			chatId: authority?.chatId ?? `fixture-chat-${this.#nextSession}`,
			sessionId,
			generation,
			leaseId: authority?.leaseId ?? "fixture-lease",
			epoch: authority?.epoch ?? MANAGED_SESSION_AUTHORITY_EPOCH,
		};
		this.#sessions.set(sessionIdentity(tenant), {
			tenant: authority === undefined ? undefined : tenant,
			status: "current",
		});
		this.registerTenant(tenant);
		return { ok: true, result: { sessionId, endpointGeneration: generation } };
	}

	private assertManagedAttachment(managed: ManagedSdkAttachment): void {
		if (!this.tenants.some(candidate => sameTenant(candidate, managed.tenant)))
			throw new Error("Fake managed tenant is not registered.");
		const identity = sessionIdentity(managed.tenant);
		if (this.#attachments.get(identity) !== managed || !managed.isCurrent())
			throw new Error("Fake managed attachment is not current.");
	}

	private queryResponse(query: string): Record<string, unknown> {
		if (query === "models.list/current") {
			return {
				type: "query_response",
				ok: true,
				page: {
					items: [
						{
							provider: "fixture",
							id: "model",
							reasoning: false,
							thinking: { validLevels: ["off"] },
						},
					],
					complete: true,
				},
			};
		}
		if (query === "providers.list/active") {
			return {
				type: "query_response",
				ok: true,
				page: { items: [{ provider: "fixture", connectionKind: "credentialless" }], complete: true },
			};
		}
		if (query === "session.state") {
			return {
				type: "query_response",
				ok: true,
				page: { items: [{ model: { provider: "fixture", id: "model" }, thinkingLevel: "off" }], complete: true },
			};
		}
		return { type: "query_response", ok: true, page: { items: [], complete: true } };
	}
}

export async function reserveTcpPort(): Promise<number> {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response("reserved"),
	});
	const port = server.port;
	await server.stop();
	if (typeof port === "number") return port;
	throw new Error("Bun did not allocate a TCP port");
}

export async function waitForStartedServer(proc: Bun.Subprocess, url: string): Promise<Response> {
	const abort = new AbortController();
	const stdout = observeSubprocessOutput(proc.stdout);
	const response = waitForHttpResponse(url, abort.signal);
	const exited = proc.exited.then(async code => {
		const [capturedStdout, stderr] = await Promise.all([stdout.complete, readSubprocessOutput(proc.stderr)]);
		throw new Error(`start command exited with ${code}\nstdout:\n${capturedStdout}\nstderr:\n${stderr}`);
	});
	exited.catch(() => undefined);
	try {
		return await Promise.race([response, exited]);
	} catch (error) {
		abort.abort();
		if (proc.exitCode === null) await stopProcess(proc);
		throw error;
	}
}

export const SERVER_START_DEADLINE_MS = 5_000;

export interface FailedStartCleanupReceipt {
	readonly deadlineMs: number;
	readonly pid: number;
	readonly port: number;
	readonly processExited: boolean;
	readonly root: string;
}

export interface RealSelectionStartOptions {
	readonly failStartup?: boolean;
	readonly invalidRunnerModel?: string;
	readonly catalogMode?: "capabilities" | "current-inherit";
	readonly onFailedCleanup?: (receipt: FailedStartCleanupReceipt) => void;
}

export async function stopProcess(proc: Bun.Subprocess): Promise<void> {
	proc.kill();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			proc.exited,
			new Promise<void>(resolve => {
				timeout = setTimeout(resolve, 500);
			}),
		]);
		if (proc.exitCode === null) proc.kill("SIGKILL");
		await proc.exited;
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

export class FakeGjcTurnRunner implements GjcTurnRunner {
	readonly starts: GjcStartNewSessionInput[] = [];
	events: GjcTurnResult["events"] = [{ type: "assistant", text: "assistant from gjc" }];
	readonly #managedAuthorities = new WeakMap<object, ManagedTurnAuthority>();

	async startManagedSession<T>(
		input: GjcStartNewSessionInput & { readonly preparedManagedAuthority: ManagedPreparedTurnAuthority },
		publish: (
			result: GjcSessionAddress & GjcTurnResult,
			lifecycle: ReturnType<typeof lifecycleFixture>,
		) => Promise<T>,
		beforePrompt: (
			address: GjcSessionAddress,
			proof: ManagedGenerationProof,
			lifecycle: ReturnType<typeof lifecycleFixture>,
		) => Promise<void>,
	): Promise<T> {
		const prepared = input.preparedManagedAuthority;
		if (
			prepared === undefined ||
			prepared.principalId !== input.principalId ||
			prepared.projectId !== input.projectId ||
			prepared.canonicalWorkspace !== input.cwd ||
			prepared.chatId !== input.chatId ||
			prepared.requestKey !== input.userMessageId ||
			![prepared.principalId, prepared.leaseId, prepared.epoch, prepared.requestKey].every(
				value => typeof value === "string" && value.trim().length > 0,
			)
		)
			throw new Error("CLI turn fixture requires exact prepared managed authority.");
		this.starts.push(input);
		const managedAuthority = managedSessionAuthority({
			...prepared,
			sessionId: "session-1",
			generation: 1,
		});
		const managedProof: ManagedGenerationProof = {
			kind: "managed-generation",
			sessionId: managedAuthority.sessionId,
			generation: managedAuthority.generation,
			leaseId: managedAuthority.leaseId,
			epoch: managedAuthority.epoch,
		};
		const result = {
			cwd: input.cwd,
			sessionRoot: input.sessionRoot,
			projectId: input.projectId,
			sessionId: "session-1",
			chatId: input.chatId,
			text: `assistant from gjc: ${input.text}`,
			events: this.events,
			sessionFile: path.join(input.sessionRoot, "session-1.jsonl"),
			activeLeaf: "leaf-1",
			rawFrameCursor: 1,
			eventCursor: 1,
			managedAuthority,
			managedProof,
			...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
		};
		const lifecycle = lifecycleFixture(result, managedAuthority);
		await beforePrompt(result, managedProof, lifecycle);
		return await publish(result, lifecycle);
	}

	async continueSession(input: GjcContinueSessionInput): Promise<GjcTurnResult> {
		const managedState = this.bindManagedAuthority(input);
		input.onDispatch?.();
		return {
			text: `continued: ${input.text}`,
			events: [{ type: "assistant", text: `continued: ${input.text}` }],
			sessionFile: input.sessionFile,
			activeLeaf: input.activeLeaf,
			rawFrameCursor: input.rawFrameCursor + 1,
			eventCursor: input.eventCursor + 1,
			...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
			...managedState,
		};
	}

	async withLifecyclePublication<T>(
		address: GjcSessionAddress,
		effect: (lifecycle: ReturnType<typeof lifecycleFixture>) => Promise<T>,
	): Promise<T> {
		const lifecycle = lifecycleFixture(address);
		lifecycle.publishManaged = async (proof, write) => {
			const authority = this.#managedAuthorities.get(lifecycle);
			if (authority === undefined) throw new Error("CLI fixture lifecycle has no managed authority.");
			return await lifecycleFixture(address, authority).publishManaged!(proof, write);
		};
		return await effect(lifecycle);
	}
	async getState(input: GjcSessionStateInput): Promise<GjcSessionState> {
		const managedState = this.bindManagedAuthority(input);
		return {
			sessionFile: input.sessionFile,
			activeLeaf: "leaf-1",
			rawFrameCursor: 1,
			eventCursor: 1,
			...managedState,
		};
	}

	private bindManagedAuthority(input: GjcSessionStateInput) {
		const authority = input.managedAuthority;
		if (
			authority === undefined ||
			authority.projectId !== input.projectId ||
			authority.canonicalWorkspace !== input.cwd ||
			authority.chatId !== input.chatId ||
			authority.sessionId !== input.sessionId ||
			!Number.isSafeInteger(authority.generation) ||
			authority.generation <= 0 ||
			![authority.principalId, authority.leaseId, authority.epoch, authority.requestKey].every(
				value => typeof value === "string" && value.trim().length > 0,
			)
		)
			throw new Error("CLI turn fixture requires exact managed session authority.");
		const bound = this.#managedAuthorities.get(input.lifecycle);
		if (
			bound !== undefined &&
			(Object.keys(bound) as (keyof ManagedTurnAuthority)[]).some(key => bound[key] !== authority[key])
		)
			throw new Error("CLI fixture lifecycle managed authority changed.");
		this.#managedAuthorities.set(input.lifecycle, { ...authority });
		return {
			managedAuthority: { ...authority },
			managedProof: {
				kind: "managed-generation" as const,
				sessionId: authority.sessionId,
				generation: authority.generation,
				leaseId: authority.leaseId,
				epoch: authority.epoch,
			},
		};
	}
}

function sessionIdentity(key: Pick<TenantSessionKey, "sessionId" | "generation">): string {
	return `${key.sessionId}:${key.generation}`;
}

function sameTenant(left: TenantSessionKey, right: TenantSessionKey): boolean {
	return (
		left.principalId === right.principalId &&
		left.projectId === right.projectId &&
		left.canonicalWorkspace === right.canonicalWorkspace &&
		left.chatId === right.chatId &&
		left.sessionId === right.sessionId &&
		left.generation === right.generation &&
		left.leaseId === right.leaseId &&
		left.epoch === right.epoch
	);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function chatRequest(
	options: { readonly includeOwnerHeader?: boolean; readonly userId?: string } = {},
): Request {
	const headers: Record<string, string> = {
		authorization: "Bearer adapter-token",
		"content-type": "application/json",
		"X-OpenWebUI-Chat-Id": "chat-1",
		"X-OpenWebUI-Message-Id": "assistant-1",
		"X-OpenWebUI-User-Message-Id": "user-1",
		"X-OpenWebUI-User-Message-Parent-Id": "",
	};
	if (options.includeOwnerHeader !== false) {
		headers["X-OpenWebUI-User-Id"] = options.userId ?? "owner-test";
	}
	return new Request("http://adapter.test/v1/chat/completions", {
		method: "POST",
		headers,
		body: JSON.stringify({ model: "gjc", messages: [{ role: "user", content: "hello" }] }),
	});
}

async function waitForHttpResponse(url: string, signal: AbortSignal): Promise<Response> {
	const startedAt = Date.now();
	let lastError: Error | null = null;
	while (Date.now() - startedAt < SERVER_START_DEADLINE_MS) {
		try {
			return await fetch(url, { signal });
		} catch (error) {
			if (signal.aborted) throw error;
			if (error instanceof Error) {
				lastError = error;
			} else {
				throw error;
			}
		}
		await Bun.sleep(50);
	}
	throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

function observeSubprocessOutput(output: Bun.Subprocess["stdout"]): {
	readonly ready: Promise<void>;
	readonly complete: Promise<string>;
} {
	if (!(output instanceof ReadableStream)) {
		const unavailable = Promise.reject(new Error("start command stdout is unavailable"));
		unavailable.catch(() => undefined);
		return { ready: unavailable, complete: Promise.resolve("") };
	}
	const reader = output.getReader();
	const decoder = new TextDecoder();
	let captured = "";
	let resolveReady: () => void;
	const ready = new Promise<void>(resolve => {
		resolveReady = resolve;
	});
	const complete = (async () => {
		try {
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				captured += decoder.decode(chunk.value, { stream: true });
				if (/openwebui-gjc-adapter listening on \S+/.test(captured)) resolveReady!();
			}
			captured += decoder.decode();
			if (/openwebui-gjc-adapter listening on \S+/.test(captured)) resolveReady!();
			return captured;
		} finally {
			reader.releaseLock();
		}
	})();
	ready.catch(() => undefined);
	return { ready, complete };
}
async function readSubprocessOutput(output: Bun.Subprocess["stdout"]): Promise<string> {
	if (output instanceof ReadableStream) return await new Response(output).text();
	return "";
}
