import { open } from "node:fs/promises";
import type { GjcTurnEvent } from "../gjc/turn-runner";

const MAX_ARTIFACT_BYTES = 256 * 1024;
const MAX_ROWS = 512;
const MAX_EVENTS = 128;
const MAX_SUMMARY_LENGTH = 2_000;
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;

type JsonRecord = Record<string, unknown>;

export async function projectSessionArtifactEvents(
	sessionFile: string | undefined,
	prompt: string,
): Promise<readonly GjcTurnEvent[]> {
	if (sessionFile === undefined) return [];
	try {
		const artifact = await readBoundedArtifact(sessionFile);
		if (artifact === undefined) return [];
		const rows = parseRows(artifact);
		if (rows === undefined) return [];
		const boundary = lastPromptBoundary(rows, prompt);
		return boundary === -1 ? [] : projectRows(rows.slice(boundary + 1));
	} catch {
		return [];
	}
}

async function readBoundedArtifact(path: string): Promise<string | undefined> {
	const file = await open(path, "r");
	try {
		const buffer = Buffer.alloc(MAX_ARTIFACT_BYTES + 1);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		return bytesRead > MAX_ARTIFACT_BYTES ? undefined : buffer.subarray(0, bytesRead).toString("utf8");
	} finally {
		await file.close();
	}
}

function parseRows(artifact: string): readonly JsonRecord[] | undefined {
	const lines = artifact.split("\n");
	if (lines.at(-1) === "") lines.pop();
	if (lines.length === 0 || lines.length > MAX_ROWS) return undefined;
	const rows: JsonRecord[] = [];
	for (const line of lines) {
		if (line.length === 0) return undefined;
		try {
			const row: unknown = JSON.parse(line);
			if (!isRecord(row)) return undefined;
			rows.push(row);
		} catch {
			return undefined;
		}
	}
	return rows;
}

function lastPromptBoundary(rows: readonly JsonRecord[], prompt: string): number {
	let boundary = -1;
	for (const [index, row] of rows.entries()) {
		if (row.type !== "message" || !isRecord(row.message)) continue;
		if (row.message.role === "user" && isPromptContent(row.message.content, prompt)) boundary = index;
	}
	return boundary;
}

function projectRows(rows: readonly JsonRecord[]): readonly GjcTurnEvent[] {
	const events: GjcTurnEvent[] = [];
	for (const row of rows) {
		if (row.type !== "message" || !isRecord(row.message)) return [];
		const message = row.message;
		if (message.role === "assistant") {
			if (!Array.isArray(message.content)) return [];
			for (const content of message.content) {
				if (!projectAssistantContent(content, events) || events.length > MAX_EVENTS) return [];
			}
		} else if (message.role === "toolResult") {
			if (!validToolName(message.toolName)) return [];
			events.push(toolEvent("tool_execution_end", message.toolName));
			if (events.length > MAX_EVENTS) return [];
		} else return [];
	}
	return events;
}

function projectAssistantContent(content: unknown, events: GjcTurnEvent[]): boolean {
	if (!isRecord(content) || typeof content.type !== "string") return false;
	switch (content.type) {
		case "text":
			return typeof content.text === "string";
		case "toolCall":
			if (!validToolName(content.name)) return false;
			events.push(toolEvent("tool_execution_start", content.name));
			return true;
		case "thinking":
			if (typeof content.thinking !== "string") return false;
			if (content.provenance !== "summary") return content.provenance === "raw" || content.provenance === "mixed";
			if (!boundedSummary(content.summaryText)) return false;
			events.push(
				thinkingEvent("thinking_start", content.summaryText),
				thinkingEvent("thinking_end", content.summaryText),
			);
			return true;
		case "redactedThinking":
			return typeof content.data === "string";
		default:
			return false;
	}
}

function toolEvent(type: "tool_execution_start" | "tool_execution_end", toolName: string): GjcTurnEvent {
	return { type, payload: { toolName } };
}
function thinkingEvent(type: "thinking_start" | "thinking_end", text: string): GjcTurnEvent {
	return { type: "message_update", payload: { assistantMessageEvent: { type, text } } };
}
function isPromptContent(content: unknown, prompt: string): boolean {
	return (
		content === prompt ||
		(Array.isArray(content) &&
			content.length === 1 &&
			isRecord(content[0]) &&
			content[0].type === "text" &&
			content[0].text === prompt)
	);
}
function validToolName(value: unknown): value is string {
	return typeof value === "string" && TOOL_NAME.test(value);
}
function boundedSummary(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_SUMMARY_LENGTH;
}
function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
