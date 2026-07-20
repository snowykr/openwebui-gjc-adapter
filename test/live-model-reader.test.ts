import { describe, expect, test } from "bun:test";
import type { GjcRuntimeLocations } from "../src/contracts";
import type { PublicSdkSessionAttachment, PublicSdkSessionPort } from "../src/gjc/public-sdk-contract";
import { ModelReaderUnavailableError, createModelReaderFactory, registerTemporaryModelAttachment } from "../src/live/model-reader";

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

	test("does not fall back to another transport when no public attachment resolver is configured", async () => {
		const factory = createModelReaderFactory({ cliPath: "/opt/gjc", runtimeLocations });

		await expect(factory()).rejects.toBeInstanceOf(ModelReaderUnavailableError);
	});
});

class FakePublicSessionPort implements PublicSdkSessionPort {
	readonly calls: string[] = [];
	readonly attachments: PublicSdkSessionAttachment[] = [];

	constructor(private readonly rejectAttachment = false) {}

	async attach(value: PublicSdkSessionAttachment): Promise<void> {
		this.calls.push("attach");
		this.attachments.push(value);
		if (this.rejectAttachment) throw new Error("attachment rejected");
	}

	detach(): void {
		this.calls.push("detach");
	}

	async getState() {
		return { sessionId: attachment.sessionId, model: { provider: "openai", id: "gpt-5" }, thinkingLevel: "off" };
	}

	async getAvailableModels(): Promise<readonly unknown[]> {
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
