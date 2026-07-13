import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const transcriptPath = process.env.GJC_RPC_FIXTURE_ENV_TRANSCRIPT;
const protocolTranscriptPath = process.env.GJC_RPC_FIXTURE_PROTOCOL_TRANSCRIPT;
const lifecycleTranscriptPath = process.env.GJC_RPC_FIXTURE_LIFECYCLE_TRANSCRIPT;

function append(path: string | undefined, value: unknown): void {
	if (path !== undefined) appendFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8" });
}

if (transcriptPath !== undefined) {
	append(transcriptPath, {
		HOME: process.env.HOME,
		GJC_CONFIG_DIR: process.env.GJC_CONFIG_DIR,
		GJC_CODING_AGENT_DIR: process.env.GJC_CODING_AGENT_DIR,
		PI_CONFIG_DIR_present: Object.hasOwn(process.env, "PI_CONFIG_DIR"),
		XDG_DATA_HOME: process.env.XDG_DATA_HOME,
		XDG_STATE_HOME: process.env.XDG_STATE_HOME,
		XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
	});
}
append(protocolTranscriptPath, { type: "process", argv: process.argv.slice(2), cwd: process.cwd() });
append(lifecycleTranscriptPath, { type: "started", pid: process.pid });

process.once("SIGTERM", () => {
	append(lifecycleTranscriptPath, { type: "stopped" });
	process.exit(0);
});

process.stdout.write('{"type":"ready"}\n');

const sessionState = {
	thinkingLevel: "off",
	isStreaming: false,
	isCompacting: false,
	steeringMode: "one-at-a-time",
	followUpMode: "one-at-a-time",
	interruptMode: "immediate",
	sessionId: "fixture-session",
	autoCompactionEnabled: true,
	messageCount: 0,
	queuedMessageCount: 0,
	todoPhases: [],
} as const;

const workflowGate = {
	type: "workflow_gate",
	gate_id: "wg_fixture_ralplan_000001",
	stage: "ralplan",
	kind: "approval",
	schema: { type: "boolean" },
	schema_hash: "0000000000000000000000000000000000000000000000000000000000000001",
	context: { title: "Fixture approval" },
	created_at: "2026-01-01T00:00:00.000Z",
	required: true,
} as const;

function respond(request: object, command: string, data?: unknown): void {
	const response = {
		id: Reflect.get(request, "id"),
		type: "response",
		command,
		success: true,
		...(data === undefined ? {} : { data }),
	};
	append(protocolTranscriptPath, { type: "response", payload: response });
	process.stdout.write(`${JSON.stringify(response)}\n`);
}

function emit(value: unknown): void {
	append(protocolTranscriptPath, { type: "frame", payload: value });
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
for await (const line of lines) {
	let request: unknown;
	try {
		request = JSON.parse(line);
	} catch (error) {
		if (error instanceof SyntaxError) continue;
		throw error;
	}
	if (request === null || typeof request !== "object" || typeof Reflect.get(request, "id") !== "string") continue;
	append(protocolTranscriptPath, { type: "request", payload: request });
	switch (Reflect.get(request, "type")) {
		case "get_state":
			respond(request, "get_state", sessionState);
			break;
		case "get_available_models":
			respond(request, "get_available_models", { models: [] });
			break;
		case "set_default_model_selection":
			respond(request, "set_default_model_selection", {
				provider: Reflect.get(request, "provider"),
				modelId: Reflect.get(request, "modelId"),
				thinkingLevel: Reflect.get(request, "thinkingLevel"),
			});
			break;
		case "new_session":
			respond(request, "new_session", { cancelled: false });
			break;
		case "prompt":
			respond(request, "prompt");
			if (Reflect.get(request, "message") === "fixture gate") {
				emit(workflowGate);
				break;
			}
			emit({
				type: "event",
				protocol_version: 2,
				session_id: "fixture-session",
				seq: 1,
				frame_id: "frame-1",
				payload: { event_type: "agent_start", event: { type: "agent_start" } },
			});
			emit({
				type: "event",
				protocol_version: 2,
				session_id: "fixture-session",
				seq: 2,
				frame_id: "frame-2",
				payload: { event_type: "agent_end", event: { type: "agent_end", messages: [], stopReason: "completed" } },
			});
			break;
		case "workflow_gate_response":
			respond(request, "workflow_gate_response", {
				gate_id: "wg_fixture_ralplan_000001",
				status: "accepted",
				answer_hash: "1111111111111111111111111111111111111111111111111111111111111111",
				resolved_at: "2026-01-01T00:00:01.000Z",
			});
			break;
		case "get_last_assistant_text":
			respond(request, "get_last_assistant_text", { text: "fixture assistant" });
			break;
	}
}
append(lifecycleTranscriptPath, { type: "eof" });
