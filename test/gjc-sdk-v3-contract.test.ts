import { describe, expect, test } from "bun:test";
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { PublicSdkSessionPort, PublicSdkTurnOutcome } from "../src/gjc/public-sdk-contract";
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
			await fixture.attach();

			await expect(fixture.port.prompt("once only", 500)).rejects.toThrow();

			const prompts = fixture.server.frames.filter(
				frame => frame.type === "control_request" && frame.operation === "turn.prompt",
			);
			expect(prompts).toHaveLength(1);
		} finally {
			await fixture.dispose();
		}
	});

	test("Given current-dev Q10 metadata When crossing the public session boundary Then it remains available to policy", async () => {
		const port: Pick<PublicSdkSessionPort, "getAvailableModels"> = {
			async getAvailableModels() {
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
			},
		};

		await expect(port.getAvailableModels()).resolves.toEqual([
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
	test("Given public SDK turn events When consuming an outcome Then event records remain opaque public frames", () => {
		const outcome: PublicSdkTurnOutcome = {
			events: [{ type: "message_update", text: "hello" }],
			finalizedAssistantText: "hello",
		};

		expect(outcome.events).toEqual([{ type: "message_update", text: "hello" }]);
		expect(outcome.finalizedAssistantText).toBe("hello");
	});

	test("Given current-dev max thinking When model.set returns Then the normalized selection is accepted", () => {
		expect(parseSelection({ provider: "openai", modelId: "gpt-current", thinkingLevel: "max" })).toEqual({
			provider: "openai",
			modelId: "gpt-current",
			thinkingLevel: "max",
		});
	});

	test("Given model.set selection components When parsing Then provider delimiters are rejected without restricting model IDs", () => {
		expect(() => parseSelection({ provider: "openai/family", modelId: "model", thinkingLevel: "high" })).toThrow(
			"provider must not contain /",
		);
		expect(parseSelection({ provider: "openai", modelId: "org/model:v2/한글", thinkingLevel: "high" })).toEqual({
			provider: "openai",
			modelId: "org/model:v2/한글",
			thinkingLevel: "high",
		});
	});

	test("Given future capability metadata When enumerating canonical tuples Then supported levels remain usable", async () => {
		const fixture = createSdkTransportFixture("turn_complete");
		try {
			await fixture.attach();

			const models = await fixture.port.getAvailableModels();
			const selection = await fixture.port.setModel({
				provider: "future",
				modelId: "capable",
				thinkingLevel: "high",
			});

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

	test("Given repository delivery surfaces When inspected Then legacy transports and private lifecycle exports are absent", async () => {
		const root = join(import.meta.dir, "..");
		const manifest = await Bun.file(join(root, "package.json")).json();
		const sources = await inventorySources(root);
		const forbidden = [
			new RegExp(`\\b${legacyName("r", "pc")}(?:[-_](?:client|runner|frames|workflow|errors))\\b`, "i"),
			new RegExp(`\\b(?:parse|create)${legacyName("R", "pc")}\\w*\\b`),
			new RegExp(`--mode\\s+${legacyName("r", "pc")}\\b`, "i"),
			new RegExp(
				`\\b(?:private[-_\\s]+daemon|daemon\\/(?:runtime|control)|${legacyName("broker", "_hello")})\\b`,
				"i",
			),
		];
		expect(sources.filter(source => forbidden.some(pattern => pattern.test(source.text)))).toEqual([]);
		expect(await Bun.file(join(root, "src/gjc", `${legacyName("r", "pc")}-client-transport.ts`)).exists()).toBe(
			false,
		);
		expect(await Bun.file(join(root, "src/gjc", `${legacyName("r", "pc")}-client-runner.ts`)).exists()).toBe(false);
		expect(await Bun.file(join(root, "src/gjc", `${legacyName("r", "pc")}-runner.ts`)).exists()).toBe(false);
		expect(await Bun.file(join(root, "src/gjc", "sdk-v3-cli.ts")).exists()).toBe(false);
		const publicEntrypoint = await Bun.file(join(root, "src/index.ts")).text();
		for (const privateLifecycleModule of [
			"session-frames",
			"turn-runner",
			"cli-lifecycle-backend",
			"tmux-ownership",
		]) {
			expect(publicEntrypoint).not.toContain(`./gjc/${privateLifecycleModule}`);
		}
		const exports = Reflect.get(manifest, "exports");
		expect(Reflect.get(exports, "./gjc/*")).toBeUndefined();
		expect(Reflect.get(exports, "./gjc/public-sdk-contract")).toEqual({
			types: "./src/gjc/public-sdk-contract.ts",
			import: "./src/gjc/public-sdk-contract.ts",
		});
		expect(Reflect.get(Reflect.get(manifest, "dependencies"), "@gajae-code/coding-agent")).toBe("0.11.2");
		expect(Reflect.get(manifest, "patchedDependencies")).toBeUndefined();
		expect(await Bun.file(join(root, "patches", "@gajae-code%2Fcoding-agent@0.10.0.patch")).exists()).toBe(false);
		expect(await Bun.file(join(root, "patches", "@gajae-code%2Fcoding-agent@0.11.2.patch")).exists()).toBe(false);
	});
});

async function inventorySources(root: string): Promise<readonly { readonly path: string; readonly text: string }[]> {
	const paths = [
		join(root, "src"),
		join(root, "test"),
		join(root, ".github", "workflows"),
		join(root, "package.json"),
		join(root, "tsconfig.json"),
	];
	const files = await Promise.all(paths.map(path => inventoryFiles(path)));
	return Promise.all(
		files.flat().map(async path => ({
			path: relative(root, path),
			text: await Bun.file(path).text(),
		})),
	);
}

async function inventoryFiles(path: string): Promise<readonly string[]> {
	const metadata = await stat(path);
	if (metadata.isFile()) return [path];
	const entries = await readdir(path, { recursive: true, withFileTypes: true });
	return entries
		.filter(entry => entry.isFile() && /\.(?:ts|json|ya?ml)$/.test(entry.name))
		.map(entry => join(entry.parentPath, entry.name));
}

function legacyName(...parts: readonly string[]): string {
	return parts.join("");
}

const parseAuthorityWithExpectation = parseSessionAuthority;
