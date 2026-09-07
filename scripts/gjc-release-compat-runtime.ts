import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { lifecycle } from "@gajae-code/coding-agent/sdk";
import {
	connectFor,
	lifecycleDeadlineMs,
	type PublicSdkSession,
	snapshotPublicSessions,
} from "./gjc-release-compat-sdk";

type Observe = (name: string, action: () => Promise<unknown>) => Promise<unknown>;
type TurnCorrelation = { sessionId: string; commandId: string; turnId: string };
export type SessionTranscriptIdentity = lifecycle.SessionLifecycleTranscriptIdentity;

export async function promptAndAwaitTerminal(
	client: PublicSdkSession,
	sessionId: string,
	name: string,
	text: string,
	observe: Observe,
): Promise<{ accepted: unknown; terminal: Record<string, unknown> }> {
	const terminal = awaitTerminal(client);
	const accepted = await observe(name, () => client.control("turn.prompt", { text }));
	const frame = await terminal(turnCorrelation(accepted, sessionId));
	await observe(`${name}.terminal`, async () => frame);
	return { accepted, terminal: frame };
}

export async function promptAndAbortTerminal(
	client: PublicSdkSession,
	sessionId: string,
	name: string,
	text: string,
	observe: Observe,
): Promise<{ accepted: unknown; abort: unknown; abortReplay: unknown; terminal: Record<string, unknown> }> {
	const terminal = awaitTerminal(client, true);
	const accepted = await observe(name, () => client.control("turn.prompt", { text }));
	const correlation = turnCorrelation(accepted, sessionId);
	const idempotencyKey = `terminal-abort-${crypto.randomUUID()}`;
	const abortInput = { mode: "terminal", scope: "turn" };
	const abort = await observe(`${name}.abort`, () => client.control("turn.abort", abortInput, { idempotencyKey }));
	assertTerminalAbortAcknowledgement(abort, name);
	const abortReplay = await observe(`${name}.abort.replay`, () =>
		client.control("turn.abort", abortInput, { idempotencyKey }),
	);
	assertTerminalAbortAcknowledgement(abortReplay, `${name}.abort.replay`);
	const frame = await terminal(correlation);
	await observe(`${name}.terminal`, async () => frame);
	return { accepted, abort, abortReplay, terminal: frame };
}

function awaitTerminal(
	client: PublicSdkSession,
	allowFailure = false,
): (correlation: TurnCorrelation) => Promise<Record<string, unknown>> {
	let pendingCorrelation: TurnCorrelation | undefined;
	let resolveTerminal: ((frame: Record<string, unknown>) => void) | undefined;
	const terminal = new Promise<Record<string, unknown>>(resolvePromise => {
		resolveTerminal = resolvePromise;
	});
	const pendingFrames: Array<{ readonly correlation: TurnCorrelation; readonly body: Record<string, unknown> }> = [];
	const matches = (frame: TurnCorrelation, correlation: TurnCorrelation) =>
		frame.sessionId === correlation.sessionId &&
		frame.commandId === correlation.commandId &&
		frame.turnId === correlation.turnId;
	const resolveMatching = () => {
		if (pendingCorrelation === undefined) return;
		const index = pendingFrames.findIndex(frame => matches(frame.correlation, pendingCorrelation!));
		if (index === -1) return;
		resolveTerminal?.(pendingFrames[index]!.body);
		resolveTerminal = undefined;
	};
	const unsubscribe = client.onFrame(frame => {
		const body = frame.body;
		if (body.type !== "agent_end" && body.type !== "agent_failed") return;
		if (frame.sessionId !== client.sessionId || frame.commandId === undefined || frame.turnId === undefined) return;
		pendingFrames.push({
			correlation: {
				sessionId: frame.sessionId,
				commandId: frame.commandId,
				turnId: frame.turnId,
			},
			body,
		});
		resolveMatching();
	});
	return async correlation => {
		pendingCorrelation = correlation;
		resolveMatching();
		try {
			const frame = await Promise.race([
				terminal,
				Bun.sleep(60_000).then(() => {
					throw new Error(
						`timed out awaiting terminal event for ${correlation.sessionId}/${correlation.commandId}/${correlation.turnId}`,
					);
				}),
			]);
			if (frame.type === "agent_failed" && !allowFailure)
				throw new Error(`turn failed: ${JSON.stringify(frame.error ?? frame)}`);
			return frame;
		} finally {
			unsubscribe();
		}
	};
}

function assertTerminalAbortAcknowledgement(value: unknown, operation: string): void {
	if (
		!isRecord(value) ||
		value.ok !== true ||
		!isRecord(value.result) ||
		value.result.ok !== true ||
		value.result.selection !== "turn" ||
		typeof value.result.turn !== "string"
	)
		throw new Error(`${operation} returned an invalid terminal abort acknowledgement`);
}

function turnCorrelation(value: unknown, sessionId: string): TurnCorrelation {
	if (!isRecord(value)) throw new Error("turn.prompt did not return an accepted correlation");
	const result = isRecord(value.result) ? value.result : value;
	if (typeof result.commandId !== "string" || typeof result.turnId !== "string")
		throw new Error("turn.prompt accepted response omitted commandId or turnId");
	return { sessionId, commandId: result.commandId, turnId: result.turnId };
}

export async function sessionIdFromPublicSdk(directory: string): Promise<string> {
	const deadline = Date.now() + lifecycleDeadlineMs;
	while (Date.now() < deadline) {
		const sessions = await snapshotPublicSessions(directory);
		if (sessions.size === 1) return sessions.keys().next().value!;
		if (sessions.size > 1) throw new Error(`public SDK session discovery is ambiguous (${sessions.size} sessions)`);
		await Bun.sleep(100);
	}
	throw new Error("could not discover a public SDK session");
}

export async function rediscoverSessionId(directory: string, previousSessionId: string): Promise<string> {
	const deadline = Date.now() + lifecycleDeadlineMs;
	for (;;) {
		const sessions = await snapshotPublicSessions(directory);
		for (const sessionId of sessions.keys()) if (sessionId !== previousSessionId) return sessionId;
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error("public lifecycle did not expose a successor session");
		await Bun.sleep(Math.min(100, remaining));
	}
}

export async function sessionFromFilesystem(
	directory: string,
	expectedSessionId: string,
): Promise<{
	readonly sessionId: string;
	readonly transcript: string;
	readonly headerSessionId: string;
	readonly identity: SessionTranscriptIdentity;
}> {
	const deadline = Date.now() + lifecycleDeadlineMs;
	for (;;) {
		for (const transcript of await jsonlFiles(directory))
			try {
				const firstLine = (await readFile(transcript, "utf8")).split(/\r?\n/, 1)[0];
				const value: unknown = firstLine === undefined ? undefined : JSON.parse(firstLine);
				if (isRecord(value) && typeof value.id === "string" && value.id === expectedSessionId)
					return {
						sessionId: value.id,
						transcript: resolve(transcript),
						headerSessionId: value.id,
						identity: await transcriptIdentity(transcript),
					};
			} catch {}
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error(`could not discover session transcript with header ${expectedSessionId}`);
		await Bun.sleep(Math.min(100, remaining));
	}
}

async function transcriptIdentity(path: string): Promise<SessionTranscriptIdentity> {
	const file = await readFile(path);
	const metadata = await stat(path, { bigint: true });
	return {
		dev: metadata.dev.toString(),
		ino: metadata.ino.toString(),
		size: Number(metadata.size),
		mtimeMs: Number(metadata.mtimeMs),
		mtimeNs: metadata.mtimeNs.toString(),
		sha256: createHash("sha256").update(file).digest("hex"),
	};
}

async function jsonlFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const file = join(directory, entry.name);
		if (entry.name === "node_modules" || entry.name === ".git") continue;
		if (entry.isDirectory()) files.push(...(await jsonlFiles(file)));
		else if (entry.isFile() && entry.name.endsWith(".jsonl") && (await stat(file)).size > 0) files.push(file);
	}
	return files;
}

export async function validateCurrentModel(
	client: PublicSdkSession,
	value: unknown,
	observe: Observe,
): Promise<boolean> {
	for (let page = 0, current = value; page < 100; page += 1) {
		const model = currentModelFrom(current);
		if (model !== undefined)
			return (
				isRecord(model.thinking) &&
				Array.isArray(model.thinking.validLevels) &&
				model.thinking.validLevels.includes("off")
			);
		const continuationCursor = findString(current, "continuationCursor");
		if (continuationCursor === undefined) break;
		current = await observe(`Q10.page.${page + 2}`, () =>
			client.query("models.list/current", {}, continuationCursor),
		);
	}
	throw new Error("Q10 did not expose compat-local/hermetic-model as the current model");
}

function currentModelFrom(value: unknown): Record<string, unknown> | undefined {
	if (isRecord(value)) {
		if (value.provider === "compat-local" && value.id === "hermetic-model" && value.current === true) return value;
		for (const child of Object.values(value)) {
			const model = currentModelFrom(child);
			if (model !== undefined) return model;
		}
	} else if (Array.isArray(value))
		for (const child of value) {
			const model = currentModelFrom(child);
			if (model !== undefined) return model;
		}
	return undefined;
}

export async function branchEntryId(directory: string, sessionId: string, observe: Observe): Promise<string> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const probe = await connectFor(directory, sessionId);
		try {
			const entryId = branchEntryIdFrom(
				await observe(attempt === 0 ? "Q16" : `Q16.retry.${attempt}`, () =>
					probe.query("session.branch_candidates"),
				),
			);
			if (entryId !== undefined) return entryId;
		} finally {
			await probe.close();
		}
		await Bun.sleep(100);
	}
	throw new Error("Q16 did not expose a branch entryId");
}

function branchEntryIdFrom(value: unknown): string | undefined {
	if (isRecord(value)) {
		const entry = value.entry;
		if (
			isRecord(entry) &&
			typeof entry.id === "string" &&
			entry.type === "message" &&
			isRecord(entry.message) &&
			entry.message.role === "user"
		)
			return entry.id;
		for (const child of Object.values(value)) {
			const found = branchEntryIdFrom(child);
			if (found !== undefined) return found;
		}
	} else if (Array.isArray(value))
		for (const child of value) {
			const found = branchEntryIdFrom(child);
			if (found !== undefined) return found;
		}
	return undefined;
}

export function sessionIdFrom(value: unknown): string | undefined {
	return findString(value, "sessionId");
}

function findString(value: unknown, key: string): string | undefined {
	if (isRecord(value)) {
		if (typeof value[key] === "string") return value[key] as string;
		for (const child of Object.values(value)) {
			const found = findString(child, key);
			if (found !== undefined) return found;
		}
	} else if (Array.isArray(value))
		for (const child of value) {
			const found = findString(child, key);
			if (found !== undefined) return found;
		}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
