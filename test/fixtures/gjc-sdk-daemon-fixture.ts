import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { resolveGjcSdkSessionRoot } from "../../src/gjc/session-root";

const delayMs = Number(process.env.GJC_SDK_FIXTURE_DELAY_MS ?? "0");
if (Number.isFinite(delayMs) && delayMs > 0) await Bun.sleep(delayMs);

const argv = process.argv.slice(2);
const transcript = requiredEnvironment("GJC_SDK_FIXTURE_CLI_TRANSCRIPT");
const rawBunChild =
	process.env.GJC_SDK_FIXTURE_SPAWN_RAW_BUN === "1"
		? Bun.spawnSync([process.execPath, requiredEnvironment("GJC_SDK_FIXTURE_RAW_BUN_CHILD_ENTRYPOINT")], {
				cwd: process.cwd(),
				env: process.env,
			})
		: undefined;
appendFileSync(
	transcript,
	`${JSON.stringify({
		argv,
		cwd: process.cwd(),
		environment: {
			HOME: process.env.HOME,
			GJC_CONFIG_DIR: process.env.GJC_CONFIG_DIR,
			GJC_CODING_AGENT_DIR: process.env.GJC_CODING_AGENT_DIR,
			PI_CONFIG_DIR_present: process.env.PI_CONFIG_DIR !== undefined,
			XDG_DATA_HOME: process.env.XDG_DATA_HOME,
			XDG_STATE_HOME: process.env.XDG_STATE_HOME,
			XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
			adapterKeys: Object.keys(process.env).filter(name => name.startsWith("GJC_OPENWEBUI_")),
		},
		hostileDotenv: process.env.GJC_SDK_HOSTILE_DOTENV,
		agentDotenv: process.env.GJC_SDK_AGENT_DOTENV,
		sessionCommand: process.env.GJC_SDK_SESSION_COMMAND,
		rawBunChild:
			rawBunChild === undefined
				? undefined
				: {
						exitCode: rawBunChild.exitCode,
						stdout: rawBunChild.stdout.toString(),
						stderr: rawBunChild.stderr.toString(),
					},
	})}\n`,
);

if (argv.includes("--mode") || argv.includes("rpc")) {
	process.stderr.write("legacy --mode rpc is forbidden by the SDK v3 fixture\n");
	process.exit(64);
}

const action = argv[2];
const operation = action === "list" ? "session.list" : valueAfter("--op");
const input = await readInput();
appendFileSync(transcript, `${JSON.stringify({ operation, input })}\n`);

switch (operation) {
	case "session.create":
	case "session.resume":
		write({
			ok: true,
			result: {
				sessionId:
					operation === "session.create"
						? (process.env.GJC_SDK_FIXTURE_SESSION_ID ?? "sdk-session-created")
						: String(input.sessionId),
				cwd: String(input.cwd),
				endpoint: {
					url: requiredEnvironment("GJC_SDK_FIXTURE_ENDPOINT_URL"),
					token: authorityToken(
						operation === "session.create"
							? (process.env.GJC_SDK_FIXTURE_SESSION_ID ?? "sdk-session-created")
							: String(input.sessionId),
						String(input.cwd),
					),
				},
			},
		});
		break;
	case "session.list":
		write({
			ok: true,
			result: {
				savedSession: {
					id: process.env.GJC_SDK_FIXTURE_SAVED_ID ?? String(input.resolveSessionId),
					path:
						process.env.GJC_SDK_FIXTURE_SAVED_PATH ??
						defaultSavedSessionPath(String(input.cwd), String(input.resolveSessionId)),
				},
				sessions: [
					{
						sessionId: "sdk-session-resumed",
						path: "/workspace/.gjc/sessions/sdk-session-resumed.jsonl",
						live: true,
					},
				],
			},
		});
		break;
	case "session.close":
		if (process.env.GJC_SDK_FIXTURE_CLOSE_FAILURE === "1") {
			write({ ok: false, error: { code: "close_failed", message: "fixture session.close failed" } });
			process.exitCode = 1;
		} else {
			write({ ok: true, result: { sessionId: input.sessionId } });
		}
		break;
	default:
		write({ ok: false, error: { code: "unknown_operation", message: String(operation) } });
		process.exitCode = 1;
}

function valueAfter(flag: string): string | undefined {
	const index = argv.indexOf(flag);
	return index === -1 ? undefined : argv[index + 1];
}

async function readInput(): Promise<Readonly<Record<string, unknown>>> {
	const inline = valueAfter("--json-input");
	const raw = inline ?? (argv.includes("--json-input-stdin") ? await Bun.stdin.text() : "{}");
	const parsed: unknown = JSON.parse(raw);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new TypeError("SDK fixture input must be an object");
	}
	return Object.fromEntries(Object.entries(parsed));
}

function requiredEnvironment(name: string): string {
	const value = process.env[name];
	if (value === undefined || value.length === 0) throw new TypeError(`${name} is required`);
	return value;
}

function authorityToken(sessionId: string, cwd: string): string {
	const token = requiredEnvironment("GJC_SDK_FIXTURE_ENDPOINT_TOKEN");
	if (process.env.GJC_SDK_FIXTURE_DYNAMIC_AUTHORITY !== "1") return token;
	return `${token}.${Buffer.from(JSON.stringify({ sessionId, cwd })).toString("base64url")}`;
}

function defaultSavedSessionPath(cwd: string, sessionId: string): string {
	const home = requiredEnvironment("HOME");
	const agentDir = requiredEnvironment("GJC_CODING_AGENT_DIR");
	return join(resolveGjcSdkSessionRoot(cwd, { home, agentDir }), `${sessionId}.jsonl`);
}

function write(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}
