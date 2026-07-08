import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildAdapterServerOptionsFromEnv } from "../src/cli";
import type { LiveGatewayEventDeliveryInput } from "../src/live/chat-completions";
import { createAdapterRequestHandler } from "../src/server";
import { chatRequest, FakeGjcTurnRunner, reserveTcpPort, stopProcess, waitForStartedServer } from "./cli-fixtures";

const spawnedProcesses: Bun.Subprocess[] = [];

describe("adapter CLI service", () => {
	afterEach(async () => {
		await Promise.all(spawnedProcesses.map(stopProcess));
		spawnedProcesses.length = 0;
	});

	test("serves healthz from bun run start when configured from env", async () => {
		const port = await reserveTcpPort();
		const proc = Bun.spawn(["bun", "run", "start"], {
			cwd: process.cwd(),
			env: {
				...process.env,
				GJC_OPENWEBUI_BIND_HOST: "127.0.0.1",
				GJC_OPENWEBUI_BIND_PORT: String(port),
				GJC_OPENWEBUI_OWNER_USER_ID: "owner-test",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		spawnedProcesses.push(proc);

		const response = await waitForStartedServer(proc, `http://127.0.0.1:${port}/healthz`);

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			status: "degraded",
			service: "openwebui-gjc-adapter",
		});
	});

	test("routes chat completions through an injected GJC turn runner when building options", async () => {
		// Given: a configured project and a fake GJC turn runner injected at the CLI boundary.
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-adapter-cli-"));
		const projectDirectory = path.join(workspace, "Demo Project");
		const sessionRoot = path.join(workspace, "sessions");
		await fs.mkdir(projectDirectory);
		const turnRunner = new FakeGjcTurnRunner();

		const options = await buildAdapterServerOptionsFromEnv(
			{
				...process.env,
				GJC_OPENWEBUI_BIND_HOST: "127.0.0.1",
				GJC_OPENWEBUI_BIND_PORT: "8765",
				GJC_OPENWEBUI_ADAPTER_API_TOKEN: "adapter-token",
				GJC_OPENWEBUI_OWNER_USER_ID: "owner-test",
				GJC_OPENWEBUI_ALLOWED_PROJECT_ROOTS: workspace,
				GJC_OPENWEBUI_SESSION_ROOT: sessionRoot,
				GJC_OPENWEBUI_PROJECTS: `${projectDirectory}|Demo Project`,
			},
			{ turnRunner },
		);
		const routes = options.routes;
		if (routes === undefined) throw new Error("expected route dependencies");
		const project = routes.projects[0];
		if (project === undefined) throw new Error("expected configured project");

		// When: the route runner handles a chat completion turn.
		const result = await routes.runner.run({
			project,
			prompt: "hello",
			chatId: "chat-1",
			messageId: "assistant-1",
			userMessageId: "user-1",
			userMessageParentId: null,
			continued: false,
		});

		// Then: the injected turn runner is called through routing and assistant content is returned.
		expect(result).toEqual({ content: "assistant from gjc: hello" });
		expect(turnRunner.starts).toHaveLength(1);
		expect(turnRunner.starts[0]).toMatchObject({
			cwd: projectDirectory,
			projectId: "demo-project",
			chatId: "chat-1",
			userMessageId: "user-1",
			text: "hello",
		});
		expect(await fs.readFile(path.join(sessionRoot, "openwebui-session-mappings.json"), "utf8")).toContain("chat-1");
	});

	test("delivers projected GJC events through the CLI event sink", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-adapter-cli-"));
		const projectDirectory = path.join(workspace, "Demo Project");
		const sessionRoot = path.join(workspace, "sessions");
		await fs.mkdir(projectDirectory);
		const turnRunner = new FakeGjcTurnRunner();
		turnRunner.events = [{ type: "tool_execution_start", id: "tool-1", text: "bash" }];
		const delivered: LiveGatewayEventDeliveryInput[] = [];
		const options = await buildAdapterServerOptionsFromEnv(
			{
				...process.env,
				GJC_OPENWEBUI_BIND_HOST: "127.0.0.1",
				GJC_OPENWEBUI_BIND_PORT: "8765",
				GJC_OPENWEBUI_ADAPTER_API_TOKEN: "adapter-token",
				GJC_OPENWEBUI_OWNER_USER_ID: "owner-test",
				GJC_OPENWEBUI_ALLOWED_PROJECT_ROOTS: workspace,
				GJC_OPENWEBUI_SESSION_ROOT: sessionRoot,
				GJC_OPENWEBUI_PROJECTS: `${projectDirectory}|Demo Project`,
			},
			{
				turnRunner,
				eventSink: input => {
					delivered.push(input);
				},
			},
		);

		const handler = createAdapterRequestHandler({ routes: options.routes });
		const response = await handler(chatRequest());

		expect(response.status).toBe(200);
		expect(delivered).toHaveLength(1);
		expect(delivered[0]).toMatchObject({
			chatId: "chat-1",
			messageId: "assistant-1",
			ownerUserId: "owner-test",
			projectId: "demo-project",
		});
		expect(delivered[0]?.events).toHaveLength(1);
	});

	test("requires forwarded owner headers for CLI chat requests", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-adapter-cli-"));
		const projectDirectory = path.join(workspace, "Demo Project");
		await fs.mkdir(projectDirectory);
		const options = await buildAdapterServerOptionsFromEnv(
			{
				...process.env,
				GJC_OPENWEBUI_BIND_HOST: "127.0.0.1",
				GJC_OPENWEBUI_BIND_PORT: "8765",
				GJC_OPENWEBUI_ADAPTER_API_TOKEN: "adapter-token",
				GJC_OPENWEBUI_OWNER_USER_ID: "owner-test",
				GJC_OPENWEBUI_ALLOWED_PROJECT_ROOTS: workspace,
				GJC_OPENWEBUI_PROJECTS: `${projectDirectory}|Demo Project`,
			},
			{ turnRunner: new FakeGjcTurnRunner() },
		);
		const handler = createAdapterRequestHandler({ routes: options.routes });

		const response = await handler(chatRequest({ includeOwnerHeader: false }));

		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ error: { code: "missing-forwarded-owner" } });
	});

	test("does not accept a fallback owner when the CLI owner is unconfigured", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-adapter-cli-"));
		const projectDirectory = path.join(workspace, "Demo Project");
		await fs.mkdir(projectDirectory);
		const turnRunner = new FakeGjcTurnRunner();
		const options = await buildAdapterServerOptionsFromEnv(
			{
				...process.env,
				GJC_OPENWEBUI_BIND_HOST: "127.0.0.1",
				GJC_OPENWEBUI_BIND_PORT: "8765",
				GJC_OPENWEBUI_ADAPTER_API_TOKEN: "adapter-token",
				GJC_OPENWEBUI_ALLOWED_PROJECT_ROOTS: workspace,
				GJC_OPENWEBUI_PROJECTS: `${projectDirectory}|Demo Project`,
			},
			{ turnRunner },
		);
		const handler = createAdapterRequestHandler({ routes: options.routes });

		const response = await handler(chatRequest({ userId: "unconfigured-owner" }));

		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ error: { code: "owner-mismatch" } });
		expect(turnRunner.starts).toHaveLength(0);
	});

	test("rejects OpenAI-compatible requests when the adapter API token is not configured", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-adapter-cli-"));
		const projectDirectory = path.join(workspace, "Demo Project");
		await fs.mkdir(projectDirectory);
		const options = await buildAdapterServerOptionsFromEnv(
			{
				...process.env,
				GJC_OPENWEBUI_BIND_HOST: "127.0.0.1",
				GJC_OPENWEBUI_BIND_PORT: "8765",
				GJC_OPENWEBUI_OWNER_USER_ID: "owner-test",
				GJC_OPENWEBUI_ALLOWED_PROJECT_ROOTS: workspace,
				GJC_OPENWEBUI_PROJECTS: `${projectDirectory}|Demo Project`,
			},
			{ turnRunner: new FakeGjcTurnRunner() },
		);
		const handler = createAdapterRequestHandler({ routes: options.routes });

		const response = await handler(chatRequest());

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ error: { code: "adapter_api_token_unconfigured" } });
	});

	test("serves configured models from bun run start", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-adapter-cli-"));
		const projectDirectory = path.join(workspace, "Demo Project");
		await fs.mkdir(projectDirectory);
		const port = await reserveTcpPort();
		const proc = Bun.spawn(["bun", "run", "start"], {
			cwd: process.cwd(),
			env: {
				...process.env,
				GJC_OPENWEBUI_BIND_HOST: "127.0.0.1",
				GJC_OPENWEBUI_BIND_PORT: String(port),
				GJC_OPENWEBUI_ADAPTER_API_TOKEN: "adapter-token",
				GJC_OPENWEBUI_OWNER_USER_ID: "owner-test",
				GJC_OPENWEBUI_ALLOWED_PROJECT_ROOTS: workspace,
				GJC_OPENWEBUI_PROJECTS: `${projectDirectory}|Demo Project`,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		spawnedProcesses.push(proc);
		await waitForStartedServer(proc, `http://127.0.0.1:${port}/healthz`);

		const modelsResponse = await fetch(`http://127.0.0.1:${port}/v1/models`, {
			headers: { authorization: "Bearer adapter-token" },
		});
		expect(modelsResponse.status).toBe(200);
		expect(await modelsResponse.json()).toMatchObject({
			object: "list",
			data: [{ id: "gjc/demo-project", object: "model", owned_by: "gjc" }],
		});
	});
});
