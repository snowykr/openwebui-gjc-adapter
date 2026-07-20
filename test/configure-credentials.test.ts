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
import { parseCliArguments } from "../src/configure/grammar";
import { validateInstalledConfig, writeInstalledConfig } from "../src/configure/private-config";

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
	test("accepts strict direct installed fields and rejects them in managed records", () => {
		// Given: a complete installed record with the approved optional fields.
		const base = {
			version: 1,
			installationId: "install",
			adapterToken: "adapter",
			readinessToken: "ready",
			openWebUIApiUrl: "http://localhost:8080",
			adapterProviderUrl: "http://localhost:8765/v1",
			bindPort: 8765,
		} as const;
		// When/Then: existing mode accepts them, while managed mode rejects either field exactly.
		expect(
			validateInstalledConfig({
				...base,
				mode: "existing",
				bindHost: "127.0.0.1",
				gjcConfigDirName: ".gjc-direct",
				gjcCodingAgentDir: "/opt/gjc-agent",
			}),
		).toMatchObject({ gjcConfigDirName: ".gjc-direct", gjcCodingAgentDir: "/opt/gjc-agent" });
		for (const runtimeField of [{ gjcConfigDirName: ".gjc" }, { gjcCodingAgentDir: "/opt/gjc-agent" }]) {
			expect(() =>
				validateInstalledConfig({
					...base,
					mode: "managed",
					bindHost: "0.0.0.0",
					...runtimeField,
				}),
			).toThrow("managed configuration must not include GJC runtime location fields");
		}
		expect(() =>
			validateInstalledConfig({
				...base,
				mode: "existing",
				bindHost: "127.0.0.1",
				gjcConfigDirName: ".gjc",
				unknownRuntimeField: true,
			}),
		).toThrow("installed config contains unknown fields");
	});

	test("parses direct GJC location flags and rejects them together in managed mode", () => {
		// Given: the two approved direct runtime-location flags.
		const directArguments = [
			"configure",
			"existing",
			"--gjc-config-dir-name",
			".gjc-direct",
			"--gjc-coding-agent-dir=/opt/gjc-agent",
		];
		// When/Then: existing mode preserves both values at the grammar boundary.
		expect(parseCliArguments(directArguments)).toEqual({
			kind: "configure",
			mode: "existing",
			options: { "gjc-config-dir-name": ".gjc-direct", "gjc-coding-agent-dir": "/opt/gjc-agent" },
		});
		// When/Then: managed mode rejects the same boundary before any credential or deployment work.
		expect(() => parseCliArguments(["configure", "managed", "--gjc-config-dir-name", ".gjc"])).toThrow(
			"managed configuration does not accept GJC runtime location overrides",
		);
		expect(() => parseCliArguments(["configure", "managed", "--gjc-coding-agent-dir", "/opt/gjc-agent"])).toThrow(
			"managed configuration does not accept GJC runtime location overrides",
		);
	});

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
