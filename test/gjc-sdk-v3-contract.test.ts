import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type {
	PublicSdkSessionAttachment,
	PublicSdkSessionPort,
	PublicSdkTurnOutcome,
} from "../src/gjc/public-sdk-contract";
import { type LifecycleHost, sessionOperation } from "../src/gjc/public-sdk-lifecycle";
import { closeSession, type PublicSdkActionHost, setModel, setThinking } from "../src/gjc/public-sdk-session-actions";
import { parseSelection, parseSessionAuthority, parseState, SdkV3OperationError } from "../src/gjc/sdk-v3-protocol";
import { normalizeOpenWebUIModelId, parseCanonicalModelId } from "../src/live/models";
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
	test.each(["session.new", "session.branch"] as const)(
		"awaits durable discovered-successor persistence before %s attach, metadata, or descriptor binding failures",
		async operation => {
			for (const failure of ["attach", "metadata", "descriptor replacement"] as const) {
				const root = mkdtempSync(join(tmpdir(), "gjc-lifecycle-ack-"));
				const descriptorPath = join(root, "successor.json");
				const descriptor = JSON.stringify({ version: 1, url: "ws://127.0.0.1:1", token: "successor" });
				writeFileSync(descriptorPath, descriptor);
				const descriptorStat = statSync(descriptorPath);
				const successor: PublicSdkSessionAttachment = {
					sessionId: "successor",
					cwd: root,
					endpoint: { url: "ws://127.0.0.1:1", token: "successor" },
					authority: {
						descriptorPath,
						descriptorStat,
						payloadDigest: createHash("sha256").update(descriptor).digest("hex"),
						generation: descriptorStat.mtimeMs,
						expectedSessionId: "successor",
						expectedCwd: root,
					},
				};
				const predecessor: PublicSdkSessionAttachment = {
					...successor,
					sessionId: "predecessor",
					endpoint: { url: "ws://127.0.0.1:2", token: "predecessor" },
				};
				let mutations = 0;
				let persisted = false;
				const host: LifecycleHost = {
					connected: () => ({ attachment: predecessor }),
					mutate: async () => {
						mutations += 1;
						return operation === "session.new"
							? { created: true }
							: { selectedText: "selected", cancelled: false };
					},
					withAuthority: async (_timeout, effect) => effect(),
					discover: async () => successor,
					onDiscovered: async () => {
						await Promise.resolve();
						persisted = true;
					},
					attach: async () => {
						expect(persisted).toBe(true);
						if (failure === "attach") throw new Error("attach failed");
					},
					metadata: async () => {
						expect(persisted).toBe(true);
						if (failure === "metadata") throw new Error("metadata failed");
						if (failure === "descriptor replacement") writeFileSync(descriptorPath, `${descriptor}\n`);
						return { sessionId: "successor", cwd: root };
					},
					detach() {},
				};
				try {
					await expect(sessionOperation(host, operation, {}, "mutation-key", 1_000)).rejects.toThrow();
					expect(persisted).toBe(true);
					expect(mutations).toBe(1);
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			}
		},
	);

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
	test("Given released-0.11.6 blank config selection fields When reading fresh state Then the non-empty current catalog selection remains authoritative", () => {
		const metadata = { sessionId: "session-1", cwd: "/workspace" };
		const config = {
			mode: "default",
			model: "",
			thinking: "",
			steeringMode: "all",
			followUpMode: "all",
			interruptMode: "all",
		};
		const currentModels = [
			{
				provider: "anthropic",
				id: "claude-sonnet-4",
				current: true,
				currentThinkingLevel: "off",
			},
		];

		expect(parseState(metadata, config, currentModels, { sessionId: "session-1", cwd: "/workspace" })).toEqual({
			sessionId: "session-1",
			model: { provider: "anthropic", id: "claude-sonnet-4" },
			thinkingLevel: "off",
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
	test("accepts a full model.set tuple followed by a changed thinking.set acknowledgement", async () => {
		const canonical = normalizeOpenWebUIModelId("gjc-adapter.gjc/openai-codex/codex-auto-review:off");
		const selection = parseCanonicalModelId(canonical);
		if (selection === null) throw new TypeError("expected canonical OpenWebUI selection");
		expect(normalizeOpenWebUIModelId("first.gjc-adapter.gjc/openai-codex/codex-auto-review:off")).toBe(
			"first.gjc-adapter.gjc/openai-codex/codex-auto-review:off",
		);
		const mutations: unknown[] = [];
		let selected: typeof selection | undefined;
		const host = {
			authority: async <T>(_timeoutMs: number, effect: (client: never) => Promise<T>): Promise<T> =>
				effect(undefined as never),
			mutate: async (_client: never, operation: string, input: Record<string, unknown>) => {
				mutations.push({ operation, input });
				return operation === "thinking.set" ? { changed: true } : selection;
			},
			selectedModel: () => selected,
			setSelectedModel: (value: typeof selection | undefined) => {
				selected = value;
			},
			detach() {},
			connected: () => {
				throw new Error("not used by model.set");
			},
		} satisfies PublicSdkActionHost;

		await expect(setModel(host, selection, undefined, 1_000)).resolves.toEqual(selection);
		await expect(setThinking(host, "low", undefined, 1_000)).resolves.toEqual({
			...selection,
			thinkingLevel: "low",
		});
		expect(mutations).toEqual([
			{
				operation: "model.set",
				input: { id: "openai-codex/codex-auto-review", thinkingLevel: "off" },
			},
			{
				operation: "thinking.set",
				input: { level: "low" },
			},
		]);
		expect(selected).toEqual({ ...selection, thinkingLevel: "low" });
	});
	test("accepts only a full exact model.set tuple", async () => {
		const selection = { provider: "openai-codex", modelId: "codex-auto-review", thinkingLevel: "off" } as const;
		const cases: readonly [string, unknown, boolean][] = [
			["full tuple", selection, true],
			["tuple with status", { ...selection, status: "accepted" }, false],
			["tuple with unknown key", { ...selection, extra: true }, false],
			["empty result", {}, false],
			["blank tuple", { provider: "", modelId: "", thinkingLevel: "" }, false],
			["status-only acknowledgement", { status: "accepted" }, false],
			["partial tuple", { provider: "openai-codex" }, false],
			["mismatched tuple", { provider: "openai-codex", modelId: "other", thinkingLevel: "off" }, false],
			["error reply", { status: "error" }, false],
		];

		for (const [_name, result, accepted] of cases) {
			let selected: typeof selection | undefined;
			const host = {
				authority: async <T>(_timeoutMs: number, effect: (client: never) => Promise<T>): Promise<T> =>
					effect(undefined as never),
				mutate: async () => result,
				selectedModel: () => selected,
				setSelectedModel: (value: typeof selection | undefined) => {
					selected = value;
				},
				detach() {},
				connected: () => {
					throw new Error("not used by model.set");
				},
			} satisfies PublicSdkActionHost;

			if (accepted) {
				await expect(setModel(host, selection, undefined, 1_000)).resolves.toEqual(selection);
				expect(selected).toEqual(selection);
			} else {
				await expect(setModel(host, selection, undefined, 1_000)).rejects.toMatchObject({ code: "invalid_result" });
				expect(selected).toBeUndefined();
			}
		}
	});
	test("accepts only an exact { changed: true } thinking.set acknowledgement", async () => {
		const selected = { provider: "openai-codex", modelId: "codex-auto-review", thinkingLevel: "off" } as const;
		const cases: readonly [string, unknown, boolean][] = [
			["changed acknowledgement", { changed: true }, true],
			["matching tuple", { ...selected, thinkingLevel: "low" }, false],
			["changed acknowledgement with unknown key", { changed: true, extra: true }, false],
			["tuple with status", { ...selected, thinkingLevel: "low", status: "accepted" }, false],
			["tuple with unknown key", { ...selected, thinkingLevel: "low", extra: true }, false],
			["changed false", { changed: false }, false],
			["status-only acknowledgement", { status: "accepted" }, false],
			["empty result", {}, false],
			["blank tuple", { provider: "", modelId: "", thinkingLevel: "" }, false],
			["partial tuple", { changed: true, provider: selected.provider }, false],
			["status with changed acknowledgement", { changed: true, status: "accepted" }, false],
			["mismatched provider", { provider: "other", modelId: selected.modelId, thinkingLevel: "low" }, false],
			["mismatched model", { provider: selected.provider, modelId: "other", thinkingLevel: "low" }, false],
			["mismatched thinking", { ...selected }, false],
		];

		for (const [_name, result, accepted] of cases) {
			let current = selected;
			const host = {
				authority: async <T>(_timeoutMs: number, effect: (client: never) => Promise<T>): Promise<T> =>
					effect(undefined as never),
				mutate: async () => result,
				selectedModel: () => current,
				setSelectedModel: (value: typeof selected | undefined) => {
					if (value !== undefined) current = value;
				},
				detach() {},
				connected: () => {
					throw new Error("not used by thinking.set");
				},
			} satisfies PublicSdkActionHost;

			if (accepted)
				await expect(setThinking(host, "low", undefined, 1_000)).resolves.toEqual({
					...selected,
					thinkingLevel: "low",
				});
			else {
				await expect(setThinking(host, "low", undefined, 1_000)).rejects.toMatchObject({ code: "invalid_result" });
				expect(current).toEqual(selected);
			}
		}
	});
	test("detaches only after an exact released session.close acknowledgement", async () => {
		const cases: readonly [string, unknown, boolean][] = [
			["exact acknowledgement", { closed: true }, true],
			["additional key", { closed: true, status: "accepted" }, false],
			["closed false", { closed: false }, false],
			["empty object", {}, false],
			["null", null, false],
			["array", [], false],
			["string", "closed", false],
		];

		for (const [_name, result, accepted] of cases) {
			let detached = 0;
			const host = {
				authority: async <T>(_timeoutMs: number, effect: (client: never) => Promise<T>): Promise<T> =>
					effect(undefined as never),
				mutate: async () => result,
				selectedModel: () => undefined,
				setSelectedModel() {},
				detach: () => {
					detached += 1;
				},
				connected: () => {
					throw new Error("not used by session.close");
				},
			} satisfies PublicSdkActionHost;

			if (accepted) await expect(closeSession(host, undefined, 1_000)).resolves.toBeUndefined();
			else await expect(closeSession(host, undefined, 1_000)).rejects.toThrow();
			expect(detached).toBe(accepted ? 1 : 0);
		}
	});
	test("preserves a typed pre-acknowledgement failure without detaching", async () => {
		let mutated = 0;
		let detached = 0;
		const failure = new SdkV3OperationError("endpoint_stale", "close preflight failed");
		const host = {
			authority: async <T>(): Promise<T> => {
				throw failure;
			},
			mutate: async () => {
				mutated += 1;
				return { closed: true };
			},
			selectedModel: () => undefined,
			setSelectedModel() {},
			detach: () => {
				detached += 1;
			},
			connected: () => {
				throw new Error("not used by session.close");
			},
		} satisfies PublicSdkActionHost;

		await expect(closeSession(host, undefined, 1_000)).rejects.toBe(failure);
		expect(mutated).toBe(0);
		expect(detached).toBe(0);
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
		expect(Reflect.get(Reflect.get(manifest, "dependencies"), "@gajae-code/coding-agent")).toBe("0.11.6");
		expect(Reflect.get(manifest, "patchedDependencies")).toBeUndefined();
		expect(await Bun.file(join(root, "patches", "@gajae-code%2Fcoding-agent@0.10.0.patch")).exists()).toBe(false);
		expect(await Bun.file(join(root, "patches", "@gajae-code%2Fcoding-agent@0.11.6.patch")).exists()).toBe(false);
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
