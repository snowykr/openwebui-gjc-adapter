import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGjcRuntimeLocations } from "../src/configure/runtime-locations";
import { createGjcRpcTurnRunner, createResolvedGjcRpcTurnRunner, GjcRpcRunnerError } from "../src/gjc/rpc-runner";
import { FakeRpcTransport, type RecordedClient, recordFactory } from "./gjc-rpc-runner-fixtures";

describe("createGjcRpcTurnRunner", () => {
	test("required runner seam rejects omitted resolved locations", () => {
		expect(() => Reflect.apply(createResolvedGjcRpcTurnRunner, undefined, [{}])).toThrow(
			new TypeError("resolved runtime locations are required"),
		);
	});

	test("resolves one frozen default runtime location object for every generated client", async () => {
		// Given: hostile ambient runtime locations at the backwards-compatible runner boundary.
		const root = realpathSync(mkdtempSync(join(tmpdir(), "gjc-rpc-default-locations-")));
		const home = join(root, "home");
		const agentDir = join(root, "agent");
		mkdirSync(home);
		mkdirSync(agentDir);
		const keys = [
			"HOME",
			"GJC_CONFIG_DIR",
			"GJC_CODING_AGENT_DIR",
			"GJC_OPENWEBUI_GJC_CONFIG_DIR_NAME",
			"GJC_OPENWEBUI_GJC_CODING_AGENT_DIR",
		] as const;
		const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
		Object.assign(process.env, {
			HOME: home,
			GJC_CONFIG_DIR: "/hostile/child-config",
			GJC_CODING_AGENT_DIR: "/hostile/child-agent",
			GJC_OPENWEBUI_GJC_CONFIG_DIR_NAME: ".selected",
			GJC_OPENWEBUI_GJC_CODING_AGENT_DIR: agentDir,
		});
		const client = new FakeRpcTransport({
			states: [
				{ sessionId: "session-1", rawFrameCursor: 0, eventCursor: 0 },
				{ sessionId: "session-2", rawFrameCursor: 0, eventCursor: 0 },
			],
		});
		const created: RecordedClient[] = [];

		try {
			// When: one runner creates clients for two distinct session keys.
			const runner = createGjcRpcTurnRunner({ clientFactory: recordFactory(created, client) });
			await runner.getState(sessionAddress("project-1", "session-1", root));
			await runner.getState(sessionAddress("project-2", "session-2", root));

			// Then: every client receives the same explicit, frozen resolver-owned object.
			const locations = created[0]?.options.runtimeLocations;
			expect(locations?.home).toBe(home);
			expect(locations?.childEnvironment).toEqual({
				HOME: home,
				GJC_CONFIG_DIR: ".selected",
				GJC_CODING_AGENT_DIR: agentDir,
			});
			expect(Object.isFrozen(locations)).toBe(true);
			expect(created[1]?.options.runtimeLocations).toBe(locations);
			const supplied = resolveGjcRuntimeLocations({ mode: "managed" });
			process.env.HOME = "/missing-hostile-home";
			await createGjcRpcTurnRunner({
				runtimeLocations: supplied,
				clientFactory: recordFactory(created, client),
			}).getState(sessionAddress("supplied", "session", root));
			expect(created[2]?.options.runtimeLocations).toBe(supplied);
		} finally {
			for (const key of keys) {
				const value = previous[key];
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(root, { recursive: true, force: true });
		}
	});
	test("starts a project-bound new session and persists event cursors", async () => {
		const client = new FakeRpcTransport({
			states: [
				{
					sessionId: "session-1",
					sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
					activeLeaf: "leaf-1",
					rawFrameCursor: 11,
					eventCursor: 5,
				},
			],
			promptEvents: [
				[
					{ type: "message_update", message: { content: [{ type: "text", text: "partial" }] } },
					{ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash" },
				],
			],
			assistantTexts: ["assistant final"],
		});
		const created: RecordedClient[] = [];
		const runner = createGjcRpcTurnRunner({ clientFactory: recordFactory(created, client) });

		const result = await runner.startNewSession({
			cwd: "/workspace/project",
			sessionRoot: "/workspace/project/.gjc/sessions",
			projectId: "project",
			chatId: "chat-1",
			userMessageId: "message-1",
			text: "hello",
		});

		expect(created).toHaveLength(1);
		expect(created[0]?.options.cwd).toBe("/workspace/project");
		expect(created[0]?.options.sessionRoot).toBe("/workspace/project/.gjc/sessions");
		expect(created[0]?.client).toBe(client);
		expect(created[0]?.options.runtimeLocations).toBeDefined();
		expect(client.calls).toEqual([
			{ type: "start" },
			{ type: "new_session" },
			{ type: "on_workflow_gate" },
			{ type: "prompt", message: "hello" },
			{ type: "get_state" },
			{ type: "get_last_assistant_text" },
		]);
		expect(result).toMatchObject({
			cwd: "/workspace/project",
			sessionRoot: "/workspace/project/.gjc/sessions",
			projectId: "project",
			chatId: "chat-1",
			sessionId: "session-1",
			text: "assistant final",
			sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
			activeLeaf: "leaf-1",
			rawFrameCursor: 11,
			eventCursor: 5,
		});
		expect(result.events).toEqual([
			{ type: "message_update", text: "partial" },
			{ type: "tool_execution_start", id: "tool-1", text: "bash" },
		]);
	});

	test("passes configured CLI path to the RPC transport", async () => {
		const runtimeLocations = resolveGjcRuntimeLocations({ mode: "managed" });
		const client = new FakeRpcTransport({
			states: [{ sessionId: "session-1", rawFrameCursor: 0, eventCursor: 0 }],
			assistantTexts: ["assistant final"],
		});
		const created: RecordedClient[] = [];
		const runner = createGjcRpcTurnRunner({
			cliPath: "/opt/gjc/src/cli.ts",
			runtimeLocations,
			clientFactory: recordFactory(created, client),
		});

		await runner.startNewSession({
			cwd: "/workspace/project",
			sessionRoot: "/workspace/project/.gjc/sessions",
			projectId: "project",
			chatId: "chat-1",
			userMessageId: "message-1",
			text: "hello",
		});

		expect(created).toMatchObject([
			{
				options: {
					cwd: "/workspace/project",
					sessionRoot: "/workspace/project/.gjc/sessions",
					cliPath: "/opt/gjc/src/cli.ts",
				},
				client,
			},
		]);
		expect(created[0]?.options.runtimeLocations).toBe(runtimeLocations);
	});

	test("continues with switch_session then refreshed get_state before prompting", async () => {
		const client = new FakeRpcTransport({
			states: [
				{
					sessionId: "session-1",
					sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
					activeLeaf: "leaf-fresh",
					rawFrameCursor: 20,
					eventCursor: 9,
				},
				{
					sessionId: "session-1",
					sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
					activeLeaf: "leaf-after",
					rawFrameCursor: 23,
					eventCursor: 11,
				},
			],
			promptEvents: [
				[
					{ type: "message_update", message: { content: [{ type: "text", text: "continued partial" }] } },
					{ type: "tool_execution_start", toolCallId: "tool-2", toolName: "read" },
				],
			],
			assistantTexts: ["continued final"],
		});
		const runner = createGjcRpcTurnRunner({ clientFactory: recordFactory([], client) });
		const address = {
			cwd: "/workspace/project",
			sessionRoot: "/workspace/project/.gjc/sessions",
			projectId: "project",
			sessionId: "session-1",
			chatId: "chat-1",
			sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
		};

		await runner.switchSession(address);
		const state = await runner.getState(address);
		const result = await runner.continueSession({
			...address,
			userMessageId: "message-2",
			parentId: "message-1",
			text: "again",
			activeLeaf: state.activeLeaf,
			rawFrameCursor: state.rawFrameCursor,
			eventCursor: state.eventCursor,
			operationId: "message-2",
		});

		expect(client.calls).toEqual([
			{ type: "start" },
			{ type: "switch_session", sessionPath: "/workspace/project/.gjc/sessions/session-1.jsonl" },
			{ type: "get_state" },
			{ type: "on_workflow_gate" },
			{ type: "prompt", message: "again" },
			{ type: "get_state" },
			{ type: "get_last_assistant_text" },
		]);
		expect(result).toEqual({
			text: "continued final",
			events: [
				{ type: "message_update", text: "continued partial" },
				{ type: "tool_execution_start", id: "tool-2", text: "read" },
			],
			sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
			activeLeaf: "leaf-after",
			rawFrameCursor: 23,
			eventCursor: 11,
		});
	});

	test("surfaces RPC command failures with command context", async () => {
		const client = new FakeRpcTransport({
			states: [{ sessionId: "session-1", rawFrameCursor: 0, eventCursor: 0 }],
		});
		client.failCommand = "prompt";
		const runner = createGjcRpcTurnRunner({ clientFactory: recordFactory([], client) });

		const promise = runner.startNewSession({
			cwd: "/workspace/project",
			sessionRoot: "/workspace/project/.gjc/sessions",
			projectId: "project",
			chatId: "chat-1",
			userMessageId: "message-1",
			text: "hello",
		});

		await expect(promise).rejects.toThrow(GjcRpcRunnerError);
		await expect(promise).rejects.toThrow("GJC RPC prompt failed: fake prompt failure");
	});
});

function sessionAddress(projectId: string, sessionId: string, cwd: string) {
	return { cwd, sessionRoot: join(cwd, "sessions"), projectId, sessionId, chatId: "chat" };
}
