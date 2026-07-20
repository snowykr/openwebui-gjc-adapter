import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SdkClient } from "@gajae-code/coding-agent/sdk";
import { connectFor, lifecycleDeadlineMs, snapshotPublicEndpoints } from "./gjc-release-compat-sdk";

type Observe = (name: string, action: () => Promise<unknown>) => Promise<unknown>;
type Run = (command: string, args: readonly string[], env?: Record<string, string | undefined>, allowFailure?: boolean) => Promise<string>;
type TurnCorrelation = { sessionId: string; commandId: string; turnId: string };
type SessionBootstrap = { readonly sessionId?: string; readonly sessionFile?: string };

export async function promptAndAwaitTerminal(client: SdkClient, sessionId: string, name: string, text: string, observe: Observe): Promise<{ accepted: unknown; terminal: Record<string, unknown> }> {
	const terminal = awaitTerminal(client);
	const accepted = await observe(name, () => client.control("turn.prompt", { text }));
	const frame = await terminal(turnCorrelation(accepted, sessionId));
	await observe(`${name}.terminal`, async () => frame);
	return { accepted, terminal: frame };
}
function awaitTerminal(client: SdkClient): (correlation: TurnCorrelation) => Promise<Record<string, unknown>> {
	let pendingCorrelation: TurnCorrelation | undefined;
	let resolveTerminal: ((frame: Record<string, unknown>) => void) | undefined;
	const terminal = new Promise<Record<string, unknown>>(resolve => { resolveTerminal = resolve; });
	const pendingFrames: Record<string, unknown>[] = [];
	const matches = (frame: Record<string, unknown>, correlation: TurnCorrelation) => frame.sessionId === correlation.sessionId && frame.commandId === correlation.commandId && frame.turnId === correlation.turnId;
	const resolveMatching = () => {
		if (pendingCorrelation === undefined) return;
		const index = pendingFrames.findIndex(frame => matches(frame, pendingCorrelation!));
		if (index === -1) return;
		resolveTerminal?.(pendingFrames[index]!); resolveTerminal = undefined;
	};
	const unsubscribe = client.onFrame(frame => {
		if (!isRecord(frame) || (frame.type !== "agent_end" && frame.type !== "agent_failed")) return;
		pendingFrames.push(frame); resolveMatching();
	});
	return async correlation => {
		pendingCorrelation = correlation; resolveMatching();
		try {
			const frame = await Promise.race([terminal, Bun.sleep(60_000).then(() => { throw new Error(`timed out awaiting terminal event for ${correlation.sessionId}/${correlation.commandId}/${correlation.turnId}`); })]);
			if (frame.type === "agent_failed") throw new Error(`turn failed: ${JSON.stringify(frame.error ?? frame)}`);
			return frame;
		} finally { unsubscribe(); }
	};
}
function turnCorrelation(value: unknown, sessionId: string): TurnCorrelation {
	if (!isRecord(value)) throw new Error("turn.prompt did not return an accepted correlation");
	const result = isRecord(value.result) ? value.result : value;
	if (typeof result.commandId !== "string" || typeof result.turnId !== "string") throw new Error("turn.prompt accepted response omitted commandId or turnId");
	return { sessionId, commandId: result.commandId, turnId: result.turnId };
}

export async function openSessionDashboard(target: string, run: Run): Promise<SessionBootstrap> {
	let sent = false;
	for (let attempt = 0; attempt < 300; attempt += 1) {
		const output = await run("tmux", ["capture-pane", "-p", "-t", target, "-S", "-200"]);
		if (output.includes("Sessions dashboard")) { await run("tmux", ["send-keys", "-t", target, "Escape"]); await Bun.sleep(1_000); return sessionBootstrapFrom(output); }
		const bootstrap = sessionBootstrapFrom(output);
		if (output.includes("Session Info") && bootstrap.sessionId !== undefined && bootstrap.sessionFile !== undefined) return bootstrap;
		if (!sent && output.includes("Type your message")) { await run("tmux", ["send-keys", "-t", target, "/session", "Enter"]); sent = true; }
		await Bun.sleep(100);
	}
	throw new Error(`interactive session ${target} did not open /session`);
}
function sessionBootstrapFrom(output: string): SessionBootstrap {
	const sessionId = /(?:^|\n)\s*(?:ID|Session ID)\s*:\s*([^\s]+)\s*$/im.exec(output)?.[1];
	const sessionFile = /(?:^|\n)\s*File\s*:\s*(\S(?:.*\S)?)\s*$/im.exec(output)?.[1];
	return { ...(sessionId === undefined ? {} : { sessionId }), ...(sessionFile === undefined ? {} : { sessionFile }) };
}
export async function sessionIdFromEndpoint(directory: string): Promise<string> {
	const deadline = Date.now() + lifecycleDeadlineMs;
	while (Date.now() < deadline) {
		const endpoints = await snapshotPublicEndpoints(directory);
		if (endpoints.size === 1) return endpoints.values().next().value!.sessionId;
		if (endpoints.size > 1) throw new Error(`interactive public SDK endpoint discovery is ambiguous (${endpoints.size} endpoints)`);
		await Bun.sleep(100);
	}
	throw new Error("could not discover an interactive public SDK endpoint");
}
export async function rediscoverSessionId(directory: string, previousSessionId: string): Promise<string> {
	const stateDirectory = join(directory, ".gjc", "state", "sdk");
	for (let attempt = 0; attempt < 300; attempt += 1) {
		try { for (const entry of await readdir(stateDirectory)) {
			if (!entry.endsWith(".json") || entry === `${previousSessionId}.json`) continue;
			const value: unknown = JSON.parse(await readFile(join(stateDirectory, entry), "utf8"));
			if (isRecord(value) && typeof value.sessionId === "string") return value.sessionId;
		} } catch {}
		await Bun.sleep(100);
	}
	throw new Error("branch did not expose a sessionId and no rotated SDK descriptor was published");
}
export async function sessionFromFilesystem(directory: string, expectedSessionId: string): Promise<{ sessionId: string; transcript: string; headerSessionId: string }> {
	for (let attempt = 0; attempt < 300; attempt += 1) {
		for (const transcript of await jsonlFiles(directory)) try {
			const firstLine = (await readFile(transcript, "utf8")).split(/\r?\n/, 1)[0];
			const value: unknown = firstLine === undefined ? undefined : JSON.parse(firstLine);
			if (isRecord(value) && typeof value.id === "string" && value.id === expectedSessionId) return { sessionId: value.id, transcript: resolve(transcript), headerSessionId: value.id };
		} catch {}
		await Bun.sleep(100);
	}
	throw new Error(`could not discover an interactive session transcript with header ${expectedSessionId}`);
}
async function jsonlFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true }); const files: string[] = [];
	for (const entry of entries) { const file = join(directory, entry.name);
		if (entry.name === "node_modules" || entry.name === ".git") continue;
		if (entry.isDirectory()) files.push(...(await jsonlFiles(file)));
		else if (entry.isFile() && entry.name.endsWith(".jsonl") && (await stat(file)).size > 0) files.push(file);
	}
	return files;
}

export async function validateCurrentModel(client: SdkClient, value: unknown, observe: Observe): Promise<boolean> {
	for (let page = 0, current = value; page < 100; page += 1) {
		const model = currentModelFrom(current);
		if (model !== undefined) return isRecord(model.thinking) && Array.isArray(model.thinking.validLevels) && model.thinking.validLevels.includes("off");
		const continuationCursor = findString(current, "continuationCursor");
		if (continuationCursor === undefined) break;
		current = await observe(`Q10.page.${page + 2}`, () => client.query("models.list/current", {}, continuationCursor));
	}
	throw new Error("Q10 did not expose compat-local/hermetic-model as the current model");
}
function currentModelFrom(value: unknown): Record<string, unknown> | undefined {
	if (isRecord(value)) { if (value.provider === "compat-local" && value.id === "hermetic-model" && value.current === true) return value; for (const child of Object.values(value)) { const model = currentModelFrom(child); if (model !== undefined) return model; } }
	else if (Array.isArray(value)) for (const child of value) { const model = currentModelFrom(child); if (model !== undefined) return model; }
	return undefined;
}
export async function branchEntryId(directory: string, sessionId: string, observe: Observe): Promise<string> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const probe = await connectFor(directory, sessionId);
		try { const entryId = branchEntryIdFrom(await observe(attempt === 0 ? "Q16" : `Q16.retry.${attempt}`, () => probe.query("session.branch_candidates"))); if (entryId !== undefined) return entryId; }
		finally { await probe.close(); }
		await Bun.sleep(100);
	}
	throw new Error("Q16 did not expose a branch entryId");
}
function branchEntryIdFrom(value: unknown): string | undefined {
	if (isRecord(value)) { const entry = value.entry; if (isRecord(entry) && typeof entry.id === "string" && entry.type === "message" && isRecord(entry.message) && entry.message.role === "user") return entry.id; for (const child of Object.values(value)) { const found = branchEntryIdFrom(child); if (found !== undefined) return found; } }
	else if (Array.isArray(value)) for (const child of value) { const found = branchEntryIdFrom(child); if (found !== undefined) return found; }
	return undefined;
}
export function sessionIdFrom(value: unknown): string | undefined { return findString(value, "sessionId"); }
function findString(value: unknown, key: string): string | undefined {
	if (isRecord(value)) { if (typeof value[key] === "string") return value[key] as string; for (const child of Object.values(value)) { const found = findString(child, key); if (found !== undefined) return found; } }
	else if (Array.isArray(value)) for (const child of value) { const found = findString(child, key); if (found !== undefined) return found; }
	return undefined;
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
