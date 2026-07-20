import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildAdapterServerOptionsFromEnv } from "../src/cli";
import { createAdapterRequestHandler } from "../src/server";
import { chatRequest, FakeGjcTurnRunner, reserveTcpPort, stopProcess, waitForStartedServer } from "./cli-fixtures";
import { type SdkFixtureServer, startSdkFixtureServer } from "./gjc-sdk-v3-fixtures";
import { CANONICAL_MODEL_IDS } from "./model-selection-fixtures";

const spawnedProcesses: Bun.Subprocess[] = [];
const sdkServers: SdkFixtureServer[] = [];

describe("adapter CLI auth and start", () => {
	afterEach(async () => {
		await Promise.all(spawnedProcesses.map(stopProcess));
		spawnedProcesses.length = 0;
		for (const server of sdkServers) server.stop();
		sdkServers.length = 0;
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
		const fixturePath = path.join(process.cwd(), "test/fixtures/gjc-sdk-interactive-cli-session-fixture.ts");
		const fixtureTranscript = path.join(workspace, "sdk-cli.jsonl");
		const sdkServer = startSdkFixtureServer("model_catalog");
		sdkServers.push(sdkServer);
		await fs.writeFile(
			path.join(workspace, "gjc-sdk-fixture.json"),
			JSON.stringify({
				GJC_SDK_FIXTURE_CLI_TRANSCRIPT: fixtureTranscript,
				GJC_SDK_FIXTURE_ENDPOINT_URL: sdkServer.url,
				GJC_SDK_FIXTURE_ENDPOINT_TOKEN: sdkServer.token,
				GJC_SDK_FIXTURE_DYNAMIC_AUTHORITY: "1",
			}),
		);
		await fs.chmod(fixturePath, 0o755);
		const proc = Bun.spawn(["bun", "run", "start"], {
			cwd: process.cwd(),
			env: {
				...process.env,
				HOME: workspace,
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
		const body = (await modelsResponse.json()) as { object: string; data: { id: string }[] };
		expect({ status: modelsResponse.status, body }).toMatchObject({ status: 200 });
		expect(modelsResponse.status).toBe(200);
		expect(body.object).toBe("list");
		expect(body.data.map(model => model.id)).toEqual([...CANONICAL_MODEL_IDS]);
		expect(await fs.readFile(fixtureTranscript, "utf8")).toContain('"interactive":"create"');
		const transcriptEntries = (await fs.readFile(fixtureTranscript, "utf8"))
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as { readonly sessionCommand?: string; readonly sessionPath?: string });
		expect(transcriptEntries.filter(entry => entry.sessionCommand === "/session")).toHaveLength(1);
		expect(
			sdkServer.frames.filter(frame => frame.type === "control_request" && frame.operation === "session.close"),
		).toHaveLength(1);
		const sessionPath = transcriptEntries.find(
			(entry): entry is { readonly sessionPath: string } => typeof entry.sessionPath === "string",
		)?.sessionPath;
		expect(sessionPath).toBeDefined();
		if (sessionPath === undefined) throw new TypeError("fixture transcript has no published session path");
		const descriptor = path.join(
			path.dirname(path.dirname(path.dirname(sessionPath))),
			".gjc",
			"state",
			"sdk",
			`${path.basename(sessionPath, ".jsonl")}.json`,
		);
		expect(
			await fs.access(descriptor).then(
				() => true,
				() => false,
			),
		).toBe(false);
	});
});
