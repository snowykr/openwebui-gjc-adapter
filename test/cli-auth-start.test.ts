import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildAdapterServerOptionsFromEnv } from "../src/cli";
import { createAdapterRequestHandler } from "../src/server";
import { chatRequest, FakeGjcTurnRunner, reserveTcpPort, stopProcess, waitForStartedServer } from "./cli-fixtures";
import { CANONICAL_MODEL_IDS } from "./model-selection-fixtures";

const spawnedProcesses: Bun.Subprocess[] = [];

describe("adapter CLI auth and start", () => {
	afterEach(async () => {
		await Promise.all(spawnedProcesses.map(stopProcess));
		spawnedProcesses.length = 0;
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
				GJC_OPENWEBUI_STATE_PATH: path.join(workspace, "adapter-state"),
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
		const fixturePath = path.join(process.cwd(), "test/fixtures/gjc-rpc-selection-scenario.ts");
		await fs.chmod(fixturePath, 0o755);
		const proc = Bun.spawn(["bun", "run", "start"], {
			cwd: process.cwd(),
			env: {
				...process.env,
				GJC_OPENWEBUI_BIND_HOST: "127.0.0.1",
				GJC_OPENWEBUI_BIND_PORT: String(port),
				GJC_OPENWEBUI_ADAPTER_API_TOKEN: "adapter-token",
				GJC_OPENWEBUI_OWNER_USER_ID: "owner-test",
				GJC_OPENWEBUI_ALLOWED_PROJECT_ROOTS: workspace,
				GJC_OPENWEBUI_STATE_PATH: path.join(workspace, "adapter-state"),
				GJC_OPENWEBUI_PROJECTS: `${projectDirectory}|Demo Project`,
				GJC_OPENWEBUI_GJC_COMMAND: fixturePath,
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
		const body = (await modelsResponse.json()) as { object: string; data: { id: string }[] };
		expect(body.object).toBe("list");
		expect(body.data.map(model => model.id)).toEqual([...CANONICAL_MODEL_IDS]);
	});
});
