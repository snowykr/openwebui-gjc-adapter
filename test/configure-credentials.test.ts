import { describe, expect, test } from "bun:test";
import { mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli";
import {
	CredentialError,
	canDisplaySecret,
	displayAdapterToken,
	openSecretFile,
	readSecretFromFd,
	readSecretRecordFromFd,
} from "../src/configure/credentials";
import { writeInstalledConfig } from "../src/configure/private-config";

function file(value: string): { directory: string; fd: number; cleanup: () => void } {
	const directory = mkdtempSync(join(tmpdir(), "gjc-credentials-"));
	const path = join(directory, "secret");
	writeFileSync(path, value);
	return { directory, fd: openSecretFile(path), cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

function stream(isTTY: boolean, values: string[] = []): NodeJS.ReadStream & NodeJS.WriteStream & { fd: 0 } {
	return {
		isTTY,
		fd: 0,
		write(value: string) {
			values.push(value);
			return true;
		},
	} as unknown as NodeJS.ReadStream & NodeJS.WriteStream & { fd: 0 };
}

describe("configure credential boundaries", () => {
	test("reads exactly one bounded secret from an injected FD", () => {
		const input = file("token-value\n");
		try {
			expect(readSecretFromFd(input.fd)).toBe("token-value");
		} finally {
			input.cleanup();
		}
		const invalid = file("token\nsecond\n");
		try {
			expect(() => readSecretRecordFromFd(invalid.fd)).toThrow("secret contains forbidden control characters");
		} finally {
			invalid.cleanup();
		}
	});

	test("rejects invalid, empty, and oversized descriptors without exposing content", () => {
		expect(() => readSecretFromFd(-1)).toThrow("secret FD must be a non-negative decimal integer");
		const empty = file("\n");
		try {
			expect(() => readSecretFromFd(empty.fd)).toThrow("must not be empty");
		} finally {
			empty.cleanup();
		}
		const oversized = file("x".repeat(16_385));
		try {
			expect(() => readSecretFromFd(oversized.fd)).toThrow(CredentialError);
		} finally {
			oversized.cleanup();
		}
	});

	test("refuses token display without same TTY and writes only with same TTY", () => {
		const values: string[] = [];
		const input = stream(true);
		const output = stream(false, values);
		expect(canDisplaySecret(input, output)).toBe(false);
		expect(() => displayAdapterToken("secret-token", input, output)).toThrow("controlling TTY");
		const ttyOutput = stream(true, values);
		expect(canDisplaySecret(input, ttyOutput)).toBe(true);
		displayAdapterToken("secret-token", input, ttyOutput);
		expect(values).toEqual(["secret-token\n"]);
	});
	test("runCli only reveals a token through the explicitly shared controlling terminal", async () => {
		const directory = mkdtempSync(join(tmpdir(), "gjc-terminal-"));
		const configPath = join(directory, "config.json");
		const samePath = join(directory, "same-terminal");
		const otherPath = join(directory, "other-terminal");
		writeFileSync(samePath, "");
		writeFileSync(otherPath, "");
		const sameFd = openSync(samePath, "r+");
		const otherFd = openSync(otherPath, "r+");
		writeInstalledConfig(
			{
				version: 1,
				mode: "managed",
				installationId: "install",
				adapterToken: "secret-token",
				readinessToken: "ready",
				openWebUIApiUrl: "http://localhost:8080",
				adapterProviderUrl: "http://adapter:8765/v1",
				bindHost: "0.0.0.0",
				bindPort: 8765,
			},
			configPath,
		);
		try {
			const sameOutput: string[] = [];
			const sameTerminal = {
				input: { isTTY: true, fd: sameFd } as unknown as NodeJS.ReadStream,
				output: {
					isTTY: true,
					fd: sameFd,
					write(value: string) {
						sameOutput.push(value);
						return true;
					},
				} as unknown as NodeJS.WriteStream,
			};
			expect(
				await runCli(["credentials", "show", "adapter-token", "--config", configPath], {
					terminal: sameTerminal,
					confirmAdapterToken: () => true,
				}),
			).toBe(0);
			expect(sameOutput).toEqual(["secret-token\n"]);

			const alternateOutput: string[] = [];
			const distinctTerminal = {
				input: { isTTY: true, fd: sameFd } as unknown as NodeJS.ReadStream,
				output: {
					isTTY: true,
					fd: otherFd,
					write(value: string) {
						alternateOutput.push(value);
						return true;
					},
				} as unknown as NodeJS.WriteStream,
			};
			expect(
				await runCli(["credentials", "show", "adapter-token", "--config", configPath], {
					terminal: distinctTerminal,
					confirmAdapterToken: () => true,
				}),
			).toBe(1);
			expect(alternateOutput).toEqual([]);
			expect(sameOutput).toEqual(["secret-token\n"]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
