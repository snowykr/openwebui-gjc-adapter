import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGjcRuntimeLocations } from "../src/configure/runtime-locations";
import { createGjcRpcTurnRunner, createResolvedGjcRpcTurnRunner } from "../src/gjc/rpc-runner";
import { FakeRpcTransport, type RecordedClient, recordFactory } from "./gjc-rpc-runner-fixtures";

describe("createGjcRpcTurnRunner runtime locations", () => {
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
});

function sessionAddress(projectId: string, sessionId: string, cwd: string) {
	return { cwd, sessionRoot: join(cwd, "sessions"), projectId, sessionId, chatId: "chat" };
}
