import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
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
			await fixture.dispose();
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
			await fixture.dispose();
		}
	});

	for (const [cliKind, useWrapper] of [
		["source CLI", false],
		["extensionless wrapper", true],
	] as const) {
		test(`Given hostile bunfig and dotenv with ${cliKind} When creating a session Then trusted isolation wins`, async () => {
			const fixture = createCliFixture({}, 1_000, useWrapper);
			try {
				const preloadMarker = join(fixture.root, "preload-ran");
				const agentPreloadMarker = join(fixture.root, "agent-preload-ran");
				writeFileSync(
					join(fixture.cwd, "preload.ts"),
					`await Bun.write(${JSON.stringify(preloadMarker)}, "ran");\n`,
				);
				writeFileSync(join(fixture.cwd, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
				writeFileSync(join(fixture.cwd, ".env"), "GJC_SDK_HOSTILE_DOTENV=loaded\n");
				writeFileSync(
					join(fixture.agentDir, "preload.ts"),
					`await Bun.write(${JSON.stringify(agentPreloadMarker)}, "ran");\n`,
				);
				writeFileSync(join(fixture.agentDir, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
				writeFileSync(join(fixture.agentDir, ".env"), "GJC_SDK_AGENT_DOTENV=loaded\n");

				const authority = await fixture.cli.createSession("create-key");
				const invocation = firstTranscriptRecord(fixture.transcript);

				expect(authority.cwd).toBe(fixture.cwd);
				expect(invocation.cwd).toBe(fixture.agentDir);
				expect(invocation.hostileDotenv).toBeUndefined();
				expect(invocation.agentDotenv).toBeUndefined();
				const expectedSessionCommand = useWrapper
					? `${fixture.cliPath} sdk session-host-internal`
					: join(fixture.launcherDir, "sdk-session-host");
				expect(invocation.sessionCommand).toBe(expectedSessionCommand);
				expect(await Bun.file(preloadMarker).exists()).toBe(false);
				expect(await Bun.file(agentPreloadMarker).exists()).toBe(false);
				const launcher = readFileSync(useWrapper ? fixture.cliPath : expectedSessionCommand, "utf8");
				expect(launcher).toContain("--no-env-file --config=/dev/null");
			} finally {
				await fixture.dispose();
			}
		});
	}

	test("Given a lifecycle subprocess exceeds its deadline When creating Then it is killed with a typed timeout", async () => {
		const fixture = createCliFixture({ GJC_SDK_FIXTURE_DELAY_MS: "500" }, 30);
		try {
			await expect(fixture.cli.createSession("create-key")).rejects.toMatchObject({
				name: "SdkV3OperationError",
				code: "cli_timeout",
			});
		} finally {
			await fixture.dispose();
		}
	});

	test("Given a symlink at the source launcher path When creating Then it is atomically replaced without touching the target", async () => {
		const fixture = createCliFixture();
		try {
			const victim = join(fixture.root, "launcher-victim");
			writeFileSync(victim, "preserve-victim-bytes");
			const launcher = join(fixture.launcherDir, "sdk-session-host");
			symlinkSync(victim, launcher);

			await fixture.cli.createSession("create-key");

			expect(readFileSync(victim, "utf8")).toBe("preserve-victim-bytes");
			expect(readFileSync(launcher, "utf8")).toContain("--no-env-file --config=/dev/null");
		} finally {
			await fixture.dispose();
		}
	});

	test("Given a hard link at the source launcher path When creating Then the linked file is not modified", async () => {
		const fixture = createCliFixture();
		try {
			const victim = join(fixture.root, "hardlink-victim");
			const launcher = join(fixture.launcherDir, "sdk-session-host");
			writeFileSync(victim, "preserve-hardlink-bytes");
			linkSync(victim, launcher);

			await fixture.cli.createSession("create-key");

			expect(readFileSync(victim, "utf8")).toBe("preserve-hardlink-bytes");
			expect(readFileSync(launcher, "utf8")).toContain("--no-env-file --config=/dev/null");
		} finally {
			await fixture.dispose();
		}
	});

	test("Given a FIFO at the source launcher path When creating Then publication does not block on the FIFO", async () => {
		const fixture = createCliFixture();
		try {
			const launcher = join(fixture.launcherDir, "sdk-session-host");
			expect(Bun.spawnSync(["mkfifo", launcher]).exitCode).toBe(0);

			await fixture.cli.createSession("create-key");

			expect(statSync(launcher).isFile()).toBe(true);
			expect(readFileSync(launcher, "utf8")).toContain("--no-env-file --config=/dev/null");
		} finally {
			await fixture.dispose();
		}
	});

	test("Given concurrent source lifecycle calls When creating sessions Then every caller observes a complete launcher", async () => {
		const fixture = createCliFixture();
		try {
			const calls = Array.from({ length: 16 }, (_, index) =>
				fixture.cli.createSession(`concurrent-create-${index}`),
			);

			await Promise.all(calls);

			expect(
				transcriptRecords(fixture.transcript).filter(record => record.operation === "session.create"),
			).toHaveLength(16);
			const launcher = join(fixture.launcherDir, "sdk-session-host");
			expect(readFileSync(launcher, "utf8")).toContain("--no-env-file --config=/dev/null");
			expect(statSync(launcher).mode & 0o777).toBe(0o700);
		} finally {
			await fixture.dispose();
		}
	});

	test("Given an existing source launcher When creating Then it is safely replaced with private executable bytes", async () => {
		const fixture = createCliFixture();
		try {
			const launcher = join(fixture.launcherDir, "sdk-session-host");
			writeFileSync(launcher, "stale-launcher", { mode: 0o644 });
			const staleInode = statSync(launcher).ino;

			await fixture.cli.createSession("create-key");

			expect(readFileSync(launcher, "utf8")).toContain("--no-env-file --config=/dev/null");
			expect(statSync(launcher).mode & 0o777).toBe(0o700);
			expect(statSync(launcher).ino).not.toBe(staleInode);
		} finally {
			await fixture.dispose();
		}
	});

	test("Given an ephemeral session When closing Then close is bounded and awaitable", async () => {
		const fixture = createCliFixture();
		try {
			await fixture.cli.closeSession("ephemeral-session", "close-key");

			const records = transcriptRecords(fixture.transcript);
			expect(records.at(-1)?.operation).toBe("session.close");
		} finally {
			await fixture.dispose();
		}
	});
});

function createCliFixture(
	extraEnvironment: Readonly<Record<string, string>> = {},
	timeoutMs = 1_000,
	useWrapper = false,
): {
	readonly root: string;
	readonly cwd: string;
	readonly agentDir: string;
	readonly launcherDir: string;
	readonly sessionRoot: string;
	readonly transcript: string;
	readonly cliPath: string;
	readonly environment: Record<string, string | undefined>;
	readonly cli: SdkV3Cli;
	dispose(): void;
} {
	const root = mkdtempSync(join(tmpdir(), "gjc-sdk-cli-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "trusted-agent");
	const launcherDir = join(root, "service-private-runtime");
	const sessionRoot = join(agentDir, "sessions", "project");
	const transcript = join(root, "cli.jsonl");
	for (const path of [cwd, agentDir, launcherDir, sessionRoot]) mkdirSync(path, { recursive: true, mode: 0o700 });
	const cliPath = useWrapper ? join(root, "gjc") : fixtureCli;
	if (useWrapper) {
		writeFileSync(
			cliPath,
			`#!/bin/sh\nexec ${JSON.stringify(process.execPath)} --no-env-file --config=/dev/null ${JSON.stringify(fixtureCli)} "$@"\n`,
		);
		chmodSync(cliPath, 0o700);
	}
	writeFileSync(transcript, "");
	const environment: Record<string, string | undefined> = {
		...process.env,
		GJC_SDK_FIXTURE_CLI_TRANSCRIPT: transcript,
		GJC_SDK_FIXTURE_ENDPOINT_URL: "ws://127.0.0.1:31000",
		GJC_SDK_FIXTURE_ENDPOINT_TOKEN: "fixture-token",
		GJC_SDK_FIXTURE_SAVED_PATH: join(sessionRoot, "expected-session.jsonl"),
		...extraEnvironment,
	};
	const cli = new SdkV3Cli({ cliPath, cwd, agentDir, launcherDir, sessionRoot, environment, timeoutMs });
	return {
		root,
		cwd,
		agentDir,
		launcherDir,
		sessionRoot,
		transcript,
		cliPath,
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
