import type { OpenAIChatCompletionChunk } from "../live/openai-types";
import {
	buildOpenWebUICitationEvent,
	buildOpenWebUIFilesEvent,
	buildOpenWebUISourceEvent,
	buildOpenWebUIStatusEvent,
	type OpenWebUIFileData,
	type OpenWebUIMessageEvent,
} from "../openwebui/events";

export type ProjectableAgentFrame =
	| AssistantTextFrame
	| ProgressFrame
	| FilesFrame
	| SourceFrame
	| CitationFrame
	| UnsupportedFrame;

export interface AssistantTextFrame {
	readonly kind: "assistant_text";
	readonly text: string;
}

export interface ProgressFrame {
	readonly kind: "tool_progress" | "mcp_progress" | "skill_progress" | "subagent_progress";
	readonly label: string;
	readonly phase: "start" | "progress" | "end";
	readonly hidden?: boolean;
	readonly metadata?: Record<string, unknown>;
}

export interface FilesFrame {
	readonly kind: "files";
	readonly files: readonly OpenWebUIFileData[];
}

export interface SourceFrame {
	readonly kind: "source";
	readonly source: Record<string, unknown>;
}

export interface CitationFrame {
	readonly kind: "citation";
	readonly citation: Record<string, unknown>;
}

export interface UnsupportedFrame {
	readonly kind: "unsupported";
	readonly eventType?: string;
	readonly id?: string | null;
	readonly textPresent?: boolean;
}

export interface ProjectedAgentFrame {
	readonly sseChunks: readonly string[];
	readonly events: readonly OpenWebUIMessageEvent[];
}

export interface OpenAISseProjectionInput {
	readonly id: string;
	readonly created: number;
	readonly model: string;
}

export function projectAgentFrame(frame: ProjectableAgentFrame, sse: OpenAISseProjectionInput): ProjectedAgentFrame {
	switch (frame.kind) {
		case "assistant_text":
			return { sseChunks: [encodeOpenAISseTextChunk(frame.text, sse)], events: [] };
		case "tool_progress":
		case "mcp_progress":
		case "skill_progress":
		case "subagent_progress":
			return {
				sseChunks: [],
				events: [
					buildOpenWebUIStatusEvent({
						description: frame.label,
						done: frame.phase === "end",
						hidden: frame.hidden,
						gjc_adapter: progressGjcAdapterMetadata(frame),
					}),
				],
			};
		case "files":
			return { sseChunks: [], events: [buildOpenWebUIFilesEvent(frame.files)] };
		case "source":
			return { sseChunks: [], events: [buildOpenWebUISourceEvent(frame.source)] };
		case "citation":
			return { sseChunks: [], events: [buildOpenWebUICitationEvent(frame.citation)] };
		case "unsupported":
			return {
				sseChunks: [],
				events: [
					buildOpenWebUIStatusEvent({
						description: "Unsupported GJC frame",
						done: true,
						hidden: true,
						gjc_adapter: {
							diagnostic: "unsupported_frame",
							...unsupportedDiagnosticAdapterMetadata(frame),
						},
					}),
				],
			};
	}
}

function progressGjcAdapterMetadata(frame: ProgressFrame): Record<string, unknown> {
	const metadata = frame.metadata ?? {};
	const workflowGate = metadata.workflow_gate;
	return {
		frameKind: frame.kind,
		phase: frame.phase,
		metadata,
		...(isRecord(workflowGate) ? { workflow_gate: workflowGate } : {}),
	};
}

function unsupportedDiagnosticAdapterMetadata(frame: UnsupportedFrame): Record<string, unknown> {
	const metadata = unsupportedDiagnosticMetadata(frame);
	return Object.keys(metadata).length === 0 ? {} : { metadata };
}
function unsupportedDiagnosticMetadata(frame: UnsupportedFrame): Record<string, string | boolean | null> {
	return {
		...(frame.eventType === undefined ? {} : { eventType: boundedText(frame.eventType) }),
		...(frame.id === undefined ? {} : { id: frame.id === null ? null : boundedText(frame.id) }),
		...(frame.textPresent === undefined ? {} : { textPresent: frame.textPresent }),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function encodeOpenAISseTextChunk(content: string, input: OpenAISseProjectionInput): string {
	const chunk: OpenAIChatCompletionChunk = {
		id: input.id,
		object: "chat.completion.chunk",
		created: input.created,
		model: input.model,
		choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
	};
	return `data: ${JSON.stringify(chunk)}\n\n`;
}
function boundedText(value: string, maxLength = 80): string {
	return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}
