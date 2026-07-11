import { randomBytes } from "node:crypto";
import { fstatSync, openSync, readSync } from "node:fs";
import { TextDecoder } from "node:util";

export class CredentialError extends Error {
	readonly exitCode = 1;
}

/** Reads one bounded UTF-8 secret from an inherited descriptor without taking ownership of it. */
export function readSecretFromFd(fd: number): string {
	if (!Number.isSafeInteger(fd) || fd < 0 || !Number.isInteger(fd)) {
		throw new CredentialError("secret FD must be a non-negative decimal integer");
	}
	const chunks: Buffer[] = [];
	const buffer = Buffer.alloc(4096);
	let length = 0;
	try {
		for (;;) {
			const count = readSync(fd, buffer, 0, buffer.length, null);
			if (count === 0) break;
			length += count;
			if (length > 16_384) throw new CredentialError("secret is too long");
			chunks.push(Buffer.from(buffer.subarray(0, count)));
		}
	} catch (error) {
		if (error instanceof CredentialError) throw error;
		throw new CredentialError(`cannot read secret FD: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
		const value = decoded.endsWith("\n") ? decoded.slice(0, -1) : decoded;
		if (!decoded.endsWith("\n") || value.endsWith("\n") || value.includes("\r"))
			throw new CredentialError("secret FD must contain exactly one LF-terminated record");
		if (value.length === 0) throw new CredentialError("secret must not be empty");
		for (const character of value) {
			const code = character.codePointAt(0) ?? 0;
			if (code < 0x20 || code === 0x7f) throw new CredentialError("secret contains forbidden control characters");
		}
		return value;
	} catch (error) {
		if (error instanceof CredentialError) throw error;
		throw new CredentialError("secret FD must contain valid UTF-8");
	}
}

export function openSecretFile(path: string): number {
	return openSync(path, "r");
}
export function generateAdapterToken(): string {
	return randomBytes(32).toString("base64url");
}
export function canDisplaySecret(
	input: NodeJS.ReadStream = process.stdin,
	output: NodeJS.WriteStream = process.stdout,
): boolean {
	if (!input.isTTY || !output.isTTY) return false;
	const inputFd = (input as NodeJS.ReadStream & { fd?: number }).fd;
	const outputFd = (output as NodeJS.WriteStream & { fd?: number }).fd;
	if (Number.isInteger(inputFd) && Number.isInteger(outputFd)) {
		try {
			const inputStat = fstatSync(inputFd!),
				outputStat = fstatSync(outputFd!);
			return inputStat.dev === outputStat.dev && inputStat.ino === outputStat.ino;
		} catch {
			return false;
		}
	}
	return false;
}
export function displayAdapterToken(
	token: string,
	input: NodeJS.ReadStream = process.stdin,
	output: NodeJS.WriteStream = process.stdout,
): void {
	if (!canDisplaySecret(input, output)) throw new CredentialError("adapter token display requires a controlling TTY");
	output.write(`${token}\n`);
}
export function readSecretRecordFromFd(fd: number): string {
	return readSecretFromFd(fd);
}
