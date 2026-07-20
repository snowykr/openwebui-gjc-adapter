import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PublicSdkSessionClient } from "../src/gjc/public-sdk-session-port";
import type { PublicSdkSessionAttachment } from "../src/gjc/public-sdk-contract";
import type { SdkFixtureScenario } from "./gjc-sdk-v3-fixture-types";
import { startSdkFixtureServer } from "./gjc-sdk-v3-server-fixture";

export type { SdkFixtureScenario, SdkFixtureServer, SdkFrame } from "./gjc-sdk-v3-fixture-types";
export { expectSdkRequest, startSdkFixtureServer } from "./gjc-sdk-v3-server-fixture";

export function createSdkTransportFixture(scenario: SdkFixtureScenario) {
	const root = mkdtempSync(join(tmpdir(), "gjc-sdk-v3-contract-"));
	const cwd = join(root, "workspace");
	mkdirSync(cwd, { recursive: true });
	const descriptorPath = join(cwd, ".gjc", "state", "sdk", "sdk-session-created.json");
	mkdirSync(join(cwd, ".gjc", "state", "sdk"), { recursive: true });
	writeFileSync(descriptorPath, "{}");
	const descriptorStat = statSync(descriptorPath);
	const previousExpectedCwd = process.env.GJC_SDK_FIXTURE_EXPECTED_CWD;
	process.env.GJC_SDK_FIXTURE_EXPECTED_CWD = cwd;
	const server = startSdkFixtureServer(scenario);
	const attachment: PublicSdkSessionAttachment = {
		sessionId: "sdk-session-created",
		cwd,
		endpoint: { url: server.url, token: server.token },
		authority: {
			descriptorPath,
			descriptorStat: {
				dev: descriptorStat.dev,
				ino: descriptorStat.ino,
				size: descriptorStat.size,
				mtimeMs: descriptorStat.mtimeMs,
			},
			payloadDigest: digest("{}"),
			generation: descriptorStat.mtimeMs,
			expectedSessionId: "sdk-session-created",
			expectedCwd: cwd,
		},
	};
	const port = new PublicSdkSessionClient();
	return {
		port,
		attachment,
		server,
		async attach() {
			await port.attach(attachment);
		},
		async dispose() {
			port.detach();
			server.stop();
			rmSync(root, { recursive: true, force: true });
			if (previousExpectedCwd === undefined) delete process.env.GJC_SDK_FIXTURE_EXPECTED_CWD;
			else process.env.GJC_SDK_FIXTURE_EXPECTED_CWD = previousExpectedCwd;
		},
	};
}
function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
