import { describe, expect, test } from "bun:test";
import type { GjcRuntimeLocations } from "../src/contracts";
import type { GjcRpcRunnerClientOptions, GjcRpcSelectionTransport } from "../src/gjc/rpc-runner";
import { createModelReaderFactory } from "../src/live/model-reader";

describe("createModelReaderFactory", () => {
	test("starts a fresh transport per operation with resolved neutral locations", async () => {
		const options: GjcRpcRunnerClientOptions[] = [];
		const transports: FakeSelectionTransport[] = [];
		const factory = createModelReaderFactory({
			cliPath: "/opt/gjc",
			runtimeLocations,
			transportFactory(input) {
				options.push(input);
				const transport = new FakeSelectionTransport();
				transports.push(transport);
				return transport;
			},
		});

		expect(await factory()).not.toBe(await factory());
		expect(transports.map(transport => transport.calls)).toEqual([["start"], ["start"]]);
		expect(options).toEqual([
			{
				cwd: runtimeLocations.readerWorkspace,
				sessionRoot: runtimeLocations.readerSessionRoot,
				cliPath: "/opt/gjc",
				runtimeLocations,
			},
			{
				cwd: runtimeLocations.readerWorkspace,
				sessionRoot: runtimeLocations.readerSessionRoot,
				cliPath: "/opt/gjc",
				runtimeLocations,
			},
		]);
	});

	test("stops a transport whose start fails", async () => {
		const transport = new FakeSelectionTransport(true);
		const factory = createModelReaderFactory({
			cliPath: "/opt/gjc",
			runtimeLocations,
			transportFactory: () => transport,
		});
		await expect(factory()).rejects.toThrow("start failed");
		expect(transport.calls).toEqual(["start", "stop"]);
	});
});

class FakeSelectionTransport implements GjcRpcSelectionTransport {
	readonly calls: string[] = [];
	constructor(private readonly failStart = false) {}
	async start(): Promise<void> {
		this.calls.push("start");
		if (this.failStart) throw new Error("start failed");
	}
	stop(): void {
		this.calls.push("stop");
	}
	async getAvailableModels(): Promise<readonly unknown[]> {
		return [];
	}
	async getState() {
		return { sessionId: "reader" };
	}
	async setDefaultModelSelection() {
		return { provider: "openai", modelId: "gpt-5", thinkingLevel: "off" } as const;
	}
	async newSession() {
		return { cancelled: false };
	}
	async switchSession() {
		return { cancelled: false };
	}
	async promptAndWait() {
		return [];
	}
	async getLastAssistantText() {
		return null;
	}
}

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
