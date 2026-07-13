import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionMappingStore } from "../src/gjc/session-router";
import { InMemoryOpenWebUIProjectionRepository } from "../src/openwebui/client";
import { syncProjectSessionsToOpenWebUI } from "../src/projection/session-sync";
import { registerProjectDirectory } from "../src/projects/registry";
import { resolveAllowedRoots } from "../src/security/paths";
import { messageEntry, writeSessionFile } from "./session-sync-fixtures";

test("SDK session sync preserves an existing live mapping", async () => {
	const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-sync-live-"));
	try {
		const home = path.join(workspace, "home");
		const agentDir = path.join(home, ".gjc", "agent");
		const projectDirectory = path.join(workspace, "Project Live");
		const sdkSessionRoot = path.join(agentDir, "sessions", `-tmp-${path.basename(workspace)}-Project Live`);
		const sessionFile = path.join(sdkSessionRoot, "live-session.jsonl");
		await fs.mkdir(sdkSessionRoot, { recursive: true });
		await fs.mkdir(projectDirectory, { recursive: true });
		await writeSessionFile(sessionFile, {
			header: { id: "live-session", title: "Live Session", cwd: projectDirectory },
			entries: [messageEntry("live-user", null, "user", "live transcript")],
		});
		const project = await registerProjectDirectory(
			{ cwd: projectDirectory, name: "Project Live", sessionRoot: path.join(workspace, "mapping-root") },
			await resolveAllowedRoots([workspace]),
		);
		const mappings = new SessionMappingStore();
		const liveMapping = mappings.upsert({
			chatId: "live-chat",
			projectId: project.id,
			sessionId: "live-session",
			sessionFile,
			activeLeaf: "leaf-current",
			rawFrameCursor: 41,
			eventCursor: 17,
			operationId: "live-user-message",
			assistantText: "live answer",
			modelSelection: { provider: "future", modelId: "capable", thinkingLevel: "high" },
		});

		const result = await syncProjectSessionsToOpenWebUI({
			repository: new InMemoryOpenWebUIProjectionRepository(),
			ownerUserId: "owner-1",
			projects: [project],
			mappings,
			runtimeLocations: { home, agentDir },
		});

		expect(result.imported).toMatchObject([{ chatId: "live-chat", sessionId: "live-session" }]);
		expect(mappings.get("live-chat")).toEqual(liveMapping);
	} finally {
		await fs.rm(workspace, { recursive: true, force: true });
	}
});
