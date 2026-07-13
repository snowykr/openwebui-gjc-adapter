import type { Message } from "@gajae-code/ai";
import type { SessionEntry, SessionHeader, SessionMessageEntry } from "@gajae-code/coding-agent";
import type {
	GjcContinueSessionInput,
	GjcSessionAddress,
	GjcSessionState,
	GjcSessionStateInput,
	GjcStartNewSessionInput,
	GjcSwitchSessionInput,
	GjcTurnResult,
	GjcTurnRunner,
} from "../src/gjc/rpc-runner";

export const ownerUserId = "owner-1";
export const createdAt = new Date("2026-07-08T00:00:00.000Z");
export const sseInput = { id: "chatcmpl-golden", created: 1783468800, model: "gjc/golden" };
export const deliveredEvents: { events: readonly { type: string }[] }[] = [];

export function goldenHeader(cwd: string): SessionHeader {
	return {
		type: "session",
		version: 3,
		id: "session-golden",
		title: "Golden session",
		timestamp: "2026-07-08T00:00:00.000Z",
		cwd,
	};
}

export function goldenEntries(): SessionEntry[] {
	return [
		messageEntry("u-root", null, "user", "Register this project"),
		customEntry("migration-v2", "u-root", "migration", { from: "legacy-openwebui-chat" }),
		messageEntry("a-left", "migration-v2", "assistant", "Imported branch"),
		messageEntry("a-right", "u-root", "assistant", "Active branch"),
		customEntry("blob-ref", "a-right", "blob", { bytes: 1048576, path: "blob://cold" }),
		customEntry("cold-spill", "blob-ref", "cold-spill", { reason: "large transcript" }),
		messageEntry("u-leaf", "cold-spill", "user", "Continue live"),
	];
}

export class GoldenTurnRunner implements GjcTurnRunner {
	readonly starts: GjcStartNewSessionInput[] = [];
	readonly continues: GjcContinueSessionInput[] = [];
	readonly switches: GjcSwitchSessionInput[] = [];
	readonly states: GjcSessionStateInput[] = [];

	constructor(private readonly sessionFile: string) {}

	async startNewSession(input: GjcStartNewSessionInput): Promise<GjcSessionAddress & GjcTurnResult> {
		this.starts.push(input);
		return {
			cwd: input.cwd,
			sessionRoot: input.sessionRoot,
			projectId: input.projectId,
			chatId: input.chatId,
			sessionId: "session-live",
			text: "started",
			events: [{ type: "tool_execution_end", text: "Tool finished", id: "tool-1" }],
			sessionFile: this.sessionFile,
			activeLeaf: "assistant-1",
			rawFrameCursor: 1,
			eventCursor: 1,
			...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
		};
	}

	async continueSession(input: GjcContinueSessionInput): Promise<GjcTurnResult> {
		this.continues.push(input);
		return {
			text: "continued",
			events: [{ type: "workflow_gate", text: "Approve continuation", id: "gate-live" }],
			sessionFile: input.sessionFile,
			activeLeaf: "assistant-2",
			rawFrameCursor: input.rawFrameCursor + 1,
			eventCursor: input.eventCursor + 1,
			...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
		};
	}

	async switchSession(input: GjcSwitchSessionInput): Promise<void> {
		this.switches.push(input);
	}

	async getState(input: GjcSessionStateInput): Promise<GjcSessionState> {
		this.states.push(input);
		return { sessionFile: input.sessionFile, activeLeaf: "assistant-1", rawFrameCursor: 1, eventCursor: 1 };
	}
}

export function liveHeaders(
	chatId: string,
	messageId: string,
	userMessageId: string,
	parentId: string | null,
): Record<string, string> {
	return {
		"X-OpenWebUI-Chat-Id": chatId,
		"X-OpenWebUI-Message-Id": messageId,
		"X-OpenWebUI-User-Message-Id": userMessageId,
		"X-OpenWebUI-User-Message-Parent-Id": parentId ?? "",
		"X-OpenWebUI-User-Id": ownerUserId,
	};
}

export function failGate() {
	throw new Error("expected pending gate");
}

function messageEntry(
	id: string,
	parentId: string | null,
	role: Message["role"],
	content: Message["content"],
): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-07-08T00:00:00.000Z",
		message: { role, content, timestamp: 1783468800000 } as Message,
	};
}

function customEntry(
	id: string,
	parentId: string | null,
	customType: string,
	data: Record<string, unknown>,
): SessionEntry {
	return {
		type: "custom",
		id,
		parentId,
		timestamp: "2026-07-08T00:00:00.000Z",
		customType,
		data,
	} as SessionEntry;
}
