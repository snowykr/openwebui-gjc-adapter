import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as cli from "./cli-fixtures";
import { RealSelectionCoordinator } from "./real-selection-coordinator";
import { eventModels, parseObservations, parseOutbox } from "./real-selection-effect-schemas";
import {
	parseCompletion,
	parseError,
	parseMappingDocument,
	parseModelList,
	parseSseModels,
	parseTranscriptEntry,
} from "./real-selection-schemas";

export class RealSelectionHarness {
	readonly coordinator: RealSelectionCoordinator;
	readonly token = "selection-harness-token";
	readonly root: string;
	readonly baseUrl: string;
	readonly transcriptPath: string;
	readonly observationPath: string;
	readonly #port: number;
	#process: Bun.Subprocess;

	private constructor(root: string, port: number, process: Bun.Subprocess, coordinator: RealSelectionCoordinator) {
		this.root = root;
		this.baseUrl = `http://127.0.0.1:${port}`;
		this.transcriptPath = path.join(root, "selection-transcript.jsonl");
		this.observationPath = path.join(root, "selection-observations.jsonl");
		this.#port = port;
		this.#process = process;
		this.coordinator = coordinator;
	}

	static async start(options: cli.RealSelectionStartOptions = {}): Promise<RealSelectionHarness> {
		const root = await mkdtemp(path.join(os.tmpdir(), "gjc-real-selection-"));
		let coordinator: RealSelectionCoordinator | undefined;
		let child: Bun.Subprocess | undefined;
		let port: number | undefined;
		try {
			port = await cli.reserveTcpPort();
			coordinator = new RealSelectionCoordinator();
			child = spawnServer(root, port, coordinator.url, options);
			const harness = new RealSelectionHarness(root, port, child, coordinator);
			await cli.waitForStartedServer(child, `${harness.baseUrl}/healthz`);
			return harness;
		} catch (error) {
			let cleanupFailure: unknown;
			const cleanups = [
				async () => child === undefined || cli.stopProcess(child),
				async () => coordinator?.stop(),
				async () => port === undefined || assertPortRebind(port),
				async () => rm(root, { recursive: true, force: true }),
			];
			for (const cleanup of cleanups) {
				try {
					await cleanup();
				} catch (cleanupError) {
					cleanupFailure ??= cleanupError;
				}
			}
			if (cleanupFailure !== undefined) throw cleanupFailure;
			if (child !== undefined && port !== undefined) {
				options.onFailedCleanup?.({
					deadlineMs: cli.SERVER_START_DEADLINE_MS,
					pid: child.pid,
					port,
					processExited: child.exitCode !== null,
					root,
				});
			}
			throw error;
		}
	}

	async models() {
		const response = await fetch(`${this.baseUrl}/v1/models`, { headers: this.authHeaders() });
		return { status: response.status, body: parseModelList(await response.json()) };
	}

	async modelsError() {
		const response = await fetch(`${this.baseUrl}/v1/models`, { headers: this.authHeaders() });
		return { status: response.status, error: parseError(await response.json()) };
	}

	async chat(
		model: string,
		options: {
			readonly stream?: boolean;
			readonly task?: string;
			readonly id: string;
			readonly content?: string;
			readonly chatId?: string;
			readonly userMessageId?: string;
			readonly parentId?: string;
		},
	) {
		const headers = this.authHeaders();
		headers.set("content-type", "application/json");
		headers.set("X-OpenWebUI-User-Id", "owner-selection");
		if (options.task === undefined) {
			headers.set("X-OpenWebUI-Chat-Id", `chat-${options.chatId ?? options.id}`);
			headers.set("X-OpenWebUI-Message-Id", `assistant-${options.id}`);
			headers.set("X-OpenWebUI-User-Message-Id", options.userMessageId ?? `user-${options.id}`);
			headers.set("X-OpenWebUI-User-Message-Parent-Id", options.parentId ?? "");
		} else headers.set("X-OpenWebUI-Task", options.task);
		const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				model,
				stream: options.stream ?? false,
				messages: [{ role: "user", content: options.content ?? "PASS" }],
			}),
		});
		if (!response.ok) {
			return {
				status: response.status,
				contentType: response.headers.get("content-type"),
				error: parseError(await response.json()),
			};
		}
		if (options.stream) return { status: response.status, sseModels: parseSseModels(await response.text()) };
		return { status: response.status, body: parseCompletion(await response.json()) };
	}

	async mappingBytes(): Promise<string> {
		return readFile(path.join(this.root, "sessions", "openwebui-session-mappings.json"), "utf8");
	}

	async mappingEntries(): Promise<readonly Record<string, unknown>[]> {
		const bytes = await this.mappingBytes();
		return parseMappingDocument(JSON.parse(bytes)).mappings;
	}

	async effects() {
		const observations = parseObservations(await readOptional(this.observationPath));
		return {
			coordinator: this.coordinator.snapshot(),
			projectLookups: observations.filter(entry => entry.type === "project_lookup").length,
			events: observations.filter(entry => entry.type === "event"),
			eventModels: eventModels(observations),
			messages: observations.filter(entry => entry.type === "message"),
			outbox: parseOutbox(
				await readOptional(path.join(this.root, "state", "openwebui-projection-outbox.json"), '{"operations":[]}'),
			),
			mapping: await readOptional(path.join(this.root, "sessions", "openwebui-session-mappings.json")),
		};
	}

	async eventModels(chatId: string): Promise<readonly string[]> {
		return eventModels(parseObservations(await readOptional(this.observationPath)), chatId);
	}

	async removeModelBinding(chatId: string): Promise<void> {
		const file = path.join(this.root, "sessions", "openwebui-session-mappings.json");
		const document = parseMappingDocument(JSON.parse(await readFile(file, "utf8")), chatId);
		await writeFile(file, JSON.stringify(document, null, 2), "utf8");
	}

	async restartAfterRemovingModelBinding(chatId: string): Promise<void> {
		await cli.stopProcess(this.#process);
		await this.removeModelBinding(chatId);
		this.#process = spawnServer(this.root, this.#port, this.coordinator.url, {});
		await cli.waitForStartedServer(this.#process, `${this.baseUrl}/healthz`);
	}

	async transcriptEntries(): Promise<readonly ReturnType<typeof parseTranscriptEntry>[]> {
		const bytes = await readFile(this.transcriptPath, "utf8");
		return bytes
			.split("\n")
			.filter(line => line.length > 0)
			.map(line => parseTranscriptEntry(JSON.parse(line)));
	}

	async stop(): Promise<void> {
		let failure: unknown;
		try {
			await cli.stopProcess(this.#process);
		} catch (error) {
			failure = error;
		}
		try {
			await this.coordinator.stop();
		} catch (error) {
			failure ??= error;
		}
		try {
			await assertPortRebind(this.#port);
		} catch (error) {
			failure ??= error;
		}
		try {
			await rm(this.root, { recursive: true, force: true });
		} catch (error) {
			failure ??= error;
		}
		if (failure !== undefined) throw failure;
	}

	private authHeaders(): Headers {
		return new Headers({ authorization: `Bearer ${this.token}` });
	}
}

function selectionFixturePath(): string {
	return path.join(process.cwd(), "test/fixtures/gjc-rpc-selection-scenario.ts");
}

function serverFixturePath(): string {
	return path.join(process.cwd(), "test/fixtures/selection-adapter-server.ts");
}

function spawnServer(
	root: string,
	port: number,
	coordinatorUrl: string,
	options: cli.RealSelectionStartOptions,
): Bun.Subprocess {
	return Bun.spawn([process.execPath, serverFixturePath()], {
		cwd: process.cwd(),
		env: {
			HOME: root,
			PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
			TMPDIR: root,
			GJC_CONFIG_DIR: "hostile-ignored",
			PI_CONFIG_DIR: "hostile-ignored",
			GJC_CODING_AGENT_DIR: path.join(root, "hostile-ignored"),
			XDG_STATE_HOME: path.join(root, "xdg-state"),
			XDG_DATA_HOME: path.join(root, "xdg-data"),
			XDG_CACHE_HOME: path.join(root, "xdg-cache"),
			GJC_OPENWEBUI_BIND_HOST: "127.0.0.1",
			GJC_OPENWEBUI_BIND_PORT: String(port),
			GJC_OPENWEBUI_ADAPTER_API_TOKEN: "selection-harness-token",
			GJC_OPENWEBUI_OWNER_USER_ID: "owner-selection",
			GJC_OPENWEBUI_TURN_TIMEOUT_MS: "750",
			GJC_OPENWEBUI_STATE_PATH: path.join(root, "state"),
			GJC_OPENWEBUI_SESSION_ROOT: path.join(root, "sessions"),
			GJC_OPENWEBUI_GJC_COMMAND: selectionFixturePath(),
			GJC_SELECTION_COORDINATOR_URL: coordinatorUrl,
			GJC_SELECTION_TRANSCRIPT: path.join(root, "selection-transcript.jsonl"),
			GJC_SELECTION_OBSERVATIONS: path.join(root, "selection-observations.jsonl"),
			GJC_SELECTION_RUNTIME_RECEIPT: path.join(root, "selection-runtime-receipt.json"),
			...(options.failStartup ? { GJC_SELECTION_FAIL_STARTUP: "1" } : {}),
			...(options.invalidRunnerModel === undefined
				? {}
				: { GJC_SELECTION_INVALID_RUNNER_MODEL: options.invalidRunnerModel }),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
}

async function assertPortRebind(port: number): Promise<void> {
	const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("rebound") });
	await server.stop();
}

async function readOptional(file: string, fallback = ""): Promise<string> {
	try {
		return await readFile(file, "utf8");
	} catch (error) {
		if (isMissingFile(error)) return fallback;
		throw error;
	}
}

function isMissingFile(error: unknown): boolean {
	return typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT";
}
