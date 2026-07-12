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

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
for await (const line of lines) {
	let request: unknown;
	try {
		request = JSON.parse(line);
	} catch (error) {
		if (error instanceof SyntaxError) continue;
		throw error;
	}
	if (
		request !== null &&
		typeof request === "object" &&
		typeof Reflect.get(request, "id") === "string" &&
		Reflect.get(request, "type") === "get_state"
	) {
		const id = Reflect.get(request, "id");
		append(protocolTranscriptPath, { type: "request", payload: request });
		const response = {
			id,
			type: "response",
			command: "get_state",
			success: true,
			data: {
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
			},
		};
		append(protocolTranscriptPath, { type: "response", payload: response });
		process.stdout.write(`${JSON.stringify(response)}\n`);
	}
}
append(lifecycleTranscriptPath, { type: "eof" });
