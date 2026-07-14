import type { NormalizedModelSelection } from "../src/contracts";
import { formatCanonicalModelId } from "../src/live/models";
import { LOW_SELECTION, MEDIUM_SELECTION, MODEL_DESCRIPTORS } from "./model-selection-fixtures";
import { type RealSelectionSdkServer, startRealSelectionSdkServer } from "./real-selection-sdk-coordinator";

export type SelectionCoordinatorSnapshot = {
	readonly selection: NormalizedModelSelection;
	readonly setterAttempts: number;
	readonly setters: readonly NormalizedModelSelection[];
	readonly promptCount: number;
	readonly gateResponses: number;
	readonly catalogReads: number;
	readonly stateReads: number;
	readonly transcript: readonly string[];
};

export class RealSelectionCoordinator {
	readonly url: string;
	readonly sdkUrl: string;
	readonly sdkToken: string;
	readonly #server: ReturnType<typeof Bun.serve>;
	readonly #sdkServer: RealSelectionSdkServer;
	readonly #catalogMode: "capabilities" | "current-inherit";
	#selection: NormalizedModelSelection = LOW_SELECTION;
	#normalizeNext = false;
	#failNextSetter = false;
	#failNextPrompt = false;
	#failNextState = false;
	#malformedCatalogOnce = false;
	#unusableStateOnce = false;
	#gateNextPrompt = false;
	#assistantText = "selection fixture assistant";
	#promptCount = 0;
	#setterAttempts = 0;
	#gateResponses = 0;
	#catalogReads = 0;
	#stateReads = 0;
	#sequence = 0;
	readonly #setters: NormalizedModelSelection[] = [];
	readonly #transcript: string[] = [];
	#barrierTarget = 0;
	#barrierRelease: (() => void) | undefined;
	#barrierPromise: Promise<void> | undefined;

	constructor(
		options: { readonly catalogMode: "capabilities" | "current-inherit" } = { catalogMode: "capabilities" },
	) {
		this.#catalogMode = options.catalogMode;
		this.#server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => this.#fetch(request) });
		this.url = this.#server.url.toString().replace(/\/$/, "");
		this.#sdkServer = startRealSelectionSdkServer(this.url);
		this.sdkUrl = this.#sdkServer.url;
		this.sdkToken = this.#sdkServer.token;
	}

	normalizeNextToMedium(): void {
		this.#normalizeNext = true;
	}

	failNextSetter(): void {
		this.#failNextSetter = true;
	}

	failNextPrompt(): void {
		this.#failNextPrompt = true;
	}

	failNextState(): void {
		this.#failNextState = true;
	}

	malformNextCatalog(): void {
		this.#malformedCatalogOnce = true;
	}

	useUnusableStateOnce(): void {
		this.#unusableStateOnce = true;
	}

	emitGateOnNextPrompt(): void {
		this.#gateNextPrompt = true;
	}

	setAssistantText(text: string): void {
		this.#assistantText = text;
	}

	holdNextSetters(count: number): void {
		this.#barrierTarget = this.#setterAttempts + count;
		this.#barrierPromise = new Promise(resolve => {
			this.#barrierRelease = resolve;
		});
	}

	async waitForHeldSetters(): Promise<void> {
		const target = this.#barrierTarget;
		for (let attempt = 0; attempt < 1_000; attempt += 1) {
			if (this.#setterAttempts >= target) return;
			await Bun.sleep(5);
		}
		throw new Error("setter entry barrier timed out");
	}

	releaseSetters(): void {
		this.#barrierRelease?.();
		this.#barrierRelease = undefined;
		this.#barrierPromise = undefined;
		this.#barrierTarget = 0;
	}

	snapshot(): SelectionCoordinatorSnapshot {
		return {
			selection: this.#selection,
			setterAttempts: this.#setterAttempts,
			setters: [...this.#setters],
			promptCount: this.#promptCount,
			gateResponses: this.#gateResponses,
			catalogReads: this.#catalogReads,
			stateReads: this.#stateReads,
			transcript: [...this.#transcript],
		};
	}

	async stop(): Promise<void> {
		await Promise.all([this.#server.stop(), this.#sdkServer.stop()]);
	}

	async #fetch(request: Request): Promise<Response> {
		const pathname = new URL(request.url).pathname;
		if (request.method === "GET" && pathname === "/catalog") {
			this.#catalogReads += 1;
			if (this.#malformedCatalogOnce) {
				this.#malformedCatalogOnce = false;
				return Response.json({ models: [{ provider: "broken" }] });
			}
			return Response.json({ models: this.#catalog() });
		}
		if (request.method === "GET" && pathname === "/state") {
			this.#stateReads += 1;
			if (this.#failNextState) {
				this.#failNextState = false;
				return Response.json({ error: "private state failure" }, { status: 503 });
			}
			if (this.#unusableStateOnce) {
				this.#unusableStateOnce = false;
				return Response.json({ provider: "missing", modelId: "missing", thinkingLevel: "off" });
			}
			return Response.json(this.#selection);
		}
		if (request.method === "GET" && pathname === "/assistant") {
			return Response.json({ text: this.#assistantText });
		}
		if (request.method === "POST" && pathname === "/prompt") {
			this.#promptCount += 1;
			this.#transcript.push("prompt");
			if (this.#failNextPrompt) {
				this.#failNextPrompt = false;
				return Response.json({ ok: false, message: "/private/path\nTOKEN=secret\u0000" }, { status: 503 });
			}
			const gate = this.#gateNextPrompt;
			this.#gateNextPrompt = false;
			return Response.json({ ok: true, gate });
		}
		if (request.method === "POST" && pathname === "/gate") {
			this.#gateResponses += 1;
			this.#transcript.push("gate_response");
			return Response.json({ ok: true });
		}
		if (request.method === "POST" && pathname === "/sequence") {
			this.#sequence += 1;
			return Response.json({ ok: true, seq: this.#sequence });
		}
		if (request.method === "POST" && pathname === "/setter") {
			this.#setterAttempts += 1;
			this.#transcript.push("setter_enter");
			const barrier = this.#barrierPromise;
			if (barrier !== undefined && this.#setterAttempts <= this.#barrierTarget) await barrier;
			if (this.#failNextSetter) {
				this.#failNextSetter = false;
				this.#transcript.push("setter_failure");
				return Response.json({ ok: false }, { status: 409 });
			}
			const requested = await readSelectionOrError(request);
			if (requested instanceof Response) return requested;
			const committed = this.#normalizeNext ? MEDIUM_SELECTION : requested;
			this.#normalizeNext = false;
			this.#selection = committed;
			this.#setters.push(committed);
			this.#transcript.push(`setter_success:${committed.provider}/${committed.modelId}:${committed.thinkingLevel}`);
			return Response.json({ ok: true, selection: committed });
		}
		return new Response("not found", { status: 404 });
	}

	#catalog(): readonly unknown[] {
		if (this.#catalogMode === "capabilities") return MODEL_DESCRIPTORS;
		return MODEL_DESCRIPTORS.map(model => {
			if (!isRecord(model)) throw new TypeError("invalid fixture model");
			const current = model.provider === LOW_SELECTION.provider && model.id === LOW_SELECTION.modelId;
			return {
				...model,
				current,
				...(current ? { currentThinkingLevel: "inherit" } : {}),
			};
		});
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readSelection(request: Request): Promise<NormalizedModelSelection> {
	const value: unknown = await request.json();
	if (typeof value !== "object" || value === null) throw new TypeError("invalid selection");
	const provider = Reflect.get(value, "provider");
	const modelId = Reflect.get(value, "modelId");
	const thinkingLevel = Reflect.get(value, "thinkingLevel");
	if (typeof provider !== "string" || typeof modelId !== "string" || !isFixtureThinkingLevel(thinkingLevel)) {
		throw new TypeError("invalid selection");
	}
	const selection: NormalizedModelSelection = { provider, modelId, thinkingLevel };
	formatCanonicalModelId(selection);
	return selection;
}

async function readSelectionOrError(request: Request): Promise<NormalizedModelSelection | Response> {
	try {
		return await readSelection(request);
	} catch (error) {
		if (error instanceof TypeError) return Response.json({ ok: false }, { status: 400 });
		throw error;
	}
}

function isFixtureThinkingLevel(value: unknown): value is "off" | "low" | "medium" {
	return value === "off" || value === "low" || value === "medium";
}
