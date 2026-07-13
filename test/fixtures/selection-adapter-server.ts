#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { buildAdapterServerOptionsFromEnv } from "../../src/adapter-server-options";
import type { ProjectProvider } from "../../src/live/openai-routes";
import { startAdapterServer } from "../../src/server";

const observationPath = requireEnv("GJC_SELECTION_OBSERVATIONS");
const runtimeReceiptPath = requireEnv("GJC_SELECTION_RUNTIME_RECEIPT");

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
const handle = startAdapterServer({
	...options,
	routes: {
		...routes,
		projectProvider: async () => {
			record({ type: "project_lookup" });
			return resolveProjects(projectProvider);
		},
		...(invalidRunnerModel === undefined
			? {}
			: { runner: { run: () => ({ content: "invalid runner result", model: invalidRunnerModel }) } }),
	},
});
console.log(`openwebui-gjc-adapter listening on ${handle.url}`);

function resolveProjects(provider: ProjectProvider) {
	return typeof provider === "function" ? provider() : provider;
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
