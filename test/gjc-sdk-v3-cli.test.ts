import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SdkV3Cli } from "../src/gjc/sdk-v3-cli";

const fixtureCli = fileURLToPath(new URL("fixtures/gjc-sdk-daemon-fixture.ts", import.meta.url));

describe("SDK v3 lifecycle CLI boundary", () => {
	test("Given session.list returns another id When resolving Then the result is rejected", async () => {
		const fixture = createCliFixture({ GJC_SDK_FIXTURE_SAVED_ID: "another-session" });
		try {
			await expect(fixture.cli.resolveSession("expected-session")).rejects.toThrow(
				"session id does not match the requested session",
			);
		} finally {
			fixture.dispose();
		}
	});

	test("Given session.list escapes through a symlink When resolving Then the path is rejected", async () => {
		const fixture = createCliFixture();
		try {
			const outside = join(fixture.root, "outside");
			mkdirSync(outside);
			writeFileSync(join(outside, "escaped.jsonl"), "");
			symlinkSync(outside, join(fixture.sessionRoot, "linked"));
			fixture.environment.GJC_SDK_FIXTURE_SAVED_PATH = join(fixture.sessionRoot, "linked", "escaped.jsonl");

			await expect(fixture.cli.resolveSession("expected-session")).rejects.toThrow(
				"saved session path is outside the SDK session root",
			);
		} finally {
			fixture.dispose();
		}
	});

	test("Given a hostile project bunfig and dotenv When creating a session Then trusted CLI isolation wins", async () => {
		const fixture = createCliFixture();
		try {
			const preloadMarker = join(fixture.root, "preload-ran");
			const agentPreloadMarker = join(fixture.root, "agent-preload-ran");
			writeFileSync(join(fixture.cwd, "preload.ts"), `await Bun.write(${JSON.stringify(preloadMarker)}, "ran");\n`);
			writeFileSync(join(fixture.cwd, "bunfig.toml"), '[run]\npreload = ["./preload.ts"]\n');
			writeFileSync(join(fixture.cwd, ".env"), "GJC_SDK_HOSTILE_DOTENV=loaded\n");
			writeFileSync(
				join(fixture.agentDir, "preload.ts"),
				`await Bun.write(${JSON.stringify(agentPreloadMarker)}, "ran");\n`,
			);
			writeFileSync(join(fixture.agentDir, "bunfig.toml"), '[run]\npreload = ["./preload.ts"]\n');
			writeFileSync(join(fixture.agentDir, ".env"), "GJC_SDK_AGENT_DOTENV=loaded\n");

			const authority = await fixture.cli.createSession("create-key");
			const invocation = firstTranscriptRecord(fixture.transcript);

			expect(authority.cwd).toBe(fixture.cwd);
			expect(invocation.cwd).toBe(fixture.agentDir);
			expect(invocation.hostileDotenv).toBeUndefined();
			expect(invocation.agentDotenv).toBeUndefined();
			expect(invocation.sessionCommand).toBe(join(fixture.agentDir, "sdk-session-host"));
			const launcher = readFileSync(String(invocation.sessionCommand), "utf8");
			expect(launcher).toContain("--no-env-file --config=/dev/null");
			expect(launcher).toContain("sdk session-host-internal");
			expect(await Bun.file(preloadMarker).exists()).toBe(false);
			expect(await Bun.file(agentPreloadMarker).exists()).toBe(false);
		} finally {
			fixture.dispose();
		}
	});

	test("Given a lifecycle subprocess exceeds its deadline When creating Then it is killed with a typed timeout", async () => {
		const fixture = createCliFixture({ GJC_SDK_FIXTURE_DELAY_MS: "500" }, 30);
		try {
			await expect(fixture.cli.createSession("create-key")).rejects.toMatchObject({
				name: "SdkV3OperationError",
				code: "cli_timeout",
			});
		} finally {
			fixture.dispose();
		}
	});

	test("Given an ephemeral session When closing Then close is bounded and awaitable", async () => {
		const fixture = createCliFixture();
		try {
			await fixture.cli.closeSession("ephemeral-session", "close-key");

			const records = transcriptRecords(fixture.transcript);
			expect(records.at(-1)?.operation).toBe("session.close");
		} finally {
			fixture.dispose();
		}
	});
});

function createCliFixture(
	extraEnvironment: Readonly<Record<string, string>> = {},
	timeoutMs = 1_000,
): {
	readonly root: string;
	readonly cwd: string;
	readonly agentDir: string;
	readonly sessionRoot: string;
	readonly transcript: string;
	readonly environment: Record<string, string | undefined>;
	readonly cli: SdkV3Cli;
	dispose(): void;
} {
	const root = mkdtempSync(join(tmpdir(), "gjc-sdk-cli-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "trusted-agent");
	const sessionRoot = join(agentDir, "sessions", "project");
	const transcript = join(root, "cli.jsonl");
	for (const path of [cwd, agentDir, sessionRoot]) mkdirSync(path, { recursive: true });
	writeFileSync(transcript, "");
	const environment: Record<string, string | undefined> = {
		...process.env,
		GJC_SDK_FIXTURE_CLI_TRANSCRIPT: transcript,
		GJC_SDK_FIXTURE_ENDPOINT_URL: "ws://127.0.0.1:31000",
		GJC_SDK_FIXTURE_ENDPOINT_TOKEN: "fixture-token",
		GJC_SDK_FIXTURE_SAVED_PATH: join(sessionRoot, "expected-session.jsonl"),
		...extraEnvironment,
	};
	const cli = new SdkV3Cli({ cliPath: fixtureCli, cwd, agentDir, sessionRoot, environment, timeoutMs });
	return {
		root,
		cwd,
		agentDir,
		sessionRoot,
		transcript,
		environment,
		cli,
		dispose: () => rmSync(root, { recursive: true }),
	};
}

function firstTranscriptRecord(path: string): Readonly<Record<string, unknown>> {
	const record = transcriptRecords(path)[0];
	if (record === undefined) throw new TypeError("CLI transcript is empty");
	return record;
}

function transcriptRecords(path: string): readonly Readonly<Record<string, unknown>>[] {
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line));
}
