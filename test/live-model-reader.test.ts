import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GjcRuntimeLocations } from "../src/contracts";
import type { PublicSdkSessionAttachment, PublicSdkSessionPort } from "../src/gjc/public-sdk-contract";
import { GjcTurnCancelledError } from "../src/gjc/turn-runner";
import {
	createModelReaderFactory,
	ModelReaderUnavailableError,
	registerTemporaryModelAttachment,
} from "../src/live/model-reader";
import { startSdkFixtureServer } from "./gjc-sdk-v3-fixtures";

describe("createModelReaderFactory", () => {
	test("attaches a fresh public SDK port for each reader and detaches on stop", async () => {
		const ports: FakePublicSessionPort[] = [];
		const factory = createModelReaderFactory({
			cliPath: "/opt/gjc",
			runtimeLocations,
			resolveAttachment: async () => attachment,
			sessionPortFactory: () => {
				const port = new FakePublicSessionPort();
				ports.push(port);
				return port;
			},
		});

		const first = await factory();
		const second = await factory();
		await first.stop();

		expect(first).not.toBe(second);
		expect(ports.map(port => port.calls)).toEqual([["attach", "detach"], ["attach"]]);
		expect(ports[0]?.attachments).toEqual([attachment]);
	});
	test("closes a one-shot catalog session before detaching its port", async () => {
		const port = new FakePublicSessionPort();
		const temporaryAttachment = registerTemporaryModelAttachment({ ...attachment }, async activePort => {
			if (activePort === undefined) throw new Error("attached reader cleanup requires a port");
			await activePort.closeSession();
		});
		const reader = await createModelReaderFactory({
			cliPath: "/opt/gjc",
			runtimeLocations,
			resolveAttachment: async () => temporaryAttachment,
			sessionPortFactory: () => port,
		})();

		await reader.stop();

		expect(port.calls).toEqual(["attach", "closeSession", "detach"]);
	});

	test("quarantines a port when public attachment is rejected before acceptance", async () => {
		const port = new FakePublicSessionPort(true);
		const factory = createModelReaderFactory({
			cliPath: "/opt/gjc",
			runtimeLocations,
			resolveAttachment: async () => attachment,
			sessionPortFactory: () => port,
		});

		await expect(factory()).rejects.toThrow("attachment rejected");
		expect(port.calls).toEqual(["attach", "detach"]);
	});
	test("aborts a pending reader attach and detaches its late completion", async () => {
		const controller = new AbortController();
		let attachStarted!: () => void;
		let releaseAttach!: () => void;
		const started = new Promise<void>(resolve => {
			attachStarted = resolve;
		});
		const attach = new Promise<void>(resolve => {
			releaseAttach = resolve;
		});
		const port = new FakePublicSessionPort();
		port.attach = async value => {
			port.calls.push("attach");
			port.attachments.push(value);
			attachStarted();
			await attach;
			port.attached = true;
		};
		const factory = createModelReaderFactory({
			cliPath: "/opt/gjc",
			runtimeLocations,
			resolveAttachment: async () => attachment,
			sessionPortFactory: () => port,
		});

		const pending = factory(undefined, controller.signal);
		await started;
		controller.abort();
		await expect(pending).rejects.toBeInstanceOf(GjcTurnCancelledError);
		expect(port.calls).toEqual(["attach", "detach"]);
		expect(port.attached).toBe(false);
		releaseAttach();
		await attach;
		await Promise.resolve();
		expect(port.calls).toEqual(["attach", "detach", "detach"]);
		expect(port.attached).toBe(false);
	});
	test("closes a temporary attachment after a cancelled attach completes", async () => {
		const controller = new AbortController();
		let attachStarted!: () => void;
		let releaseAttach!: () => void;
		const started = new Promise<void>(resolve => {
			attachStarted = resolve;
		});
		const attach = new Promise<void>(resolve => {
			releaseAttach = resolve;
		});
		let resolveCleanup!: () => void;
		const cleanupFinished = new Promise<void>(resolve => {
			resolveCleanup = resolve;
		});
		let cleanupReceivedAttachedPort = false;
		const port = new FakePublicSessionPort();
		const temporaryAttachment = registerTemporaryModelAttachment({ ...attachment }, async activePort => {
			cleanupReceivedAttachedPort = activePort === port && port.attached;
			if (activePort !== undefined) await activePort.closeSession();
			resolveCleanup();
		});
		port.attach = async value => {
			port.calls.push("attach");
			port.attachments.push(value);
			attachStarted();
			await attach;
			port.attached = true;
		};
		const pending = createModelReaderFactory({
			cliPath: "/opt/gjc",
			runtimeLocations,
			resolveAttachment: async () => temporaryAttachment,
			sessionPortFactory: () => port,
		})(undefined, controller.signal);

		await started;
		controller.abort();
		await expect(pending).rejects.toBeInstanceOf(GjcTurnCancelledError);
		expect(port.calls).toEqual(["attach"]);

		releaseAttach();
		await cleanupFinished;
		await Promise.resolve();

		expect(cleanupReceivedAttachedPort).toBe(true);
		expect(port.calls).toEqual(["attach", "closeSession", "detach"]);
		expect(port.attached).toBe(false);
	});
	test("closes a temporary attachment after a cancelled attach rejects", async () => {
		const controller = new AbortController();
		let attachStarted!: () => void;
		let rejectAttach!: (reason?: unknown) => void;
		const started = new Promise<void>(resolve => {
			attachStarted = resolve;
		});
		const attach = new Promise<void>((_resolve, reject) => {
			rejectAttach = reject;
		});
		let detachObserved!: () => void;
		const detached = new Promise<void>(resolve => {
			detachObserved = resolve;
		});
		let cleanupCalls = 0;
		let cleanupReceivedPort: PublicSdkSessionPort | undefined;
		let cleanupRanBeforeDetach = false;
		const port = new FakePublicSessionPort();
		const temporaryAttachment = registerTemporaryModelAttachment({ ...attachment }, async activePort => {
			cleanupCalls += 1;
			cleanupReceivedPort = activePort;
			cleanupRanBeforeDetach = !port.calls.includes("detach");
		});
		port.attach = async value => {
			port.calls.push("attach");
			port.attachments.push(value);
			attachStarted();
			await attach;
		};
		port.detach = () => {
			port.calls.push("detach");
			port.attached = false;
			detachObserved();
		};
		const pending = createModelReaderFactory({
			cliPath: "/opt/gjc",
			runtimeLocations,
			resolveAttachment: async () => temporaryAttachment,
			sessionPortFactory: () => port,
		})(undefined, controller.signal);

		await started;
		controller.abort();
		await expect(pending).rejects.toBeInstanceOf(GjcTurnCancelledError);
		expect(port.calls).toEqual(["attach"]);

		rejectAttach(new Error("attachment rejected"));
		await detached;

		expect(cleanupCalls).toBe(1);
		expect(cleanupReceivedPort).toBeUndefined();
		expect(cleanupRanBeforeDetach).toBe(true);
		expect(port.calls).toEqual(["attach", "detach"]);
	});
	test("cleans up a late temporary attachment without an unattached port", async () => {
		const controller = new AbortController();
		let resolveAttachment!: (value: PublicSdkSessionAttachment) => void;
		const attachmentPromise = new Promise<PublicSdkSessionAttachment>(resolve => {
			resolveAttachment = resolve;
		});
		let resolveAttachmentStarted!: () => void;
		const attachmentStarted = new Promise<void>(resolve => {
			resolveAttachmentStarted = resolve;
		});
		let resolveCleanup!: () => void;
		const cleanupFinished = new Promise<void>(resolve => {
			resolveCleanup = resolve;
		});
		let cleanupReceivedPort = false;
		const temporaryAttachment = registerTemporaryModelAttachment({ ...attachment }, async activePort => {
			cleanupReceivedPort = activePort !== undefined;
			if (activePort !== undefined) await activePort.closeSession();
			resolveCleanup();
		});
		const port = new FakePublicSessionPort();
		const pending = createModelReaderFactory({
			cliPath: "/opt/gjc",
			runtimeLocations,
			resolveAttachment: async () => {
				resolveAttachmentStarted();
				return attachmentPromise;
			},
			sessionPortFactory: () => port,
		})(undefined, controller.signal);

		await attachmentStarted;
		controller.abort();
		await expect(pending).rejects.toBeInstanceOf(GjcTurnCancelledError);
		resolveAttachment(temporaryAttachment);
		await cleanupFinished;

		expect(cleanupReceivedPort).toBe(false);
		expect(port.calls).toEqual(["detach"]);
	});
	test("uses the published descriptor as the default attachment authority", async () => {
		const root = mkdtempSync(join(tmpdir(), "gjc-model-reader-"));
		const workspace = join(root, "reader");
		const sessionId = "sdk-session-created";
		const server = startSdkFixtureServer("model_catalog", workspace);
		const descriptor = join(workspace, ".gjc", "state", "sdk", `${sessionId}.json`);
		mkdirSync(join(workspace, ".gjc", "state", "sdk"), { recursive: true });
		writeFileSync(descriptor, JSON.stringify({ sessionId, url: server.url, token: server.token }));
		try {
			const reader = await createModelReaderFactory({
				cliPath: "/opt/gjc",
				runtimeLocations: {
					...runtimeLocations,
					readerWorkspace: workspace,
					readerSessionRoot: join(workspace, ".gjc", "sessions"),
				},
			})();
			expect(await reader.getAvailableModels()).toHaveLength(2);
			await reader.stop();
		} finally {
			server.stop();
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("does not fall back to another transport when no public attachment resolver is configured", async () => {
		const factory = createModelReaderFactory({ cliPath: "/opt/gjc", runtimeLocations });

		await expect(factory()).rejects.toBeInstanceOf(ModelReaderUnavailableError);
	});
});

class FakePublicSessionPort implements PublicSdkSessionPort {
	readonly calls: string[] = [];
	readonly attachments: PublicSdkSessionAttachment[] = [];
	attached = false;

	constructor(private readonly rejectAttachment = false) {}

	async attach(value: PublicSdkSessionAttachment): Promise<void> {
		this.calls.push("attach");
		this.attachments.push(value);
		if (this.rejectAttachment) throw new Error("attachment rejected");
		this.attached = true;
	}

	detach(): void {
		this.calls.push("detach");
		this.attached = false;
	}

	async getState() {
		return { sessionId: attachment.sessionId, model: { provider: "openai", id: "gpt-5" }, thinkingLevel: "off" };
	}

	async getAvailableModels(): Promise<readonly unknown[]> {
		return [];
	}
	async getActiveProviders(): Promise<readonly unknown[]> {
		return [];
	}
	async branchCandidates() {
		return [];
	}

	async setModel() {
		return { provider: "openai", modelId: "gpt-5", thinkingLevel: "off" } as const;
	}

	async setThinking() {
		return { provider: "openai", modelId: "gpt-5", thinkingLevel: "off" } as const;
	}

	async prompt() {
		return { events: [] };
	}

	async answerGate() {
		return { events: [] };
	}

	async branch() {
		return attachment;
	}

	async newSession() {
		return attachment;
	}

	async resumeSession() {
		return attachment;
	}

	async switchSession() {
		return attachment;
	}
	async reply(): Promise<never> {
		return this.unexpected("reply");
	}

	async steer(): Promise<never> {
		return this.unexpected("steer");
	}

	async followUp(): Promise<never> {
		return this.unexpected("followUp");
	}

	async abort(): Promise<never> {
		return this.unexpected("abort");
	}

	async abortAndPrompt(): Promise<never> {
		return this.unexpected("abortAndPrompt");
	}

	async replyToAction(): Promise<never> {
		return this.unexpected("replyToAction");
	}

	async planApprove(): Promise<never> {
		return this.unexpected("planApprove");
	}

	private unexpected(method: string): never {
		this.calls.push(method);
		throw new Error(`unexpected ${method} call`);
	}

	async closeSession(): Promise<void> {
		this.calls.push("closeSession");
	}
}

const attachment: PublicSdkSessionAttachment = {
	sessionId: "reader",
	cwd: "/service-home/.gjc/openwebui/default-reader",
	endpoint: { url: "ws://127.0.0.1:3000", token: "reader-token" },
};

const runtimeLocations: GjcRuntimeLocations = {
	home: "/service-home",
	configDomain: "/service-home/.gjc",
	agentDir: "/service-home/.gjc/agent",
	readerWorkspace: "/service-home/.gjc/openwebui/default-reader",
	readerSessionRoot: "/service-home/.gjc/openwebui/default-reader/.gjc/sessions",
	protectedProjectPaths: [
		"/service-home/.gjc",
		"/service-home/.gjc/agent",
		"/service-home/.gjc/openwebui/default-reader",
		"/service-home/.gjc/openwebui/default-reader/.gjc/sessions",
	],
	childEnvironment: {
		HOME: "/service-home",
		GJC_CONFIG_DIR: ".gjc",
		GJC_CODING_AGENT_DIR: "/service-home/.gjc/agent",
	},
};
