import { describe, expect, test } from "bun:test";
import {
	advanceBootstrapState,
	INITIAL_BOOTSTRAP_STATE,
	parseBootstrapState,
	resetBootstrapState,
	withExclusiveMaintenance,
} from "../src/configure/bootstrap-state";
import { runPhaseAwareDeployment } from "../src/configure/orchestrator";
import { routeControllerUnitName } from "../src/configure/systemd";

describe("bootstrap reset and maintenance", () => {
	test("reruns the reset phase inclusively", async () => {
		let state = advanceBootstrapState(INITIAL_BOOTSTRAP_STATE, "route", { routeVerified: false });
		const calls: string[] = [];
		const store = {
			read: async () => state,
			write: async (next: typeof state) => {
				state = next;
			},
		};
		await runPhaseAwareDeployment({
			state: store,
			phases: {
				preflight: async () => {
					calls.push("preflight");
				},
				bootstrap: async () => {
					calls.push("bootstrap");
				},
				apiKey: async () => {
					calls.push("api-key");
				},
				readiness: async () => {
					calls.push("route");
				},
				provider: async () => {
					calls.push("ownership");
				},
			},
			reset: { failedPhase: "route", evidence: "verified route failure" },
		});
		expect(calls).toContain("route");
	});
	test("checkpoints bootstrap completion before API-key state reads", async () => {
		let state = INITIAL_BOOTSTRAP_STATE;
		const store = {
			read: async () => parseBootstrapState(state),
			write: async (next: typeof state) => {
				state = parseBootstrapState(next);
			},
		};
		let apiKeyRead: typeof state | undefined;
		await runPhaseAwareDeployment({
			state: store,
			phases: {
				preflight: async () => {},
				bootstrap: async () => {},
				apiKey: async () => {
					apiKeyRead = await store.read();
					return { apiKeyCreated: true, ownerUserId: "owner", openWebUIApiToken: "token" };
				},
				readiness: async () => {},
				provider: async () => {},
			},
		});
		expect(apiKeyRead).toMatchObject({ phase: "api-key", bootstrapComplete: true });
	});
	test("restores the controller before dependencies after a later reset", async () => {
		let state = advanceBootstrapState(INITIAL_BOOTSTRAP_STATE, "route", {
			bootstrapComplete: true,
			apiKeyCreated: true,
			routeVerified: false,
		});
		const calls: string[] = [];
		const store = {
			read: async () => state,
			write: async (next: typeof state) => {
				state = next;
			},
		};
		await runPhaseAwareDeployment({
			state: store,
			reset: { failedPhase: "route", evidence: "controller recovery required" },
			phases: {
				preflight: async () => {
					calls.push("preflight");
				},
				bootstrap: async () => {
					calls.push("bootstrap");
				},
				apiKey: async () => {
					calls.push("api-key");
				},
				readiness: async () => {
					calls.push("route");
				},
				provider: async () => {
					calls.push("provider");
				},
			},
		});
		expect(calls.indexOf("bootstrap")).toBeLessThan(calls.indexOf("route"));
		expect(calls).toContain("provider");
	});

	test("reruns completed routes through validation and controller phases", async () => {
		let state = advanceBootstrapState(INITIAL_BOOTSTRAP_STATE, "complete", {
			bootstrapComplete: true,
			apiKeyCreated: true,
			openAIConfigured: true,
			routeVerified: true,
			ownershipVerified: true,
		});
		const calls: string[] = [];
		const store = {
			read: async () => state,
			write: async (next: typeof state) => {
				state = next;
			},
		};
		await runPhaseAwareDeployment({
			state: store,
			phases: {
				preflight: async () => {
					calls.push("preflight");
				},
				bootstrap: async () => {
					calls.push("bootstrap");
				},
				apiKey: async () => {
					calls.push("api-key");
					return { ownerUserId: "owner", openWebUIApiToken: "token" };
				},
				readiness: async () => {
					calls.push("route");
				},
				provider: async () => {
					calls.push("ownership");
				},
			},
		});
		expect(calls).toEqual(["preflight", "bootstrap", "api-key", "route", "ownership"]);
		expect(state.ownerUserId).toBe("owner");
		expect(state.openWebUIApiToken).toBe("token");
	});

	test("records a failed phase before invoking it for recovery", async () => {
		let state = advanceBootstrapState(INITIAL_BOOTSTRAP_STATE, "bootstrap", { bootstrapComplete: true });
		const store = {
			read: async () => state,
			write: async (next: typeof state) => {
				state = next;
			},
		};
		await expect(
			runPhaseAwareDeployment({
				state: store,
				phases: {
					preflight: async () => {},
					bootstrap: async () => {
						throw new Error("controller failed");
					},
					apiKey: async () => {},
					readiness: async () => {},
					provider: async () => {},
				},
			}),
		).rejects.toThrow("controller failed");
		expect(state.phase).toBe("bootstrap");
		expect(state.bootstrapComplete).toBe(true);
	});

	test("preserves nested API-key recovery checkpoint across failure and retry", async () => {
		let state = INITIAL_BOOTSTRAP_STATE;
		const store = {
			read: async () => state,
			write: async (next: typeof state) => {
				state = next;
			},
		};
		let signupAttempts = 0;
		let firstAttempt = true;
		const phases = {
			preflight: async () => undefined,
			bootstrap: async () => undefined,
			apiKey: async () => {
				if (state.openWebUIApiToken === undefined) {
					signupAttempts += 1;
					await store.write(advanceBootstrapState(state, "api-key", { openWebUIApiToken: "session-token" }));
				}
				if (firstAttempt) {
					firstAttempt = false;
					throw new Error("API-key request failed (request req-1)");
				}
				return { ownerUserId: "owner", openWebUIApiToken: state.openWebUIApiToken };
			},
			readiness: async () => undefined,
			provider: async () => undefined,
		};
		await expect(runPhaseAwareDeployment({ state: store, phases })).rejects.toThrow("API-key request failed");
		expect(state).toMatchObject({
			phase: "api-key",
			openWebUIApiToken: "session-token",
			failedPhase: "api-key",
			failureEvidence: "API-key request failed (request req-1)",
		});
		await runPhaseAwareDeployment({ state: store, phases });
		expect(signupAttempts).toBe(1);
		expect(state.openWebUIApiToken).toBe("session-token");
		expect(state.failedPhase).toBeUndefined();
	});
	test("selects the previously installed route controller", () => {
		expect(routeControllerUnitName("managed")).toBe("openwebui-gjc-adapter.service");
		expect(routeControllerUnitName("existing")).toBe("openwebui-gjc-adapter-existing.service");
	});
	test("resets only state at and after the failed phase", () => {
		const state = advanceBootstrapState(INITIAL_BOOTSTRAP_STATE, "ownership", {
			bootstrapComplete: true,
			apiKeyCreated: true,
			openAIConfigured: true,
			routeVerified: true,
			ownershipVerified: true,
			openAIConnectionIds: ["gjc-adapter"],
		});
		expect(
			resetBootstrapState(state, "route", { failedPhase: "route", evidence: "route verification failed" }),
		).toEqual({
			version: 1,
			failedPhase: "route",
			failureEvidence: "route verification failed",
			phase: "route",
			bootstrapComplete: true,
			apiKeyCreated: true,
			openAIConfigured: true,
			routeVerified: false,
			ownershipVerified: false,
			openAIConnectionIds: ["gjc-adapter"],
		});
		expect(
			resetBootstrapState(state, "openai", { failedPhase: "openai", evidence: "OpenAI configuration failed" })
				.openAIConnectionIds,
		).toEqual([]);
		expect(
			resetBootstrapState(state, "bootstrap", { failedPhase: "bootstrap", evidence: "bootstrap failed" }),
		).toMatchObject({
			phase: "bootstrap",
			bootstrapComplete: false,
			apiKeyCreated: false,
			openAIConfigured: false,
		});
	});

	test("keeps bootstrap complete when retrying an API-key failure without a session token", () => {
		const state = advanceBootstrapState(INITIAL_BOOTSTRAP_STATE, "api-key", {
			bootstrapComplete: true,
		});
		const reset = resetBootstrapState(state, "api-key", {
			failedPhase: "api-key",
			evidence: "API-key creation failed before sign-in completed",
		});
		expect(reset).toMatchObject({
			phase: "api-key",
			bootstrapComplete: true,
			apiKeyCreated: false,
		});
		expect(parseBootstrapState(reset)).toEqual(reset);
	});

	test("always ends exclusive maintenance, including a failed action", async () => {
		const events: string[] = [];
		const boundary = {
			begin: async () => {
				events.push("begin");
			},
			end: async () => {
				events.push("end");
			},
		};
		await expect(
			withExclusiveMaintenance(boundary, async () => {
				events.push("action");
				throw new Error("setup failed");
			}),
		).rejects.toThrow("setup failed");
		expect(events).toEqual(["begin", "action", "end"]);
	});
});
