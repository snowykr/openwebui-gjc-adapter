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
			await fixture.transport.stop();

			expect(state).toEqual({
				sessionId: "sdk-session-resumed",
				model: { provider: "future", id: "capable" },
				thinkingLevel: "high",
			});
			expect(readCliOperations(fixture.cliTranscript)).toEqual(["session.list", "session.resume"]);
		} finally {
			await fixture.dispose();
		}
	});

	test("Given a persistent created session When the adapter transport stops Then it detaches without closing GJC", async () => {
		const fixture = createSdkTransportFixture("turn_complete");
		try {
			await fixture.transport.start();
			await fixture.transport.newSession();

			await fixture.transport.stop();

			expect(readCliOperations(fixture.cliTranscript)).toEqual(["session.create"]);
		} finally {
			await fixture.dispose();
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
			await fixture.dispose();
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
			await fixture.dispose();
		}
	});

	test("Given session.create succeeds When the SDK hello fails Then startup still closes the ephemeral session", async () => {
		const fixture = createSdkTransportFixture("hello_failure");
		const factory = createModelReaderFactory({
			cliPath: "/unused/by-injected-transport",
			runtimeLocations: fixture.runtimeLocations,
			transportFactory: () => fixture.transport,
		});
		try {
			await expect(factory()).rejects.toThrow("expected protocolVersion 3");

			expect(readCliOperations(fixture.cliTranscript)).toEqual(["session.create", "session.close"]);
		} finally {
			await fixture.dispose();
		}
	});

	test("Given session.close fails When an ephemeral reader stops Then the cleanup failure is observable", async () => {
		const fixture = createSdkTransportFixture("turn_complete", { closeFailure: true });
		const factory = createModelReaderFactory({
			cliPath: "/unused/by-injected-transport",
			runtimeLocations: fixture.runtimeLocations,
			transportFactory: () => fixture.transport,
		});
		try {
			const reader = await factory();

			await expect(reader.stop()).rejects.toThrow("fixture session.close failed");
		} finally {
			await fixture.dispose();
		}
	});

	test("Given SDK hello and session.close both fail When reader startup cleans up Then both causes are preserved", async () => {
		const fixture = createSdkTransportFixture("hello_failure", { closeFailure: true });
		const factory = createModelReaderFactory({
			cliPath: "/unused/by-injected-transport",
			runtimeLocations: fixture.runtimeLocations,
			transportFactory: () => fixture.transport,
		});
		try {
			const failure: unknown = await factory().then(
				() => undefined,
				error => error,
			);
			if (!(failure instanceof AggregateError)) {
				throw new TypeError("reader startup must preserve startup and cleanup failures in AggregateError");
			}

			expect(
				failure.errors.map((error: unknown) => (error instanceof Error ? error.message : String(error))),
			).toEqual(["GJC SDK v3 hello: expected protocolVersion 3 after open", "fixture session.close failed"]);
			expect(readCliOperations(fixture.cliTranscript)).toEqual(["session.create", "session.close"]);
		} finally {
			await fixture.dispose();
		}
	});
});
