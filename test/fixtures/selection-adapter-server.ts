#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { buildAdapterServerOptionsFromEnv } from "../../src/adapter-server-options";
import type { ProjectProvider } from "../../src/live/openai-routes";
import { startAdapterServer } from "../../src/server";

const observationPath = requireEnv("GJC_SELECTION_OBSERVATIONS");
const runtimeReceiptPath = requireEnv("GJC_SELECTION_RUNTIME_RECEIPT");
for (const [name, value] of [
	["GJC_SELECTION_OBSERVATIONS", observationPath],
	["GJC_SELECTION_RUNTIME_RECEIPT", runtimeReceiptPath],
	["GJC_OPENWEBUI_STATE_PATH", requireEnv("GJC_OPENWEBUI_STATE_PATH")],
	["GJC_OPENWEBUI_SESSION_ROOT", requireEnv("GJC_OPENWEBUI_SESSION_ROOT")],
])
	assertFixturePathIsIsolated(name, value);

function record(value: unknown): void {
	appendFileSync(observationPath, `${JSON.stringify(value)}\n`, "utf8");
}

const options = await buildAdapterServerOptionsFromEnv(process.env, {
	eventSink: input => record({ type: "event", input }),
	messageSink: input => record({ type: "message", input }),
});
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
		runner: {
			...runner,
			async run(input) {
				try {
					return await runner.run(input);
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
	handle.stop().then(
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
function assertFixturePathIsIsolated(name: string, value: string): void {
	const root = resolve(process.cwd());
	const candidate = resolve(value);
	const pathFromRoot = relative(root, candidate);
	if (isAbsolute(pathFromRoot) || pathFromRoot === ".." || pathFromRoot.startsWith(`..${"/"}`)) {
		throw new Error(`${name} must remain inside the selection fixture root`);
	}
}
