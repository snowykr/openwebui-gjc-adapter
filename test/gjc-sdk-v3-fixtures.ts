import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GjcRuntimeLocations } from "../src/contracts";
import { createDefaultRpcTransport } from "../src/gjc/rpc-client-transport";
import { resolveGjcSdkSessionRoot } from "../src/gjc/session-root";
import type { SdkFixtureScenario } from "./gjc-sdk-v3-fixture-types";
import { startSdkFixtureServer } from "./gjc-sdk-v3-server-fixture";

export type { SdkFixtureScenario, SdkFixtureServer, SdkFrame } from "./gjc-sdk-v3-fixture-types";
export { expectSdkRequest, startSdkFixtureServer } from "./gjc-sdk-v3-server-fixture";

export function createSdkTransportFixture(
	scenario: SdkFixtureScenario,
	options: { readonly closeFailure?: boolean } = {},
) {
	const root = mkdtempSync(join(tmpdir(), "gjc-sdk-v3-contract-"));
	const home = join(root, "home");
	const agentDir = join(home, ".gjc", "agent");
	const cwd = join(root, "workspace");
	const sessionRoot = join(cwd, ".gjc", "sessions");
	for (const path of [home, agentDir, cwd, sessionRoot]) mkdirSync(path, { recursive: true });
	const cliTranscript = join(root, "cli.jsonl");
	appendFileSync(cliTranscript, "");
	const server = startSdkFixtureServer(scenario);
	const runtimeLocations: GjcRuntimeLocations = {
		home,
		configDomain: join(home, ".gjc"),
		agentDir,
		readerWorkspace: cwd,
		readerSessionRoot: sessionRoot,
		protectedProjectPaths: [join(home, ".gjc"), agentDir, cwd, sessionRoot],
		childEnvironment: { HOME: home, GJC_CONFIG_DIR: ".gjc", GJC_CODING_AGENT_DIR: agentDir },
	};
	const savedSessionPath = join(resolveGjcSdkSessionRoot(cwd, runtimeLocations), "sdk-session-resumed.jsonl");
	const fixtureEnvironment = {
		GJC_SDK_FIXTURE_CLI_TRANSCRIPT: cliTranscript,
		GJC_SDK_FIXTURE_ENDPOINT_URL: server.url,
		GJC_SDK_FIXTURE_ENDPOINT_TOKEN: server.token,
		GJC_SDK_FIXTURE_EXPECTED_CWD: cwd,
		GJC_SDK_FIXTURE_SAVED_PATH: savedSessionPath,
		GJC_SDK_FIXTURE_CLOSE_FAILURE: options.closeFailure ? "1" : undefined,
		PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
	};
	const previousFixtureEnvironment = Object.fromEntries(
		Object.keys(fixtureEnvironment).map(name => [name, process.env[name]]),
	);
	Object.assign(process.env, fixtureEnvironment);
	const transport = createDefaultRpcTransport({
		cwd,
		sessionRoot,
		cliPath: fileURLToPath(new URL("fixtures/gjc-sdk-daemon-fixture.ts", import.meta.url)),
		runtimeLocations,
	});
	return {
		transport,
		server,
		cliTranscript,
		savedSessionPath,
		runtimeLocations,
		dispose() {
			transport.stop();
			server.stop();
			for (const name of Object.keys(fixtureEnvironment)) {
				const previous = previousFixtureEnvironment[name];
				if (previous === undefined) delete process.env[name];
				else process.env[name] = previous;
			}
			rmSync(root, { recursive: true, force: true });
		},
	};
}

export function readCliOperations(path: string): readonly string[] {
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line))
		.map(value => Reflect.get(value, "operation"))
		.filter((value): value is string => typeof value === "string");
}
