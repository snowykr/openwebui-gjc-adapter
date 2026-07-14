import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { RpcClientTransportClient } from "../src/gjc/rpc-client-transport";
import { createRpcTransportFromClient } from "../src/gjc/rpc-client-transport";
import type { GjcRpcRunnerTransportEvent, GjcRpcTransportState } from "../src/gjc/rpc-runner";
import { parseSelection, parseSessionAuthority } from "../src/gjc/sdk-v3-protocol";
import { createSdkTransportFixture } from "./gjc-sdk-v3-fixtures";

describe("latest dev SDK v3 transport contract", () => {
	test.each([
		["remote host", "ws://example.com:1234"],
		["credentials", "ws://user:pass@127.0.0.1:1234"],
		["query", "ws://127.0.0.1:1234/?token=leaked"],
		["fragment", "ws://127.0.0.1:1234/#secret"],
	])("Given a %s SDK endpoint When parsing lifecycle authority Then it is rejected", (_name, url) => {
		expect(() =>
			parseAuthorityWithExpectation(
				{ sessionId: "expected", cwd: "/workspace", endpoint: { url, token: "token" } },
				"session.create result",
				{ cwd: "/workspace" },
			),
		).toThrow();
	});

	test("Given lifecycle authority disagrees with the requested session When resuming Then it is rejected", () => {
		expect(() =>
			parseAuthorityWithExpectation(
				{
					sessionId: "unexpected",
					cwd: "/workspace",
					endpoint: { url: "ws://127.0.0.1:1234", token: "token" },
				},
				"session.resume result",
				{ cwd: "/workspace", sessionId: "expected" },
			),
		).toThrow();
	});

	test("Given a disconnected prompt mutation When reconnecting Then the mutation is never auto-resubmitted", async () => {
		const fixture = createSdkTransportFixture("disconnect");
		try {
			await fixture.transport.start();
			await fixture.transport.newSession();

			await expect(fixture.transport.promptAndWait("once only", 500)).rejects.toThrow();

			const prompts = fixture.server.frames.filter(
				frame => frame.type === "control_request" && frame.operation === "turn.prompt",
			);
			expect(prompts).toHaveLength(1);
		} finally {
			await fixture.dispose();
		}
	});

	test("Given current-dev Q10 metadata When crossing the transport boundary Then it remains available to policy", async () => {
		const client = new CurrentOnlyCatalogClient();
		const transport = createRpcTransportFromClient(client);

		await expect(transport.getAvailableModels()).resolves.toEqual([
			{
				provider: "openai",
				id: "gpt-current",
				name: "Current only",
				contextWindow: 128_000,
				maxTokens: 32_000,
				reasoning: true,
				thinking: { validLevels: ["off", "low", "xhigh", "max"] },
				current: true,
				currentThinkingLevel: "inherit",
			},
		]);
	});

	test("Given current-dev max thinking When model.set returns Then the normalized selection is accepted", () => {
		expect(parseSelection({ provider: "openai", modelId: "gpt-current", thinkingLevel: "max" })).toEqual({
			provider: "openai",
			modelId: "gpt-current",
			thinkingLevel: "max",
		});
	});

	test("Given future capability metadata When enumerating canonical tuples Then supported levels remain usable", async () => {
		const fixture = createSdkTransportFixture("turn_complete");
		try {
			await fixture.transport.start();
			await fixture.transport.newSession();

			const models = await fixture.transport.getAvailableModels();
			const selection = await fixture.transport.setDefaultModelSelection("future", "capable", "high");

			expect(models).toContainEqual(
				expect.objectContaining({
					provider: "future",
					id: "capable",
					reasoning: true,
					thinking: expect.objectContaining({ validLevels: ["off", "high"], levels: ["high"] }),
				}),
			);
			expect(selection).toEqual({ provider: "future", modelId: "capable", thinkingLevel: "high" });
		} finally {
			await fixture.dispose();
		}
	});

	test("Given production sources When inspected Then no legacy RpcClient or --mode rpc invocation remains", async () => {
		const root = join(import.meta.dir, "..");
		const transportSource = await Bun.file(join(root, "src/gjc/rpc-client-transport.ts")).text();
		const manifest = await Bun.file(join(root, "package.json")).json();
		const patchPath = join(root, "patches", "@gajae-code%2Fcoding-agent@0.10.0.patch");

		expect(transportSource).not.toContain("import { RpcClient }");
		expect(transportSource).not.toContain("new RpcClient(");
		expect(Reflect.get(Reflect.get(manifest, "dependencies"), "@gajae-code/coding-agent")).toBe("0.10.1");
		expect(Reflect.get(manifest, "patchedDependencies")).toBeUndefined();
		expect(await Bun.file(patchPath).exists()).toBe(false);
	});
});

const parseAuthorityWithExpectation = parseSessionAuthority;

class CurrentOnlyCatalogClient implements RpcClientTransportClient {
	async start(): Promise<void> {}
	stop(): void {}
	async newSession() {
		return { cancelled: false };
	}
	async switchSession() {
		return { cancelled: false };
	}
	async getState(): Promise<GjcRpcTransportState> {
		return { sessionId: "current-only" };
	}
	async getAvailableModels(): Promise<readonly unknown[]> {
		return [
			{
				provider: "openai",
				id: "gpt-current",
				name: "Current only",
				contextWindow: 128_000,
				maxTokens: 32_000,
				reasoning: true,
				thinking: { validLevels: ["off", "low", "xhigh", "max"] },
				current: true,
				currentThinkingLevel: "inherit",
			},
		];
	}
	async prompt(): Promise<void> {}
	onEvent(_listener: (event: GjcRpcRunnerTransportEvent) => void): () => void {
		return () => undefined;
	}
	onWorkflowGate(_listener: (event: GjcRpcRunnerTransportEvent) => void): () => void {
		return () => undefined;
	}
	async respondGate(): Promise<unknown> {
		return { status: "accepted" };
	}
	async getLastAssistantText(): Promise<string | null> {
		return null;
	}
	getStderr(): string {
		return "";
	}
}
