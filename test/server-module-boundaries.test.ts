import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, relative, resolve } from "node:path";
import {
	type AdapterRouteDependencies,
	type AdapterRuntimeConfig,
	type AdapterServerHandle,
	type AdapterServerOptions,
	createAdapterRequestHandler,
	initializeRuntimeReadiness,
	startAdapterServer,
} from "../src/server";

const ROOT = process.cwd();
const SOURCE_ROOT = join(ROOT, "src");
const SERVER_MODULES = ["server.ts", "server-runtime-readiness.ts", "live/openai-routes.ts"] as const;

function source(name: string): string {
	return readFileSync(join(SOURCE_ROOT, name), "utf8");
}

function pureLoc(value: string): number {
	return value.split("\n").filter(line => line.trim().length > 0 && !line.trimStart().startsWith("//")).length;
}

function internalImports(name: string): readonly string[] {
	const found: string[] = [];
	for (const match of source(name).matchAll(/(?:import|export)\s+[\s\S]*?\s+from\s+["'](\.\.?\/.+?)["']/g)) {
		const specifier = match[1];
		if (specifier === undefined) continue;
		const resolved = normalize(relative(SOURCE_ROOT, resolve(dirname(join(SOURCE_ROOT, name)), specifier)));
		const candidate = resolved.endsWith(".ts") ? resolved : `${resolved}.ts`;
		if (SERVER_MODULES.some(module => module === candidate)) found.push(candidate);
	}
	return [...new Set(found)].sort();
}

function expectAcyclic(): void {
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (name: string): void => {
		if (visiting.has(name)) throw new Error(`server module cycle at ${name}`);
		if (visited.has(name)) return;
		visiting.add(name);
		for (const dependency of internalImports(name)) visit(dependency);
		visiting.delete(name);
		visited.add(name);
	};
	for (const name of SERVER_MODULES) visit(name);
}

describe("server module boundaries", () => {
	test("preserves the public server contract and JavaScript arities", async () => {
		const runtimeRoot = mkdtempSync(join(tmpdir(), "gjc-server-module-boundaries-"));
		try {
			const runtime: AdapterRuntimeConfig = { adapterToken: "adapter", readinessToken: "ready" };
			const routes: AdapterRouteDependencies = {
				projects: [],
				owner: { ownerUserId: "owner", singleOwnerLocalMode: false },
				runner: { run: () => ({ content: "unused" }) },
			};
			const options: AdapterServerOptions = { host: "127.0.0.1", port: 0, runtimeRoot, runtime, routes };
			const handle: AdapterServerHandle | undefined = undefined;
			void options;
			void handle;

			const facade = await import("../src/server");
			expect(Object.keys(facade).sort()).toEqual([
				"createAdapterRequestHandler",
				"initializeRuntimeReadiness",
				"startAdapterServer",
			]);
			expect([
				createAdapterRequestHandler.length,
				initializeRuntimeReadiness.length,
				startAdapterServer.length,
			]).toEqual([0, 1, 1]);
		} finally {
			rmSync(runtimeRoot, { force: true, recursive: true });
		}
	});

	test("pins provider auth readiness route order and response bytes", async () => {
		const handler = createAdapterRequestHandler({
			checks: [{ name: "config", status: "ok" }],
			readiness: { openWebUIAuthenticated: true, promptHintsSeeded: true },
			routes: {
				projects: [],
				owner: { ownerUserId: "owner", singleOwnerLocalMode: false },
				runner: { run: () => ({ content: "unused" }) },
				adapterApiToken: "adapter-token",
				requireAdapterApiToken: true,
			},
		});

		const health = await handler(new Request("http://adapter.test/healthz"));
		const readiness = await handler(new Request("http://adapter.test/readyz"));
		const unauthorized = await handler(new Request("http://adapter.test/v1/models"));

		expect([health.status, await health.text()]).toEqual([
			200,
			'{"status":"ok","service":"openwebui-gjc-adapter","checks":[{"name":"config","status":"ok"}]}',
		]);
		expect([readiness.status, await readiness.text()]).toEqual([
			200,
			'{"status":"ready","service":"openwebui-gjc-adapter","identity":{"mode":"unknown"},"generation":null,"model":null,"seed":{"promptHints":"ready"}}',
		]);
		expect([unauthorized.status, await unauthorized.text()]).toEqual([
			401,
			'{"error":{"message":"Adapter API token is missing or invalid.","type":"authentication_error","code":"invalid_api_key"}}',
		]);
	});

	test("requires the exact extraction modules", () => {
		expect(SERVER_MODULES.map(name => [name, existsSync(join(SOURCE_ROOT, name))])).toEqual([
			["server.ts", true],
			["server-runtime-readiness.ts", true],
			["live/openai-routes.ts", true],
		]);
	});

	test("keeps every server module within the pure LOC limit", () => {
		for (const name of SERVER_MODULES.filter(module => existsSync(join(SOURCE_ROOT, module)))) {
			expect(pureLoc(source(name)), `${name} pure LOC`).toBeLessThanOrEqual(250);
		}
	});

	test("enforces the one-way acyclic extraction graph", () => {
		if (SERVER_MODULES.some(name => !existsSync(join(SOURCE_ROOT, name)))) return;
		expect(internalImports("server.ts")).toEqual(["live/openai-routes.ts", "server-runtime-readiness.ts"]);
		expect(internalImports("server-runtime-readiness.ts")).toEqual([]);
		expect(internalImports("live/openai-routes.ts")).toEqual([]);
		expect(source("live/openai-routes.ts")).not.toMatch(/from\s+["']\.\.\/server["']/);
		expectAcyclic();
	});
});
