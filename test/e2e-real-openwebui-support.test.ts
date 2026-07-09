import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { E2EContext, sanitizeArtifactName } from "../scripts/e2e-real-openwebui-support";

const originalEnv = { ...process.env };
const tempRoots: string[] = [];

afterEach(async () => {
	process.env = { ...originalEnv };
	await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("real OpenWebUI E2E support safety", () => {
	test("sanitizes run ids before using them in generated paths and ids", async () => {
		const artifactRoot = await temporaryDirectory();
		setRequiredEnv({
			E2E_RUN_ID: "../unsafe run/id",
			E2E_ARTIFACT_DIR: artifactRoot,
		});

		const context = await E2EContext.create();

		expect(context.config.runId).toBe("unsafe-run-id");
		expect(context.openWebUIForwardHeaders()["x-openwebui-chat-id"]).toBe("e2e-unsafe-run-id");
	});

	test("keeps artifact filenames under the configured artifact directory", async () => {
		const artifactRoot = await temporaryDirectory();
		setRequiredEnv({
			E2E_RUN_ID: "safe",
			E2E_ARTIFACT_DIR: artifactRoot,
		});

		const context = await E2EContext.create();
		await context.writeJson("../escape/token.json", { ok: true });

		const expected = path.join(artifactRoot, "escape-token.json");
		await expect(readFile(expected, "utf8")).resolves.toContain('"ok": true');
		await expect(readFile(path.join(artifactRoot, "..", "escape", "token.json"), "utf8")).rejects.toThrow();
	});

	test("normalizes empty artifact filename fragments", () => {
		expect(sanitizeArtifactName("../../")).toBe("artifact");
	});
});

async function temporaryDirectory(): Promise<string> {
	const root = await mkdtemp(path.join(os.tmpdir(), "gjc-openwebui-e2e-"));
	tempRoots.push(root);
	await mkdir(root, { recursive: true });
	return root;
}

function setRequiredEnv(overrides: Record<string, string>): void {
	process.env = {
		...originalEnv,
		E2E_ADAPTER_API_TOKEN: "adapter-token",
		E2E_OPENWEBUI_API_TOKEN: "openwebui-token",
		E2E_OPENWEBUI_OWNER_USER_ID: "owner-id",
		...overrides,
	};
}
