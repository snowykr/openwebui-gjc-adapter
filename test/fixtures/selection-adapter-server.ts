#!/usr/bin/env bun
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { router } from "@gajae-code/coding-agent/sdk";
import { buildAdapterServerOptionsFromEnv } from "../../src/adapter-server-options";
import { ManagedSdkOperationError, ManagedSdkRuntime, type TenantSessionKey } from "../../src/gjc/managed-sdk-runtime";
import { encodeSessionAuthorityV3Document, SESSION_AUTHORITY_V3_EPOCH } from "../../src/gjc/session-authority-v3";
import { createManagedModelReaderFactory } from "../../src/live/gjc-managed-model-reader";
import type { ModelReaderFactory } from "../../src/live/model-reader";
import type { ProjectProvider } from "../../src/live/openai-routes";
import { startAdapterServer } from "../../src/server";
import { withModelReaderFixture } from "../cli-fixtures";

const observationPath = requireEnv("GJC_SELECTION_OBSERVATIONS");
const runtimeReceiptPath = requireEnv("GJC_SELECTION_RUNTIME_RECEIPT");
const sessionRoot = requireEnv("GJC_OPENWEBUI_SESSION_ROOT");
const coordinatorUrl = requireEnv("GJC_SELECTION_COORDINATOR_URL");
for (const [name, value] of [
	["GJC_SELECTION_OBSERVATIONS", observationPath],
	["GJC_SELECTION_RUNTIME_RECEIPT", runtimeReceiptPath],
	["GJC_OPENWEBUI_STATE_PATH", requireEnv("GJC_OPENWEBUI_STATE_PATH")],
	["GJC_OPENWEBUI_SESSION_ROOT", sessionRoot],
])
	assertFixturePathIsIsolated(name, value);

writeCanonicalV3Authority(sessionRoot);

const selectionRuntime = createManagedSelectionRuntime(coordinatorUrl);
const managedRuntime = selectionRuntime.runtime;
const readerSettlements = new Set<Promise<void>>();
const readerSettlementFailures: unknown[] = [];
const registerReaderSettlement = (settled: Promise<void>): void => {
	readerSettlements.add(settled);
	void settled.then(
		() => readerSettlements.delete(settled),
		error => {
			readerSettlements.delete(settled);
			readerSettlementFailures.push(error);
		},
	);
};
// These scenarios exercise selection and projection against an explicitly fixture-owned session.
// They do not prove production temporary catalog creation or released exact cleanup.
const managedModelReaderFactory: ModelReaderFactory = (context, signal) =>
	createManagedModelReaderFactory({
		runtime: managedRuntime,
		registerSettlement: settled => {
			registerReaderSettlement(settled);
			context?.registerSettlement?.(settled);
		},
		resolveAttachment: async () => {
			await context?.lease?.assertFence();
			return {
				tenant: selectionRuntime.ownCatalog({
					principalId: context?.principal.userId ?? "owner-selection",
					projectId: context?.managedAuthority?.projectId ?? "openwebui",
					canonicalWorkspace:
						context?.workspace?.root ??
						join(process.env.HOME ?? process.cwd(), ".gjc", "openwebui", "default-reader"),
					chatId: context?.managedAuthority?.chatId ?? "selection-catalog",
					leaseId: context?.managedAuthority?.leaseId ?? "selection-catalog-lease",
					epoch: SESSION_AUTHORITY_V3_EPOCH,
				}),
			};
		},
	})(context, signal);

function record(value: unknown): void {
	appendFileSync(observationPath, `${JSON.stringify(value)}\n`, "utf8");
}

const options = await withModelReaderFixture(managedModelReaderFactory, () =>
	buildAdapterServerOptionsFromEnv(
		{ ...process.env, GJC_OPENWEBUI_MODE: "existing" },
		{
			managedSdkRuntime: managedRuntime,
			managedSdkTenantFence: authority =>
				Promise.resolve(
					authority.epoch === SESSION_AUTHORITY_V3_EPOCH && authority.leaseId === "selection-fixture-lease",
				),
			eventSink: input => record({ type: "event", input }),
			messageSink: input => record({ type: "message", input }),
		},
	),
);
writeFileSync(
	runtimeReceiptPath,
	JSON.stringify({
		pid: process.pid,
		argv: process.argv,
		cwd: process.cwd(),
		environment: receiptEnvironment(),
		config: {
			host: options.host,
			port: options.port,
			hasManagedRuntime: options.managedSdkRuntime?.runtime !== undefined,
			hasModelReader: options.routes?.modelReaderFactory !== undefined,
			statePath: process.env.GJC_OPENWEBUI_STATE_PATH,
			sessionRoot: process.env.GJC_OPENWEBUI_SESSION_ROOT,
			gjcCommand: process.env.GJC_OPENWEBUI_GJC_COMMAND,
			neutralWorkspace: options.routes?.neutralWorkspace,
		},
	}),
	"utf8",
);
if (process.env.GJC_SELECTION_FAIL_STARTUP === "1") throw new Error("induced selection fixture startup failure");
const routes = options.routes;
if (routes === undefined) throw new TypeError("selection routes are required");
const projectProvider = routes.projectProvider ?? routes.projects;
const invalidRunnerModel = process.env.GJC_SELECTION_INVALID_RUNNER_MODEL;
const runner = routes.runner;
const handle = await startAdapterServer({
	...options,
	routes: {
		...routes,
		modelReaderFactory: managedModelReaderFactory,
		runner: {
			...runner,
			async run(input) {
				const principalId = input.ownerUserId ?? "owner-selection";
				const workspaceRoot = resolve(input.project.cwd);
				const preparedManagedAuthority =
					input.preparedManagedAuthority ??
					(input.continued
						? undefined
						: {
								principalId,
								projectId: input.project.id,
								canonicalWorkspace: workspaceRoot,
								chatId: input.chatId,
								leaseId: "selection-fixture-lease",
								epoch: SESSION_AUTHORITY_V3_EPOCH,
								requestKey: input.userMessageId,
							});
				const managedInput = {
					...input,
					modelReaderContext: {
						registerSettlement: input.modelReaderContext?.registerSettlement ?? registerReaderSettlement,
						principal: { role: "user" as const, userId: principalId },
						workspace: {
							userId: principalId,
							safeKey: "selection-fixture-workspace",
							root: workspaceRoot,
							sessionRoot: join(workspaceRoot, ".gjc", "sessions"),
						},
						lease: { assertFence: async () => undefined },
						correlationId: `${input.chatId}:${input.userMessageId}`,
						...(preparedManagedAuthority === undefined ? {} : { managedAuthority: preparedManagedAuthority }),
					},
					...(preparedManagedAuthority === undefined ? {} : { preparedManagedAuthority }),
				};
				try {
					return await runner.run(managedInput);
				} catch (error) {
					record({
						type: "runner_failure",
						name: error instanceof Error ? error.name : typeof error,
						message: diagnosticMessage(error),
						code: typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined,
						stack: diagnosticStack(error),
						cause: diagnosticCause(error),
						operation: {
							chatId: input.chatId,
							userMessageId: input.userMessageId,
							requestedModelId: input.requestedModelId,
						},
					});
					throw error;
				}
			},
		},
		projectProvider: async () => {
			record({ type: "project_lookup" });
			return resolveProjects(projectProvider);
		},
		projectAdminFailureSink: error =>
			record({
				type: "admin_failure",
				name: error instanceof Error ? error.name : typeof error,
				message: diagnosticMessage(error),
				code: typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined,
				stack: diagnosticStack(error),
				cause: diagnosticCause(error),
			}),
		...(invalidRunnerModel === undefined
			? {}
			: { runner: { run: () => ({ content: "invalid runner result", model: invalidRunnerModel }) } }),
	},
});
console.log(`openwebui-gjc-adapter listening on ${handle.url}`);

function resolveProjects(provider: ProjectProvider) {
	return typeof provider === "function" ? provider() : provider;
}
function diagnosticMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return redactDiagnostic(message);
}

function diagnosticStack(error: unknown): string | undefined {
	return error instanceof Error && typeof error.stack === "string" ? redactDiagnostic(error.stack) : undefined;
}

function diagnosticCause(error: unknown): Record<string, unknown> | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const cause = Reflect.get(error, "cause");
	if (cause === undefined || cause === error) return undefined;
	return {
		name: cause instanceof Error ? cause.name : typeof cause,
		message: diagnosticMessage(cause),
		code: typeof cause === "object" && cause !== null ? Reflect.get(cause, "code") : undefined,
		stack: diagnosticStack(cause),
	};
}

function redactDiagnostic(value: string): string {
	return value
		.replace(/[^\x20-\x7E]/g, "�")
		.replace(/(?:[A-Za-z]:)?(?:\/[^\s\u0000]+)+/g, "[redacted]")
		.replace(/private|token|secret/gi, "[redacted]");
}

function stop(): void {
	(async () => {
		await handle.stop();
		await Promise.allSettled([...readerSettlements]);
		if (readerSettlementFailures.length > 0)
			throw new AggregateError(readerSettlementFailures, "Fixture reader cleanup failed");
	})().then(
		() => process.exit(0),
		() => process.exit(1),
	);
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);

function requireEnv(name: string): string {
	const value = process.env[name];
	if (value === undefined) throw new TypeError(`${name} is required`);
	return value;
}

function receiptEnvironment(): Record<string, string> {
	const keys = [
		"HOME",
		"TMPDIR",
		"GJC_CONFIG_DIR",
		"PI_CONFIG_DIR",
		"GJC_CODING_AGENT_DIR",
		"XDG_STATE_HOME",
		"XDG_DATA_HOME",
		"XDG_CACHE_HOME",
		"GJC_OPENWEBUI_BIND_HOST",
		"GJC_OPENWEBUI_BIND_PORT",
		"GJC_OPENWEBUI_TURN_TIMEOUT_MS",
		"GJC_OPENWEBUI_STATE_PATH",
		"GJC_OPENWEBUI_SESSION_ROOT",
		"GJC_OPENWEBUI_GJC_COMMAND",
	] as const;
	const environment = Object.fromEntries(keys.map(key => [key, requireEnv(key)]));
	environment.GJC_OPENWEBUI_ADAPTER_API_TOKEN_SHA256 = createHash("sha256")
		.update(requireEnv("GJC_OPENWEBUI_ADAPTER_API_TOKEN"))
		.digest("hex");
	return environment;
}

function writeCanonicalV3Authority(root: string): void {
	const canonicalPath = join(root, "openwebui-session-mappings.json");
	const markerPath = `${canonicalPath}.v3-active.json`;
	if (existsSync(canonicalPath) || existsSync(markerPath)) return;
	mkdirSync(root, { recursive: true });
	const canonical = Buffer.from(
		encodeSessionAuthorityV3Document({
			kind: "openwebui-gjc-session-authority",
			version: 3,
			authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
			mappings: [],
			provisionalOperations: [],
		}),
	);
	writeFileSync(canonicalPath, canonical);
	writeFileSync(
		markerPath,
		`${JSON.stringify({
			kind: "openwebui-gjc-session-authority-active",
			version: 1,
			authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
			activationV3Digest: createHash("sha256").update(canonical).digest("hex"),
			source: { baseDigest: "0".repeat(64), walDigest: "0".repeat(64), walPresent: false },
		})}\n`,
	);
}

function createManagedSelectionRuntime(baseUrl: string) {
	type SelectionSession = {
		readonly sessionId: string;
		readonly generation: number;
		readonly attachment: router.SessionAttachment;
		pendingGate: Record<string, unknown> | undefined;
		status: "current" | "retired";
	};
	const sessions = new Map<string, SelectionSession>();
	let nextGeneration = 0;
	let nextCorrelation = 0;
	let onFrame:
		| ((attachment: router.SessionAttachment, frame: router.SessionRouterFrame) => Promise<void> | void)
		| undefined;

	const sessionFor = (sessionId: string, generation: number): SelectionSession => {
		const key = `${sessionId}\u0000${generation}`;
		const existing = sessions.get(key);
		if (existing !== undefined) return existing;
		let session: SelectionSession;
		session = {
			sessionId,
			generation,
			pendingGate: undefined,
			status: "current",
			attachment: {
				sessionId,
				generation,
				isCurrent: () => session.status === "current",
				send: () => undefined,
			} as unknown as router.SessionAttachment,
		};
		sessions.set(key, session);
		return session;
	};

	const emit = async (
		session: SelectionSession,
		body: Record<string, unknown>,
		correlation: Readonly<{ commandId: string; turnId: string }>,
		seq: number,
	): Promise<void> => {
		await onFrame?.(session.attachment, {
			body: { ...body, sessionId: session.sessionId, ...correlation },
			name: "event",
			sessionId: session.sessionId,
			generation: session.generation,
			commandId: correlation.commandId,
			turnId: correlation.turnId,
			seq,
		});
	};

	const createSession = () => {
		const session = sessionFor(`selection-session-${randomUUID()}`, ++nextGeneration);
		return {
			ok: true as const,
			operation: "session.create" as const,
			result: { sessionId: session.sessionId, endpointGeneration: session.generation },
		};
	};
	const retireSession = (request: Record<string, unknown>) => {
		const target = request.target;
		const sessionId = isRecord(target) && typeof target.sessionId === "string" ? target.sessionId : undefined;
		const generation =
			isRecord(target) && typeof target.endpointGeneration === "number" ? target.endpointGeneration : 1;
		const session = sessionId === undefined ? undefined : sessionFor(sessionId, generation);
		if (session !== undefined) session.status = "retired";
		return {
			ok: true as const,
			operation: "session.close" as const,
			result: {
				sessionId: session?.sessionId ?? sessionId ?? "unknown",
				endpointGeneration: session?.generation ?? generation,
			},
		};
	};
	const lifecycle = {
		createExternal: async () => createSession(),
		fork: async () => createSession(),
		resumeExternal: async (request: Record<string, unknown>) => {
			const target = request.target;
			const requested =
				isRecord(target) && typeof target.sessionIdOrPrefix === "string" ? target.sessionIdOrPrefix : undefined;
			const session = requested === undefined ? createSession().result : sessionFor(requested, 1);
			return { ok: true as const, operation: "session.resume" as const, result: session };
		},
		close: async (request: Record<string, unknown>) => retireSession(request),
		delete: async (request: Record<string, unknown>) => retireSession(request),
		list: async () => ({
			ok: true as const,
			operation: "session.list" as const,
			result: { indexSeq: 1, sessions: [], warnings: [] },
		}),
	};

	const selectionRouter = {
		start: async () => undefined,
		stop: async () => undefined,
		reconcile: async () => undefined,
		attachment: (sessionId: string, generation?: number) =>
			generation === undefined ? null : sessionFor(sessionId, generation).attachment,
		generationStatus: async (sessionId: string, generation: number) => ({
			status: sessionFor(sessionId, generation).status,
			evidence: { source: "selection-fixture", observedIndexSeq: 1, evidenceIndexSeq: 1 },
		}),
		request: async (
			sessionId: string,
			frame: Record<string, unknown>,
			generation: number,
			expected: router.SessionAttachment,
			requestOptions?: { beforeDispatch?: (context: unknown) => void; onDispatch?: (context: unknown) => void },
		) => {
			const session = sessionFor(sessionId, generation);
			if (session.attachment !== expected || !session.attachment.isCurrent())
				throw new Error("Selection fixture Router attachment is not current.");
			requestOptions?.beforeDispatch?.({});
			requestOptions?.onDispatch?.({});
			if (frame.type === "query_request") return await queryCoordinator(session, frame);
			if (frame.type === "control_request") return await controlCoordinator(session, frame);
			throw new Error("Selection fixture Router request type is unsupported.");
		},
	} as unknown as router.SessionRouter;

	const runtime = new ManagedSdkRuntime({
		agentDir: join(process.env.HOME ?? process.cwd(), "managed-router-agent"),
		deps: {
			tenantFence: key => {
				if (
					!key.principalId ||
					!key.projectId ||
					!key.chatId ||
					resolve(key.canonicalWorkspace) !== key.canonicalWorkspace ||
					!key.leaseId ||
					key.epoch !== SESSION_AUTHORITY_V3_EPOCH
				)
					return false;
				if (sessions.has(`${key.sessionId}\u0000${key.generation}`)) return true;
				const document = JSON.parse(readFileSync(join(sessionRoot, "openwebui-session-mappings.json"), "utf8"));
				return document.mappings.some((mapping: { managedAuthority?: Record<string, unknown> }) => {
					const authority = mapping.managedAuthority;
					return (
						authority !== undefined &&
						Object.entries(key).every(([field, value]) =>
							field === "chatId"
								? authority.chatId === JSON.stringify([key.principalId, value])
								: authority[field] === value,
						)
					);
				});
			},
			preparedTenantFence: key =>
				key.principalId.length > 0 &&
				key.projectId.length > 0 &&
				key.chatId.length > 0 &&
				resolve(key.canonicalWorkspace) === key.canonicalWorkspace &&
				key.leaseId.length > 0 &&
				key.epoch === SESSION_AUTHORITY_V3_EPOCH &&
				key.requestKey.length > 0,
			createRouter: input => {
				onFrame = input.deps?.onFrame;
				return selectionRouter;
			},
			createLifecycleService: () => lifecycle as never,
		},
	});
	const runtimeWithFixtureOperations = runtime as unknown as {
		closeLifecycleSession: (tenantOrRequest: unknown, request?: unknown) => Promise<unknown>;
	};
	// Selection scenarios simulate lifecycle retirement, not SDK 0.16.4's unavailable
	// public exact-close authority. Real runtime close rejection has separate tests.
	runtimeWithFixtureOperations.closeLifecycleSession = async (tenantOrRequest, request) => {
		const tenant = request === undefined && isRecord(tenantOrRequest) ? tenantOrRequest.tenant : tenantOrRequest;
		const value = request ?? tenantOrRequest;
		if (
			!isRecord(tenant) ||
			!isRecord(value) ||
			!isRecord(value.target) ||
			!isRecord(value.actor) ||
			value.actor.id !== tenant.principalId ||
			value.target.sessionId !== tenant.sessionId ||
			value.target.endpointGeneration !== tenant.generation
		)
			throw new Error("Selection lifecycle fixture requires the exact tenant close target.");
		return lifecycle.close(value);
	};
	return {
		runtime,
		ownCatalog(scope: Omit<TenantSessionKey, "sessionId" | "generation">): TenantSessionKey {
			const session = sessionFor(`selection-catalog-${randomUUID()}`, ++nextGeneration);
			const tenant = { ...scope, sessionId: session.sessionId, generation: session.generation };
			runtime.registerTenant(tenant);
			return tenant;
		},
	};

	async function queryCoordinator(
		session: SelectionSession,
		frame: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const query = frame.query;
		if (query === "workflow.gates.list") {
			return {
				type: "query_response",
				ok: true,
				page: { items: session.pendingGate === undefined ? [] : [session.pendingGate], complete: true },
			};
		}
		if (query === "models.list/current") {
			const result = await coordinatorRequest("/catalog");
			if (!result.ok || !Array.isArray(result.value.models)) return queryFailure(result.message);
			return { type: "query_response", ok: true, page: { items: result.value.models, complete: true } };
		}
		if (query === "providers.list/active") {
			const result = await coordinatorRequest("/catalog");
			if (!result.ok || !Array.isArray(result.value.models)) return queryFailure(result.message);
			const providers = new Set<string>();
			for (const model of result.value.models)
				if (isRecord(model) && typeof model.provider === "string") providers.add(model.provider);
			return {
				type: "query_response",
				ok: true,
				page: {
					items: [...providers].map(provider => ({ provider, connectionKind: "credential" })),
					complete: true,
				},
			};
		}
		if (query === "session.state") {
			const result = await coordinatorRequest("/state");
			if (!result.ok) return queryFailure(result.message);
			const selection = result.value;
			return {
				type: "query_response",
				ok: true,
				page: {
					items: [
						{
							model: { provider: selection.provider, id: selection.modelId },
							thinkingLevel: selection.thinkingLevel,
						},
					],
					complete: true,
				},
			};
		}
		return { type: "query_response", ok: true, page: { items: [], complete: true } };
	}

	async function controlCoordinator(
		session: SelectionSession,
		frame: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const operation = frame.operation;
		const input = isRecord(frame.input) ? frame.input : {};
		if (operation === "model.set" || operation === "thinking.set") {
			const result =
				operation === "model.set"
					? await coordinatorRequest("/setter", {
							method: "POST",
							body: JSON.stringify(selectionSetterInput(input)),
						})
					: await currentThinkingSetter(input);
			if (!result.ok || !isRecord(result.value.selection))
				throw new ManagedSdkOperationError(
					operation === "model.set" ? "model_set_failed" : "thinking_set_failed",
					result.message,
				);
			return {
				type: "control_response",
				ok: true,
				result: operation === "model.set" ? result.value.selection : { changed: true },
			};
		}
		if (operation === "turn.prompt" || operation === "turn.follow_up") {
			const result = await coordinatorRequest("/prompt", { method: "POST" });
			if (!result.ok) throw new ManagedSdkOperationError("prompt_failed", result.message);
			const correlation = {
				commandId: `selection-command-${++nextCorrelation}`,
				turnId: `selection-turn-${nextCorrelation}`,
			};
			if (result.value.gate === true) {
				session.pendingGate = workflowGate(session, correlation);
				await emit(
					session,
					{
						type: "action_needed",
						kind: "ask",
						id: "selection-action-1",
						workflowGateId: session.pendingGate.gateId,
					},
					correlation,
					1,
				);
			} else {
				const assistant = await coordinatorRequest("/assistant");
				const text =
					assistant.ok && typeof assistant.value.text === "string"
						? assistant.value.text
						: "selection fixture assistant";
				await emit(session, { type: "message_update", id: "selection-assistant", text }, correlation, 1);
				await emit(session, { type: "agent_end", id: "selection-agent-end", finalText: text }, correlation, 2);
			}
			return { type: "control_response", ok: true, result: { accepted: true, ...correlation } };
		}
		if (operation === "workflow.gate_answer") {
			if (
				session.pendingGate === undefined ||
				input.id !== session.pendingGate.gateId ||
				input.expectedSessionId !== session.sessionId
			)
				throw new ManagedSdkOperationError("gate_response_failed", "Selection fixture gate target is not current.");
			const result = await coordinatorRequest("/gate", { method: "POST" });
			if (!result.ok) throw new ManagedSdkOperationError("gate_response_failed", result.message);
			session.pendingGate = undefined;
			const correlation = {
				commandId: `selection-command-${++nextCorrelation}`,
				turnId: `selection-turn-${nextCorrelation}`,
			};
			await emit(session, { type: "agent_end", id: "selection-agent-end", finalText: "" }, correlation, 1);
			return { type: "control_response", ok: true, result: { accepted: true, ...correlation } };
		}
		if (operation === "turn.abort") return { type: "control_response", ok: true, result: { accepted: true } };
		return { type: "control_response", ok: true, result: {} };
	}

	async function currentThinkingSetter(input: Record<string, unknown>) {
		const state = await coordinatorRequest("/state");
		return state.ok
			? await coordinatorRequest("/setter", {
					method: "POST",
					body: JSON.stringify({
						provider: state.value.provider,
						modelId: state.value.modelId,
						thinkingLevel: input.level,
					}),
				})
			: state;
	}

	function selectionSetterInput(input: Record<string, unknown>): Record<string, unknown> {
		const model = typeof input.id === "string" ? input.id : "";
		const separator = model.indexOf("/");
		return {
			provider: separator < 1 ? "" : model.slice(0, separator),
			modelId: separator < 1 ? "" : model.slice(separator + 1),
			thinkingLevel: input.thinkingLevel,
		};
	}

	async function coordinatorRequest(
		pathname: string,
		init: RequestInit = {},
	): Promise<{ readonly ok: boolean; readonly value: Record<string, any>; readonly message: string }> {
		try {
			const response = await fetch(`${baseUrl}${pathname}`, {
				...init,
				headers: { "content-type": "application/json", ...(init.headers ?? {}) },
			});
			const value: unknown = await response.json();
			const record = isRecord(value) ? value : {};
			return {
				ok: response.ok,
				value: record,
				message: typeof record.message === "string" ? record.message : `selection coordinator ${pathname} failed`,
			};
		} catch (error) {
			return { ok: false, value: {}, message: error instanceof Error ? error.message : String(error) };
		}
	}
}

function workflowGate(
	session: { readonly sessionId: string },
	correlation: Readonly<{ commandId: string; turnId: string }>,
): Record<string, unknown> {
	return {
		type: "workflow_gate",
		id: "gate-selection-1",
		gateId: "gate-selection-1",
		gate_id: "gate-selection-1",
		stage: "deep-interview",
		kind: "question",
		schemaHash: "sha256:selection-gate",
		schema_hash: "sha256:selection-gate",
		schema: {
			type: "object",
			required: ["selected"],
			properties: { selected: { type: "array", items: { type: "string" } } },
		},
		options: [{ label: "JWT", value: "JWT" }],
		context: { prompt: "Choose authentication method" },
		createdAt: "2026-07-13T00:00:00.000Z",
		created_at: "2026-07-13T00:00:00.000Z",
		required: true,
		status: "pending",
		sessionId: session.sessionId,
		...correlation,
	};
}

function queryFailure(message: string): Record<string, unknown> {
	return { type: "query_response", ok: false, error: { code: "fixture_query", message } };
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertFixturePathIsIsolated(name: string, value: string): void {
	const root = resolve(process.cwd());
	const candidate = resolve(value);
	const pathFromRoot = relative(root, candidate);
	if (isAbsolute(pathFromRoot) || pathFromRoot === ".." || pathFromRoot.startsWith(`..${"/"}`)) {
		throw new Error(`${name} must remain inside the selection fixture root`);
	}
}
