import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionMappingStore } from "../src/gjc/session-router";
import { createGjcRoutingLiveGatewayRunner } from "../src/live/gjc-routing-runner";
import { FakeGjcTurnRunner, project } from "./gjc-routing-runner-fixtures";

describe("createGjcRoutingLiveGatewayRunner", () => {
	test("awaits asynchronous transport cleanup when stopping", async () => {
		let cleaned = false;
		const turnRunner = Object.assign(new FakeGjcTurnRunner(), {
			async stop() {
				await Bun.sleep(20);
				cleaned = true;
			},
		});
		const runner = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings: new SessionMappingStore() });

		await runner.stop?.();

		expect(cleaned).toBe(true);
	});

	test("continues mapped HTTP-style turns through switchSession and getState", async () => {
		const turnRunner = new FakeGjcTurnRunner();
		const mappings = new SessionMappingStore();
		mappings.set({
			chatId: "chat-1",
			projectId: project.id,
			sessionId: "session-1",
			sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
			activeLeaf: "old-leaf",
			rawFrameCursor: 2,
			eventCursor: 1,
			operationId: "user-1",
		});
		const runner = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings });

		const result = await runner.run({
			project,
			prompt: "again",
			chatId: "chat-1",
			messageId: "assistant-2",
			userMessageId: "user-2",
			userMessageParentId: "user-1",
			continued: true,
		});

		expect(result).toEqual({ content: "continued:again" });
		expect(turnRunner.starts).toHaveLength(0);
		expect(turnRunner.switches).toHaveLength(1);
		expect(turnRunner.states).toHaveLength(1);
		expect(turnRunner.continues).toHaveLength(1);
		expect(turnRunner.continues[0]).toMatchObject({
			chatId: "chat-1",
			sessionId: "session-1",
			userMessageId: "user-2",
			parentId: "user-1",
			activeLeaf: "leaf-1",
			rawFrameCursor: 7,
			eventCursor: 3,
			operationId: "user-2",
		});
	});

	test("validates continuation transcripts against the SDK-owned session root", async () => {
		// Given: a stored SDK transcript outside the adapter's configured project session root.
		const turnRunner = new SdkSessionRootTurnRunner();
		const mappings = new SessionMappingStore();
		mappings.set({
			chatId: "chat-sdk",
			projectId: project.id,
			sessionId: "session-sdk",
			sessionFile: "/var/lib/gjc/agent/sessions/--workspace-project--/session-sdk.jsonl",
			rawFrameCursor: 0,
			eventCursor: 0,
			operationId: "user-1",
		});
		const runner = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings });

		// When: the mapped chat continues through the live routing surface.
		await runner.run({
			project: { ...project, sessionRoot: "/run/gjc-session" },
			prompt: "again",
			chatId: "chat-sdk",
			messageId: "assistant-2",
			userMessageId: "user-2",
			userMessageParentId: "user-1",
			continued: true,
		});

		// Then: the SDK path remains the continuation authority.
		expect(turnRunner.switches[0]?.sessionFile).toBe(
			"/var/lib/gjc/agent/sessions/--workspace-project--/session-sdk.jsonl",
		);
		expect(turnRunner.continues[0]?.sessionRoot).toBe("/var/lib/gjc/agent/sessions/--workspace-project--");
	});

	test("migrates a legacy mapped transcript into the SDK-owned root before continuation", async () => {
		const root = mkdtempSync(join(tmpdir(), "gjc-session-upgrade-"));
		const cwd = join(root, "project");
		const legacyRoot = join(cwd, ".gjc", "sessions");
		const sdkRoot = join(root, "agent", "sessions", "--project--");
		const legacyFile = join(legacyRoot, "session-legacy.jsonl");
		const sdkFile = join(sdkRoot, "session-legacy.jsonl");
		mkdirSync(legacyRoot, { recursive: true });
		writeFileSync(legacyFile, '{"type":"session"}\n');
		const upgradedProject = { ...project, cwd, allowedRoot: root, sessionRoot: legacyRoot };
		const turnRunner = new SdkSessionRootTurnRunner(sdkRoot, sdkFile);
		const mappings = new SessionMappingStore();
		mappings.set({
			chatId: "chat-legacy",
			projectId: project.id,
			sessionId: "session-legacy",
			sessionFile: legacyFile,
			rawFrameCursor: 0,
			eventCursor: 0,
			operationId: "user-1",
		});
		try {
			const runner = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings });
			await runner.run({
				project: upgradedProject,
				prompt: "continue after upgrade",
				chatId: "chat-legacy",
				messageId: "assistant-2",
				userMessageId: "user-2",
				userMessageParentId: "user-1",
				continued: true,
			});

			expect(readFileSync(sdkFile, "utf8")).toBe('{"type":"session"}\n');
			expect(turnRunner.switches[0]?.sessionFile).toBe(sdkFile);
			expect(mappings.get("chat-legacy")?.sessionFile).toBe(sdkFile);
			expect(readFileSync(legacyFile, "utf8")).toBe('{"type":"session"}\n');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

class SdkSessionRootTurnRunner extends FakeGjcTurnRunner {
	readonly #sdkRoot: string;

	constructor(
		sdkRoot = "/var/lib/gjc/agent/sessions/--workspace-project--",
		sessionFile = `${sdkRoot}/session-sdk.jsonl`,
	) {
		super();
		this.#sdkRoot = sdkRoot;
		this.state = { sessionFile, activeLeaf: "leaf-sdk", rawFrameCursor: 1, eventCursor: 1 };
	}

	resolveSessionRoot = (): string => this.#sdkRoot;
}
