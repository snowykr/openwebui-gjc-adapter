import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionMappingStore } from "../src/gjc/session-router";
import type { GjcControlResult, GjcTurnRunner } from "../src/gjc/turn-runner";
import type { LiveGatewayRunnerInput } from "../src/live/chat-completions";
import { controlOperationHash } from "../src/live/gjc-routing-publication";
import { createGjcRoutingLiveGatewayRunner, createPublicSdkGjcTurnRunner } from "../src/live/gjc-routing-runner";
import { attachmentProof } from "./gjc-lifecycle-fixtures";
import { FakeGjcTurnRunner, project } from "./gjc-routing-runner-fixtures";

function legacyTranscriptHeader(id: string, cwd: string): string {
	return `${JSON.stringify({
		type: "session",
		version: 3,
		id,
		timestamp: "2026-07-20T00:00:00.000Z",
		cwd,
	})}\n`;
}

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
	test("uses the configured project session root with the production public SDK runner", async () => {
		const delegate = new FakeGjcTurnRunner();
		const turnRunner = Object.assign(
			createPublicSdkGjcTurnRunner({
				cliPath: "/missing-gjc-cli",
				runtimeLocations: {
					home: "/tmp",
					configDomain: "/tmp/.gjc",
					agentDir: "/tmp/.gjc",
					readerWorkspace: "/tmp",
					readerSessionRoot: "/tmp/.gjc/sessions",
					protectedProjectPaths: ["/tmp", "/tmp/.gjc", "/tmp/.gjc/sessions", "/tmp/.gjc/state"],
					childEnvironment: { HOME: "/tmp", GJC_CONFIG_DIR: "/tmp/.gjc", GJC_CODING_AGENT_DIR: "/tmp/.gjc" },
				},
				turnTimeoutMs: 1_000,
			}),
			{ startNewSession: delegate.startNewSession.bind(delegate) },
		);
		const runner = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings: new SessionMappingStore() });
		const sessionRoot = "/configured/gjc-sessions";

		expect(turnRunner.resolveSessionRoot).toBeUndefined();

		await runner.run({
			project: { ...project, sessionRoot },
			prompt: "start",
			chatId: "chat-configured-root",
			messageId: "assistant-1",
			userMessageId: "user-1",
			userMessageParentId: null,
			continued: false,
		});

		expect(delegate.starts[0]?.sessionRoot).toBe(sessionRoot);
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
		const legacyTranscript = legacyTranscriptHeader("session-legacy", cwd);
		writeFileSync(legacyFile, legacyTranscript);
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

			expect(readFileSync(sdkFile, "utf8")).toBe(legacyTranscript);
			expect(turnRunner.switches[0]?.sessionFile).toBe(sdkFile);
			expect(mappings.get("chat-legacy")?.sessionFile).toBe(sdkFile);
			expect(readFileSync(legacyFile, "utf8")).toBe(legacyTranscript);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	test("checkpoints only an acknowledged session.new before a failed successor publication", async () => {
		const mappings = new SessionMappingStore();
		mappings.set({
			chatId: "chat-control",
			projectId: project.id,
			sessionId: "predecessor",
			sessionFile: "/workspace/project/.gjc/sessions/predecessor.jsonl",
			operationId: "prior",
			rawFrameCursor: 0,
			eventCursor: 0,
		});
		const acknowledgements: Array<{ readonly kind: string; readonly detail: string | undefined }> = [];
		class AcknowledgingRunner extends FakeGjcTurnRunner {
			calls = 0;

			async runControl(
				input: LiveGatewayRunnerInput,
				_mapping: Parameters<NonNullable<GjcTurnRunner["runControl"]>>[1],
				_lifecycle: Parameters<NonNullable<GjcTurnRunner["runControl"]>>[2],
				onAcknowledgedSuccessor?: Parameters<NonNullable<GjcTurnRunner["runControl"]>>[3],
			): Promise<GjcControlResult> {
				this.calls++;
				const operation = mappings.operation(input.chatId, input.userMessageId);
				acknowledgements.push({ kind: operation?.kind ?? "", detail: operation?.detail });
				await onAcknowledgedSuccessor?.({
					sessionId: "successor",
					attachment: attachmentProof({ cwd: project.cwd, sessionId: "successor" }),
				});
				throw new Error("transcript discovery failed");
			}
		}
		const turnRunner = new AcknowledgingRunner();
		const runner = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings });
		const turn: LiveGatewayRunnerInput = {
			project,
			prompt: "",
			chatId: "chat-control",
			messageId: "assistant-control",
			userMessageId: "control-new",
			userMessageParentId: "prior",
			continued: true,
			control: { operation: "session.new" },
		};

		await expect(runner.run(turn)).rejects.toThrow("transcript discovery failed");

		const operation = mappings.operation(turn.chatId, turn.userMessageId);
		expect(acknowledgements).toEqual([{ kind: "create", detail: controlOperationHash(turn) }]);
		expect(operation).toMatchObject({
			kind: "create",
			state: "uncertain",
			detail: controlOperationHash(turn),
			acknowledgedSuccessor: { sessionId: "successor" },
		});
		expect(mappings.get(turn.chatId)?.sessionId).toBe("predecessor");

		await expect(runner.run(turn)).rejects.toThrow("requires reconciliation");
		expect(turnRunner.calls).toBe(1);
	});
	test("keeps source authority when the first destination turn fails", async () => {
		const mappings = new SessionMappingStore();
		const turnRunner = new FakeGjcTurnRunner();
		const projectB = { ...project, id: "project-b", cwd: "/workspace/project-b" };
		mappings.set({
			chatId: "chat-reassign-failure",
			projectId: project.id,
			sessionId: "session-a",
			sessionFile: "/workspace/project/.gjc/sessions/session-a.jsonl",
			operationId: "operation-a",
			rawFrameCursor: 1,
			eventCursor: 1,
		});
		turnRunner.completionError = new Error("destination start failed");
		const runner = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings });

		await expect(
			runner.run({
				project: projectB,
				prompt: "move to B",
				chatId: "chat-reassign-failure",
				messageId: "assistant-b",
				userMessageId: "operation-b",
				userMessageParentId: "operation-a",
				continued: true,
			}),
		).rejects.toThrow("destination start failed");

		expect(mappings.get("chat-reassign-failure")).toMatchObject({
			projectId: project.id,
			sessionId: "session-a",
		});
		expect(mappings.provisionalOperation("chat-reassign-failure", "operation-b")).toMatchObject({
			projectId: projectB.id,
			state: "uncertain",
		});
		expect(turnRunner.starts).toHaveLength(1);
		turnRunner.completionError = undefined;
		await expect(
			runner.run({
				project,
				prompt: "continue in A",
				chatId: "chat-reassign-failure",
				messageId: "assistant-a-2",
				userMessageId: "operation-a-2",
				userMessageParentId: "operation-a",
				continued: true,
			}),
		).resolves.toMatchObject({ content: "continued:continue in A" });
		expect(turnRunner.continues).toHaveLength(1);
		expect(mappings.get("chat-reassign-failure")?.projectId).toBe(project.id);
	});

	test("rejects retired source operations before destination or source runner effects", async () => {
		const mappings = new SessionMappingStore();
		const turnRunner = new FakeGjcTurnRunner();
		const projectB = { ...project, id: "project-b", cwd: "/workspace/project-b" };
		mappings.set({
			chatId: "chat-reassign-stale",
			projectId: project.id,
			sessionId: "session-a",
			sessionFile: "/workspace/project/.gjc/sessions/session-a.jsonl",
			operationId: "operation-a",
			rawFrameCursor: 1,
			eventCursor: 1,
		});
		mappings.beginOperation("chat-reassign-stale", {
			id: "stale-operation-a",
			kind: "prompt",
			detail: "source request",
		});
		mappings.transitionOperation("chat-reassign-stale", "stale-operation-a", "complete", "source request", {
			kind: "turn",
			assistantText: "source result",
			events: [],
			mapping: {
				chatId: "chat-reassign-stale",
				projectId: project.id,
				sessionId: "session-a",
				rawFrameCursor: 1,
				eventCursor: 1,
				operationId: "stale-operation-a",
			},
		});
		const runner = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings });
		await runner.run({
			project: projectB,
			prompt: "move to B",
			chatId: "chat-reassign-stale",
			messageId: "assistant-b",
			userMessageId: "operation-b",
			userMessageParentId: "operation-a",
			continued: true,
		});
		const effectsBeforeRetries = {
			starts: turnRunner.starts.length,
			switches: turnRunner.switches.length,
			continues: turnRunner.continues.length,
			states: turnRunner.states.length,
		};

		for (const retryProject of [projectB, project]) {
			await expect(
				runner.run({
					project: retryProject,
					prompt: "stale source retry",
					chatId: "chat-reassign-stale",
					messageId: `assistant-stale-${retryProject.id}`,
					userMessageId: "stale-operation-a",
					userMessageParentId: null,
					continued: false,
				}),
			).rejects.toThrow("not authorized");
		}
		expect(mappings.get("chat-reassign-stale")?.projectId).toBe(projectB.id);
		expect({
			starts: turnRunner.starts.length,
			switches: turnRunner.switches.length,
			continues: turnRunner.continues.length,
			states: turnRunner.states.length,
		}).toEqual(effectsBeforeRetries);
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
