import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildAdapterServerOptionsFromEnv } from "../src/cli";
import { SESSION_AUTHORITY_V3_EPOCH } from "../src/gjc/session-authority-v3";
import type { LiveGatewayEventDeliveryInput } from "../src/live/chat-completions";
import { InMemoryOpenWebUIProjectionRepository } from "../src/openwebui/client";
import { createAdapterRequestHandler } from "../src/server";
import {
	chatRequest,
	FakeManagedSdkRuntime,
	managedPreparedAuthority,
	ownedModelReaderFixture,
	reserveTcpPort,
	stopProcess,
	waitForStartedServer,
	withModelReaderFixture,
	writeDirectV3Authority,
} from "./cli-fixtures";

const spawnedProcesses: Bun.Subprocess[] = [];
const healthStateRoots: string[] = [];

describe("adapter CLI service", () => {
	afterEach(async () => {
		await Promise.all(spawnedProcesses.map(stopProcess));
		spawnedProcesses.length = 0;
		await Promise.all(healthStateRoots.splice(0).map(root => fs.rm(root, { force: true, recursive: true })));
	});

	test("serves healthz from bun run start when configured from env", async () => {
		const port = await reserveTcpPort();
		const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-adapter-cli-health-"));
		const sessionRoot = path.join(stateRoot, "sessions");
		healthStateRoots.push(stateRoot);
		await writeDirectV3Authority(sessionRoot);
		const proc = Bun.spawn(["bun", "run", "start"], {
			cwd: process.cwd(),
			env: {
				...process.env,
				GJC_OPENWEBUI_MODE: "existing",
				GJC_OPENWEBUI_BIND_HOST: "127.0.0.1",
				GJC_OPENWEBUI_BIND_PORT: String(port),
				GJC_OPENWEBUI_OWNER_USER_ID: "owner-test",
				GJC_OPENWEBUI_STATE_PATH: path.join(stateRoot, "state"),
				GJC_OPENWEBUI_SESSION_ROOT: sessionRoot,
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

	test("prints top-level help without starting the environment-configured service", async () => {
		const proc = Bun.spawn(["bun", "bin/openwebui-gjc-adapter", "--help"], {
			cwd: process.cwd(),
			env: {
				...process.env,
				GJC_OPENWEBUI_MODE: "existing",
				GJC_OPENWEBUI_BIND_HOST: "127.0.0.1",
				GJC_OPENWEBUI_BIND_PORT: String(await reserveTcpPort()),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		spawnedProcesses.push(proc);

		const exitCode = await Promise.race([proc.exited, Bun.sleep(4_000).then(() => -1)]);

		expect(exitCode).toBe(0);
		if (!(proc.stdout instanceof ReadableStream)) throw new Error("expected CLI stdout");
		expect(await new Response(proc.stdout).text()).toContain("Usage: openwebui-gjc-adapter");
	});

	test("routes managed chat completions through the runtime fake when building options", async () => {
		// Given: a configured project and a managed runtime fake injected at the CLI boundary.
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-adapter-cli-"));
		const projectDirectory = path.join(workspace, "Demo Project");
		const sessionRoot = path.join(workspace, "sessions");
		await fs.mkdir(projectDirectory);
		await writeDirectV3Authority(sessionRoot);
		const runtime = new FakeManagedSdkRuntime();

		const options = await buildAdapterServerOptionsFromEnv(
			{
				...process.env,
				GJC_OPENWEBUI_MODE: "existing",
				GJC_OPENWEBUI_BIND_HOST: "127.0.0.1",
				GJC_OPENWEBUI_BIND_PORT: "8765",
				GJC_OPENWEBUI_ADAPTER_API_TOKEN: "adapter-token",
				GJC_OPENWEBUI_OWNER_USER_ID: "owner-test",
				GJC_OPENWEBUI_ALLOWED_PROJECT_ROOTS: workspace,
				GJC_OPENWEBUI_SESSION_ROOT: sessionRoot,
				GJC_OPENWEBUI_STATE_PATH: path.join(workspace, "adapter-state"),
				GJC_OPENWEBUI_PROJECTS: `${projectDirectory}|Demo Project`,
			},
			{ managedSdkRuntime: runtime },
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
			ownerUserId: "owner-test",
			preparedManagedAuthority: managedPreparedAuthority({
				projectId: project.id,
				canonicalWorkspace: projectDirectory,
				chatId: "chat-1",
				requestKey: "user-1",
			}),
		});

		// Then: the managed runtime is called through routing and assistant content is returned.
		expect(result).toEqual({ content: "assistant from gjc: hello" });
		expect(runtime.requests).toContainEqual(
			expect.objectContaining({
				operation: "turn.prompt",
				input: { text: "hello" },
				tenant: expect.objectContaining({
					principalId: "owner-test",
					projectId: "demo-project",
					chatId: "chat-1",
					generation: 1,
					leaseId: "fixture-lease",
					epoch: SESSION_AUTHORITY_V3_EPOCH,
				}),
			}),
		);
		expect(runtime.requests.filter(request => request.operation === "turn.prompt")).toHaveLength(1);
		expect(await fs.readFile(path.join(sessionRoot, "openwebui-session-mappings.json"), "utf8")).toContain("chat-1");
		expect(await fs.readFile(path.join(sessionRoot, "openwebui-session-mappings.json"), "utf8")).not.toContain(
			"sessionFile",
		);
	});

	test("delivers projected GJC events through the CLI event sink", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-adapter-cli-"));
		const projectDirectory = path.join(workspace, "Demo Project");
		const sessionRoot = path.join(workspace, "sessions");
		await fs.mkdir(projectDirectory);
		await writeDirectV3Authority(sessionRoot);
		const runtime = new FakeManagedSdkRuntime();
		runtime.events = [{ type: "tool_execution_start", id: "tool-1", text: "bash" }];
		const delivered: LiveGatewayEventDeliveryInput[] = [];
		const repository = new InMemoryOpenWebUIProjectionRepository();
		const options = await withModelReaderFixture(ownedModelReaderFixture(runtime), () =>
			buildAdapterServerOptionsFromEnv(
				{
					...process.env,
					GJC_OPENWEBUI_MODE: "existing",
					GJC_OPENWEBUI_BIND_HOST: "127.0.0.1",
					GJC_OPENWEBUI_BIND_PORT: "8765",
					GJC_OPENWEBUI_ADAPTER_API_TOKEN: "adapter-token",
					GJC_OPENWEBUI_OWNER_USER_ID: "owner-test",
					GJC_OPENWEBUI_ALLOWED_PROJECT_ROOTS: workspace,
					GJC_OPENWEBUI_SESSION_ROOT: sessionRoot,
					GJC_OPENWEBUI_STATE_PATH: path.join(workspace, "adapter-state"),
					GJC_OPENWEBUI_PROJECTS: `${projectDirectory}|Demo Project`,
				},
				{
					managedSdkRuntime: runtime,
					projectionRepository: repository,
					eventSink: input => {
						delivered.push(input);
					},
				},
			),
		);

		const handler = createAdapterRequestHandler({ routes: options.routes });
		const response = await handler(chatRequest({ userId: "normal-user" }));

		expect(response.status).toBe(200);
		expect(delivered).toHaveLength(1);
		expect(delivered[0]).toMatchObject({
			chatId: "chat-1",
			messageId: "assistant-1",
			ownerUserId: "normal-user",
			projectId: "openwebui",
		});
		expect(delivered[0]?.events).toMatchObject([
			{ type: "status", data: { description: "Tool started", done: false } },
			{ type: "status", data: { description: "agent_end", done: true } },
		]);
	});

	test("projects configured folders while building service options", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-adapter-cli-"));
		const projectDirectory = path.join(workspace, "Demo Project");
		const stateDirectory = path.join(workspace, "state");
		await fs.mkdir(projectDirectory);
		await writeDirectV3Authority(stateDirectory);
		const repository = new InMemoryOpenWebUIProjectionRepository();

		const options = await buildAdapterServerOptionsFromEnv(
			{
				...process.env,
				GJC_OPENWEBUI_MODE: "existing",
				GJC_OPENWEBUI_BIND_HOST: "127.0.0.1",
				GJC_OPENWEBUI_BIND_PORT: "8765",
				GJC_OPENWEBUI_ADAPTER_API_TOKEN: "adapter-token",
				GJC_OPENWEBUI_OWNER_USER_ID: "owner-test",
				GJC_OPENWEBUI_ALLOWED_PROJECT_ROOTS: workspace,
				GJC_OPENWEBUI_SESSION_ROOT: stateDirectory,
				GJC_OPENWEBUI_STATE_PATH: path.join(workspace, "adapter-state"),
				GJC_OPENWEBUI_PROJECTS: `${projectDirectory}|Demo Project`,
			},
			{ managedSdkRuntime: new FakeManagedSdkRuntime(), projectionRepository: repository },
		);

		expect(options.routes?.projects).toMatchObject([{ id: "demo-project", status: "linked" }]);
		expect(await repository.getFolder("owner-test", "gjc-project-demo-project")).toMatchObject({
			id: "gjc-project-demo-project",
			name: "Demo Project",
		});
	});

	test("requires forwarded user headers for CLI chat requests", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-adapter-cli-"));
		const projectDirectory = path.join(workspace, "Demo Project");
		const sessionRoot = path.join(workspace, "sessions");
		await fs.mkdir(projectDirectory);
		await writeDirectV3Authority(sessionRoot);
		const options = await buildAdapterServerOptionsFromEnv(
			{
				...process.env,
				GJC_OPENWEBUI_MODE: "existing",
				GJC_OPENWEBUI_BIND_HOST: "127.0.0.1",
				GJC_OPENWEBUI_BIND_PORT: "8765",
				GJC_OPENWEBUI_ADAPTER_API_TOKEN: "adapter-token",
				GJC_OPENWEBUI_OWNER_USER_ID: "owner-test",
				GJC_OPENWEBUI_ALLOWED_PROJECT_ROOTS: workspace,
				GJC_OPENWEBUI_SESSION_ROOT: sessionRoot,
				GJC_OPENWEBUI_STATE_PATH: path.join(workspace, "adapter-state"),
				GJC_OPENWEBUI_PROJECTS: `${projectDirectory}|Demo Project`,
			},
			{ managedSdkRuntime: new FakeManagedSdkRuntime() },
		);
		const handler = createAdapterRequestHandler({ routes: options.routes });

		const response = await handler(chatRequest({ includeOwnerHeader: false }));

		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ error: { code: "missing-forwarded-user" } });
	});

	test("uses an isolated normal-user workspace when no administrator is configured", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-adapter-cli-"));
		const projectDirectory = path.join(workspace, "Demo Project");
		const sessionRoot = path.join(workspace, "sessions");
		await fs.mkdir(projectDirectory);
		await writeDirectV3Authority(sessionRoot);
		const runtime = new FakeManagedSdkRuntime();
		const options = await withModelReaderFixture(ownedModelReaderFixture(runtime), () =>
			buildAdapterServerOptionsFromEnv(
				{
					...process.env,
					GJC_OPENWEBUI_MODE: "existing",
					GJC_OPENWEBUI_BIND_HOST: "127.0.0.1",
					GJC_OPENWEBUI_BIND_PORT: "8765",
					GJC_OPENWEBUI_ADAPTER_API_TOKEN: "adapter-token",
					GJC_OPENWEBUI_ALLOWED_PROJECT_ROOTS: workspace,
					GJC_OPENWEBUI_SESSION_ROOT: sessionRoot,
					GJC_OPENWEBUI_STATE_PATH: path.join(workspace, "adapter-state"),
					GJC_OPENWEBUI_PROJECTS: `${projectDirectory}|Demo Project`,
				},
				{ managedSdkRuntime: runtime },
			),
		);
		const handler = createAdapterRequestHandler({ routes: options.routes });

		const response = await handler(chatRequest({ userId: "unconfigured-owner" }));

		expect(response.status).toBe(200);
		expect(runtime.requests.filter(request => request.operation === "turn.prompt")).toHaveLength(1);
		expect(
			runtime.requests.find(request => request.operation === "turn.prompt")?.tenant.canonicalWorkspace,
		).toContain(path.join("workspaces", ""));
	});
});
