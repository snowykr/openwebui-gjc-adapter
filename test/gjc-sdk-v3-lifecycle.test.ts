import { describe, expect, test } from "bun:test";
import { createModelReaderFactory } from "../src/live/model-reader";
import { createSdkTransportFixture, readCliOperations } from "./gjc-sdk-v3-fixtures";

describe("latest dev SDK v3 lifecycle contract", () => {
	test("Given a saved identity When a persistent session resumes Then broker resolution survives detach", async () => {
		const fixture = createSdkTransportFixture("resumed_session");
		try {
			await fixture.transport.start();

			await fixture.transport.switchSession(fixture.savedSessionPath, "sdk-session-resumed");
			const state = await fixture.transport.getState();
			fixture.transport.stop();

			expect(state).toEqual({
				sessionId: "sdk-session-resumed",
				model: { provider: "future", id: "capable" },
				thinkingLevel: "high",
			});
			expect(readCliOperations(fixture.cliTranscript)).toEqual(["session.list", "session.resume"]);
		} finally {
			fixture.dispose();
		}
	});

	test("Given a persistent created session When the adapter transport stops Then it detaches without closing GJC", async () => {
		const fixture = createSdkTransportFixture("turn_complete");
		try {
			await fixture.transport.start();
			await fixture.transport.newSession();

			fixture.transport.stop();

			expect(readCliOperations(fixture.cliTranscript)).toEqual(["session.create"]);
		} finally {
			fixture.dispose();
		}
	});

	test("Given action_needed without a durable gate When the correlated turn later ends Then prompting completes", async () => {
		const fixture = createSdkTransportFixture("action_without_gate");
		try {
			await fixture.transport.start();
			await fixture.transport.newSession();

			const events = await fixture.transport.promptAndWait("continue after transient action", 500);

			expect(events.at(-1)).toMatchObject({
				type: "agent_end",
				commandId: "command-right",
				turnId: "turn-right",
			});
		} finally {
			fixture.dispose();
		}
	});

	test("Given the model reader's ephemeral SDK session When reading finishes Then it closes that session", async () => {
		const fixture = createSdkTransportFixture("turn_complete");
		const factory = createModelReaderFactory({
			cliPath: "/unused/by-injected-transport",
			runtimeLocations: fixture.runtimeLocations,
			transportFactory: () => fixture.transport,
		});
		try {
			const reader = await factory();

			await reader.getAvailableModels();
			await reader.stop();

			expect(readCliOperations(fixture.cliTranscript)).toEqual(["session.create", "session.close"]);
		} finally {
			fixture.dispose();
		}
	});
});
