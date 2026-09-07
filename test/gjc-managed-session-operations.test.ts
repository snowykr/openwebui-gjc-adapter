import { describe, expect, spyOn, test } from "bun:test";
import type { ManagedSdkAttachment, ManagedSdkRuntime, TenantSessionKey } from "../src/gjc/managed-sdk-runtime";
import type { ManagedEndpointReceipt, ManagedTurnAuthority } from "../src/gjc/turn-runner";
import type { LiveGatewayRunnerInput } from "../src/live/chat-completions";
import { createManagedSessionOperations, ManagedTurnUncertainError } from "../src/live/gjc-managed-session-operations";
import { createManagedGjcTurnRunner } from "../src/live/gjc-managed-turn-runner";
import { controlOperationHash, lifecycleControlRequestKey } from "../src/live/gjc-routing-publication";

const authority: ManagedTurnAuthority = {
	principalId: "principal-1",
	projectId: "project-1",
	canonicalWorkspace: "/workspace/project-1",
	chatId: "chat-1",
	sessionId: "session-1",
	generation: 7,
	leaseId: "lease-1",
	epoch: "epoch-1",
	requestKey: "request-1",
};

describe("managed session operations", () => {
	test.each(["acquire", "query", "request", "prompt"] as const)(
		"late %s reconciliation cannot acquire or dispatch under a renewed budget",
		async operation => {
			const fake = new FakeRuntime();
			const entered = deferred<void>();
			const release = deferred<void>();
			fake.reconcile = async timeoutMs => {
				fake.reconcileTimeouts.push(timeoutMs);
				entered.resolve();
				await release.promise;
			};
			const operations = createManagedSessionOperations(fake.runtime, 50);
			const pending = (
				operation === "acquire"
					? operations.acquire(authority)
					: operation === "query"
						? operations.getModels(authority)
						: operation === "request"
							? operations.request({ authority, operation: "turn.steer" })
							: operations.prompt({ authority, operation: "turn.prompt", text: "blocked" })
			).catch(error => error);
			await entered.promise;
			expect(await pending).toMatchObject({ code: "timeout" });
			expect(fake.reconcileTimeouts[0]).toBeGreaterThan(0);
			expect(fake.reconcileTimeouts[0]).toBeLessThanOrEqual(50);
			release.resolve();
			await new Promise(resolve => setTimeout(resolve, 0));
			expect(fake.acquireTimeouts).toEqual([]);
			expect(fake.requests).toEqual([]);
		},
	);

	test.each(["create", "startManagedSession"] as const)(
		"runner %s forwards the original endpoint receipt before its proof hook",
		async method => {
			const fake = new FakeRuntime();
			const endpointReceipt = { ...lifecycleSuccess().result, endpointIncarnation: "a".repeat(64) };
			fake.lifecycleOutcome = { ok: true, operation: "session.create", result: endpointReceipt };
			const runner = createManagedGjcTurnRunner(fake.runtime);
			const failure = new Error("proof admission denied");
			const captured: (ManagedEndpointReceipt | undefined)[] = [];
			const input = {
				cwd: authority.canonicalWorkspace,
				sessionRoot: "/sessions",
				projectId: authority.projectId,
				chatId: authority.chatId,
				userMessageId: "message-create",
				text: "prompt",
				preparedManagedAuthority: withoutIdentity(),
				onLifecycleAcknowledged: (acknowledged: ManagedTurnAuthority, receipt?: ManagedEndpointReceipt) => {
					expect(acknowledged).toMatchObject(authority);
					captured.push(receipt);
				},
				beforeLifecycleProof: () => {
					expect(captured).toEqual([endpointReceipt]);
					throw failure;
				},
			};
			await expect(
				method === "create"
					? runner.create(input)
					: runner.startManagedSession(
							input,
							async () => undefined,
							async () => undefined,
						),
			).rejects.toBe(failure);
			expect(captured[0]).not.toBe(endpointReceipt);
			expect(fake.registered).toEqual([]);
			expect(fake.requests).toEqual([]);
		},
	);

	test.each(["session.new", "session.resume"] as const)(
		"runner runControl forwards %s endpoint receipts to its durable owner before proof",
		async operation => {
			const fake = new FakeRuntime();
			const input: LiveGatewayRunnerInput = {
				project: {
					id: authority.projectId,
					name: "Project",
					cwd: authority.canonicalWorkspace,
					allowedRoot: "/workspace",
					createdAt: new Date("2026-07-08T00:00:00.000Z"),
				},
				prompt: "control",
				chatId: authority.chatId,
				messageId: "message-control",
				userMessageId: "message-control",
				userMessageParentId: null,
				continued: true,
				ownerUserId: authority.principalId,
				control: operation === "session.new" ? { operation } : { operation, sessionId: authority.sessionId },
			};
			const lifecycleOperation = operation === "session.new" ? "session.create" : "session.resume";
			const payloadHash = controlOperationHash(input);
			const requestKey = lifecycleControlRequestKey(authority, lifecycleOperation, input.userMessageId, payloadHash);
			const endpointReceipt = {
				sessionId: operation === "session.new" ? "session-successor" : authority.sessionId,
				endpointGeneration: authority.generation,
				endpointIncarnation: "a".repeat(64),
			};
			fake.lifecycleOutcome = { ok: true, operation: lifecycleOperation, result: endpointReceipt };
			const failure = new Error("proof admission denied");
			const captured: (ManagedEndpointReceipt | undefined)[] = [];
			await expect(
				createManagedGjcTurnRunner(fake.runtime).runControl!(
					input,
					{
						principalId: authority.principalId,
						projectId: authority.projectId,
						chatId: authority.chatId,
						sessionId: authority.sessionId,
						rawFrameCursor: 0,
						eventCursor: 0,
						operationId: input.userMessageId,
						managedAuthority: authority,
					},
					{} as never,
					undefined,
					undefined,
					{
						operation: lifecycleOperation,
						source: { ...authority, requestKey },
						preparedAuthority: { ...withoutIdentity(), requestKey },
						lifecycleOperation: { operationId: input.userMessageId, requestKey, payloadHash },
						onInvoking: () => undefined,
						onAcknowledged: (acknowledged, receipt) => {
							expect(acknowledged.sessionId).toBe(endpointReceipt.sessionId);
							captured.push(receipt);
						},
						beforeProof: () => {
							expect(captured).toEqual([endpointReceipt]);
							throw failure;
						},
					},
				),
			).rejects.toBe(failure);
			expect(captured[0]).not.toBe(endpointReceipt);
			expect(fake.registered).toEqual([]);
			expect(fake.requests).toEqual([]);
		},
	);

	test("retirement reconcile expiry cannot start generation observation", async () => {
		const fake = new FakeRuntime();
		let now = Date.now();
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		fake.reconcile = async timeoutMs => {
			fake.reconcileTimeouts.push(timeoutMs);
			now += 1_001;
		};
		try {
			await expect(
				createManagedSessionOperations(fake.runtime, 1_000).close({
					authority,
					target: { sessionId: authority.sessionId },
				}),
			).rejects.toMatchObject({ code: "timeout" });
			expect(fake.lifecycle).toHaveLength(1);
			expect(fake.statusTimeouts).toEqual([]);
		} finally {
			clock.mockRestore();
		}
	});

	test("expired postdispatch cancellation does not create a fresh one-millisecond abort", async () => {
		const fake = new FakeRuntime();
		const controller = new AbortController();
		let now = Date.now();
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		let admissionCount = 0;
		try {
			await expect(
				createManagedSessionOperations(fake.runtime, 1_000).prompt({
					authority,
					operation: "turn.prompt",
					text: "cancel",
					signal: controller.signal,
					onDispatch: () => {
						admissionCount = fake.reconcileTimeouts.length;
						now += 1_001;
						controller.abort();
					},
				}),
			).rejects.toMatchObject({ code: "gjc_turn_cancelled" });
			expect(fake.reconcileTimeouts).toHaveLength(admissionCount);
			expect(fake.requests.filter(request => request.operation === "turn.abort")).toEqual([]);
		} finally {
			clock.mockRestore();
		}
	});

	test("uses external lifecycle adoption, exact tenant authority, public Router envelopes, and bounded pages", async () => {
		const fake = new FakeRuntime();
		const operations = createManagedSessionOperations(fake.runtime);
		await operations.create({ authority: withoutIdentity(), target: { path: authority.canonicalWorkspace } });
		await operations.resume({ authority, target: { sessionIdOrPrefix: authority.sessionId } });
		await operations.fork({
			authority,
			target: { sourceSessionId: authority.sessionId, cwd: authority.canonicalWorkspace },
		});
		await operations.list({ authority, target: { cwd: authority.canonicalWorkspace } });
		await operations.setModel(authority, { provider: "openai", modelId: "gpt-5", thinkingLevel: "high" });
		await operations.setThinking(authority, "low");
		await expect(operations.query(authority, "models.list/current")).resolves.toEqual(["one", "two"]);
		await expect(operations.getProviders(authority)).resolves.toEqual([]);
		await expect(operations.getBranchCandidates(authority)).resolves.toEqual([]);
		expect(fake.externalLifecycle.map(call => call.operation)).toEqual(["create", "resume"]);
		expect(fake.externalLifecycle[0]?.request).toMatchObject({
			actor: { namespace: "openwebui-gjc-adapter", id: authority.principalId },
			requestKey: authority.requestKey,
			target: { kind: "existing_path", path: authority.canonicalWorkspace },
		});
		expect(fake.registered).toHaveLength(3);
		expect(operations.payloadHash({ z: [2, 1], a: "stable" })).toBe(
			operations.payloadHash({ a: "stable", z: [2, 1] }),
		);
		expect(fake.requests.map(frame => frame.operation ?? frame.query)).toEqual([
			"model.set",
			"thinking.set",
			"models.list/current",
			"models.list/current",
			"providers.list/active",
			"session.branch_candidates",
		]);
		expect(fake.requests[2]?.cursor).toBeUndefined();
		expect(fake.requests[3]?.cursor).toBe("next");
		expect(JSON.stringify(fake)).not.toMatch(/credential|password|endpointIncarnation/i);
	});

	test("keeps logical timeout out of SDK readiness and persists identity before registration", async () => {
		const fake = new FakeRuntime();
		const operations = createManagedSessionOperations(fake.runtime, 500);
		const order: string[] = [];
		const register = fake.registerLifecycleTenant.bind(fake);
		fake.registerLifecycleTenant = async (key, outcome) => {
			order.push("register");
			return register(key, outcome);
		};
		await operations.create({
			authority: withoutIdentity(),
			target: { path: authority.canonicalWorkspace },
			onAcknowledged: proof => {
				order.push("acknowledge");
				expect(proof).toMatchObject(authority);
			},
		});
		expect(order).toEqual(["acknowledge", "register"]);
		expect(fake.externalLifecycle[0]?.request).not.toHaveProperty("timeoutMs");
		expect(fake.externalLifecycle[0]?.request).not.toHaveProperty("readinessTimeoutMs");
		expect(fake.externalTimeouts[0]).toBeGreaterThan(0);
		expect(fake.externalTimeouts[0]).toBeLessThanOrEqual(500);
	});

	test.each(["create", "resume", "fork"] as const)(
		"%s acknowledges a detached original endpoint receipt before proof without changing routing authority",
		async operation => {
			const fake = new FakeRuntime();
			const expected = {
				sessionId: authority.sessionId,
				endpointGeneration: authority.generation,
				endpointIncarnation: "a".repeat(64),
			};
			const rawResult = { ...expected, privateMetadata: { source: "sdk" } };
			fake.lifecycleOutcome = { ok: true, operation: `session.${operation}`, result: rawResult };
			const operations = createManagedSessionOperations(fake.runtime);
			const receipts: ManagedEndpointReceipt[] = [];
			for (let invocation = 0; invocation < 2; invocation++) {
				const result = await operations[operation]({
					authority: operation === "create" ? withoutIdentity() : authority,
					target: {
						path: authority.canonicalWorkspace,
						sessionIdOrPrefix: authority.sessionId,
						sourceSessionId: authority.sessionId,
						cwd: authority.canonicalWorkspace,
					},
					onAcknowledged: (acknowledged, endpointReceipt) => {
						expect(acknowledged).toMatchObject(authority);
						expect(acknowledged).not.toHaveProperty("endpointReceipt");
						expect(acknowledged).not.toHaveProperty("endpointIncarnation");
						expect(endpointReceipt).toEqual(expected);
						expect(endpointReceipt).not.toBe(rawResult);
						expect(fake.registered).toHaveLength(invocation);
						if (endpointReceipt === undefined) throw new Error("Original endpoint receipt is required.");
						receipts.push(endpointReceipt);
						if (invocation === 0) {
							Reflect.set(endpointReceipt, "sessionId", "caller-session");
							Reflect.set(endpointReceipt, "endpointGeneration", 99);
							Reflect.set(endpointReceipt, "endpointIncarnation", "caller-incarnation");
						}
					},
					beforeProof: () => {
						expect(receipts).toHaveLength(invocation + 1);
						expect(rawResult).toEqual({ ...expected, privateMetadata: { source: "sdk" } });
					},
				});
				expect(result.tenant).toMatchObject(authority);
				expect(result.tenant).not.toHaveProperty("endpointIncarnation");
				expect(result).not.toHaveProperty("endpointReceipt");
			}
			expect(receipts[0]).not.toBe(receipts[1]);
			expect(receipts[1]).toEqual(expected);
		},
	);

	test.each(["create", "resume", "fork"] as const)(
		"%s retains generation acknowledgement but denies proof when the original endpoint receipt is unavailable",
		async operation => {
			for (const fields of [
				{},
				{ endpointIncarnation: "" },
				{ endpointIncarnation: " " },
				{ endpointIncarnation: null },
				{ endpointIncarnation: 7 },
				{ endpointIncarnation: "not-a-hash" },
				{ endpointIncarnation: "a".repeat(64), operation: undefined },
				{ endpointIncarnation: "a".repeat(64), operation: "session.close" },
			]) {
				const fake = new FakeRuntime();
				const { operation: override, ...resultFields } = fields as Record<string, unknown>;
				fake.lifecycleOutcome = {
					ok: true,
					operation: "operation" in fields ? override : `session.${operation}`,
					result: { sessionId: authority.sessionId, endpointGeneration: authority.generation, ...resultFields },
				};
				const acknowledgements: ManagedTurnAuthority[] = [];
				let persistenceCompleted = false;
				let proved = false;
				const error = await createManagedSessionOperations(fake.runtime)
					[operation]({
						authority: operation === "create" ? withoutIdentity() : authority,
						lifecycleOperation: {
							operationId: "lifecycle-operation",
							requestKey: authority.requestKey,
							payloadHash: "a".repeat(64),
						},
						target: {
							path: authority.canonicalWorkspace,
							sessionIdOrPrefix: authority.sessionId,
							sourceSessionId: authority.sessionId,
							cwd: authority.canonicalWorkspace,
						},
						onAcknowledged: async (acknowledged, endpointReceipt) => {
							acknowledgements.push(acknowledged);
							expect(endpointReceipt).toBeUndefined();
							await Promise.resolve();
							persistenceCompleted = true;
						},
						beforeProof: () => {
							proved = true;
						},
					})
					.catch(error => error);
				expect(error).toBeInstanceOf(ManagedTurnUncertainError);
				expect(error.message).toContain("original endpoint receipt");
				expect(persistenceCompleted).toBe(true);
				expect(acknowledgements).toHaveLength(1);
				expect(acknowledgements[0]).toMatchObject(authority);
				expect(proved).toBe(false);
				expect(fake.registered).toEqual([]);
				expect(fake.observedOutcomeCount).toBe(1);
				expect(fake.acquireTimeouts).toEqual([]);
				expect(fake.lifecycle.filter(call => call.operation === "close")).toEqual([]);
			}
		},
	);

	test.each(["create", "resume", "fork"] as const)(
		"%s cannot repair missing original receipt authority from its acknowledgement callback",
		async operation => {
			const fake = new FakeRuntime();
			const controller = new AbortController();
			const rawResult: Record<string, unknown> = {
				sessionId: authority.sessionId,
				endpointGeneration: authority.generation,
			};
			fake.lifecycleOutcome = { ok: true, operation: `session.${operation}`, result: rawResult };
			const acknowledgements: ManagedTurnAuthority[] = [];
			let proved = false;
			await expect(
				createManagedSessionOperations(fake.runtime)[operation]({
					authority: operation === "create" ? withoutIdentity() : authority,
					signal: controller.signal,
					target: {
						path: authority.canonicalWorkspace,
						sessionIdOrPrefix: authority.sessionId,
						sourceSessionId: authority.sessionId,
						cwd: authority.canonicalWorkspace,
					},
					onAcknowledged: (acknowledged, endpointReceipt) => {
						acknowledgements.push(acknowledged);
						expect(endpointReceipt).toBeUndefined();
						rawResult.endpointIncarnation = "a".repeat(64);
						controller.abort();
					},
					beforeProof: () => {
						proved = true;
					},
				}),
			).rejects.toBeInstanceOf(ManagedTurnUncertainError);
			expect(acknowledgements).toHaveLength(1);
			expect(acknowledgements[0]).toMatchObject(authority);
			expect(rawResult.endpointIncarnation).toBe("a".repeat(64));
			expect(proved).toBe(false);
			expect(fake.registered).toEqual([]);
			expect(fake.acquireTimeouts).toEqual([]);
			expect(fake.lifecycle.filter(call => call.operation === "close")).toEqual([]);
		},
	);

	test.each(["create", "resume", "fork"] as const)(
		"%s never acknowledges an endpoint pair from a failed original outcome",
		async operation => {
			const fake = new FakeRuntime();
			fake.lifecycleOutcome = {
				ok: false,
				operation: `session.${operation}`,
				result: { ...lifecycleSuccess().result, endpointIncarnation: "a".repeat(64) },
			};
			let acknowledged = false;
			await expect(
				createManagedSessionOperations(fake.runtime)[operation]({
					authority: operation === "create" ? withoutIdentity() : authority,
					target: {
						path: authority.canonicalWorkspace,
						sessionIdOrPrefix: authority.sessionId,
						sourceSessionId: authority.sessionId,
						cwd: authority.canonicalWorkspace,
					},
					onAcknowledged: () => {
						acknowledged = true;
					},
				}),
			).rejects.toThrow();
			expect(acknowledged).toBe(false);
			expect(fake.registered).toEqual([]);
		},
	);

	test.each([false, true])(
		"retains failed durable acknowledgement with receipt=%s without proof or cleanup",
		async hasReceipt => {
			const fake = new FakeRuntime();
			const failure = new Error("ack fsync failed");
			const endpointReceipt = { ...lifecycleSuccess().result, endpointIncarnation: "a".repeat(64) };
			fake.lifecycleOutcome = {
				ok: true,
				operation: "session.create",
				result: hasReceipt
					? endpointReceipt
					: { sessionId: authority.sessionId, endpointGeneration: authority.generation },
			};
			await expect(
				createManagedSessionOperations(fake.runtime).create({
					authority: withoutIdentity(),
					target: { path: authority.canonicalWorkspace },
					onAcknowledged: (acknowledged, receipt) => {
						expect(acknowledged).toMatchObject(authority);
						expect(receipt).toEqual(hasReceipt ? endpointReceipt : undefined);
						expect(receipt).not.toBe(endpointReceipt);
						throw failure;
					},
				}),
			).rejects.toBe(failure);
			expect(fake.registered).toHaveLength(0);
			expect(fake.observedOutcomeCount).toBe(0);
			expect(fake.lifecycle).toHaveLength(0);
		},
	);

	test.each([25, 180_000])(
		"external create and resume keep a %ims logical deadline out of readiness",
		async timeoutMs => {
			const fake = new FakeRuntime();
			const operations = createManagedSessionOperations(fake.runtime, timeoutMs);
			await operations.create({ authority: withoutIdentity(), target: { path: authority.canonicalWorkspace } });
			await operations.resume({ authority, target: { sessionIdOrPrefix: authority.sessionId } });
			expect(fake.externalLifecycle.map(call => call.operation)).toEqual(["create", "resume"]);
			for (const call of fake.externalLifecycle) {
				expect(call.request).not.toHaveProperty("readinessTimeoutMs");
				expect(call.request).not.toHaveProperty("timeoutMs");
			}
			for (const budget of fake.externalTimeouts) {
				expect(budget).toBeGreaterThan(0);
				expect(budget).toBeLessThanOrEqual(timeoutMs);
			}
		},
	);

	test.each(["create", "resume", "fork"] as const)(
		"%s acknowledges the original late endpoint receipt after timeout and abort without proof or registration",
		async operation => {
			const fake = new FakeRuntime();
			const gate = deferred<Record<string, unknown>>();
			const acknowledged = deferred<ManagedEndpointReceipt | undefined>();
			const controller = new AbortController();
			const endpointReceipt = { ...lifecycleSuccess().result, endpointIncarnation: "b".repeat(64) };
			fake.lifecycleOutcome = gate.promise;
			let proved = false;
			await expect(
				createManagedSessionOperations(fake.runtime, 25)[operation]({
					authority: operation === "create" ? withoutIdentity() : authority,
					signal: controller.signal,
					target: {
						path: authority.canonicalWorkspace,
						sessionIdOrPrefix: authority.sessionId,
						sourceSessionId: authority.sessionId,
						cwd: authority.canonicalWorkspace,
					},
					onAcknowledged: (assigned, receipt) => {
						expect(assigned).toMatchObject(authority);
						acknowledged.resolve(receipt);
					},
					beforeProof: () => {
						proved = true;
					},
				}),
			).rejects.toMatchObject({ code: "timeout" });
			controller.abort();
			gate.resolve({ ok: true, operation: `session.${operation}`, result: endpointReceipt });
			expect(await acknowledged.promise).toEqual(endpointReceipt);
			expect(await acknowledged.promise).not.toBe(endpointReceipt);
			await new Promise(resolve => setTimeout(resolve, 0));
			expect(proved).toBe(false);
			expect(fake.registered).toHaveLength(0);
			expect(fake.lifecycle.filter(call => call.operation === "close")).toEqual([]);
		},
	);

	test("requires retired exact generation for close or delete and fences unproven retirement", async () => {
		const fake = new FakeRuntime();
		const operations = createManagedSessionOperations(fake.runtime);
		fake.status = "retired";
		await expect(operations.close({ authority, target: { sessionId: authority.sessionId } })).resolves.toMatchObject({
			ok: true,
		});
		fake.status = "current";
		await expect(operations.delete({ authority, target: { sessionId: authority.sessionId } })).rejects.toBeInstanceOf(
			ManagedTurnUncertainError,
		);
		fake.status = "unknown";
		await expect(operations.close({ authority, target: { sessionId: authority.sessionId } })).rejects.toBeInstanceOf(
			ManagedTurnUncertainError,
		);
	});

	test("rejects failed and foreign close or delete acknowledgements even when generation is retired", async () => {
		for (const operation of ["close", "delete"] as const) {
			for (const outcome of [
				{ ok: false, certainty: "retryable" },
				{ ok: true },
				{ ok: true, result: { sessionId: "replacement" } },
			]) {
				const fake = new FakeRuntime();
				fake.status = "retired";
				fake.retirementOutcome = outcome;
				const operations = createManagedSessionOperations(fake.runtime);
				await expect(
					operations[operation]({ authority, target: { sessionId: authority.sessionId } }),
				).rejects.toBeInstanceOf(ManagedTurnUncertainError);
			}
		}
	});
	test("rejects incomplete or tenant-mismatched authority before the Router request", async () => {
		const fake = new FakeRuntime();
		const operations = createManagedSessionOperations(fake.runtime);
		await expect(
			operations.request({ authority: { ...authority, generation: 0 }, operation: "turn.prompt" }),
		).rejects.toThrow("Complete positive");
		fake.rejectTenant = true;
		await expect(operations.request({ authority, operation: "turn.prompt" })).rejects.toThrow("Exact tenant");
		expect(fake.requests).toHaveLength(0);
	});

	test("does not admit a stale generation or changed lease and epoch for Router traffic", async () => {
		for (const candidate of [
			{ generation: authority.generation - 1 },
			{ leaseId: "lease-stale" },
			{ epoch: "epoch-stale" },
		] as const) {
			const fake = new FakeRuntime();
			const operations = createManagedSessionOperations(fake.runtime);
			await expect(
				operations.request({
					authority: { ...authority, ...candidate },
					operation: "turn.prompt",
				}),
			).rejects.toThrow("Exact tenant");
			expect(fake.requests).toHaveLength(0);
		}
	});

	test("uses public terminal abort control_response and never dispatches a pre-cancelled prompt", async () => {
		const fake = new FakeRuntime();
		const operations = createManagedSessionOperations(fake.runtime);
		await operations.abort({ authority, operation: "ignored" });
		expect(fake.requests[0]).toMatchObject({
			type: "control_request",
			operation: "turn.abort",
			input: { mode: "terminal", scope: "turn" },
		});
		const controller = new AbortController();
		controller.abort();
		await expect(
			operations.prompt({ authority, operation: "turn.prompt", text: "no dispatch", signal: controller.signal }),
		).rejects.toMatchObject({ code: "gjc_turn_cancelled" });
		expect(fake.requests).toHaveLength(1);
	});

	test("rejects repeated query cursors rather than traversing an unbounded public Router stream", async () => {
		const fake = new FakeRuntime();
		fake.repeatCursor = true;
		await expect(
			createManagedSessionOperations(fake.runtime).query(authority, "models.list/current"),
		).rejects.toThrow("repeated");
	});

	test("bounds public queries to 256 pages and 100000 total items", async () => {
		const pages = new FakeRuntime();
		pages.queryHandler = async (_frame, page) => queryResponse([], `page-${page}`);
		await expect(
			createManagedSessionOperations(pages.runtime).query(authority, "models.list/current"),
		).rejects.toThrow("page bound");
		expect(pages.requests).toHaveLength(256);
		const items = new FakeRuntime();
		items.queryHandler = async (_frame, page) =>
			queryResponse(
				Array.from({ length: 50_001 }, () => "item"),
				page === 1 ? "next" : undefined,
			);
		await expect(
			createManagedSessionOperations(items.runtime).query(authority, "models.list/current"),
		).rejects.toThrow("item bound");
		expect(items.requests).toHaveLength(2);
	});

	test("fails closed on malformed and error query envelopes", async () => {
		for (const response of [
			{ type: "control_response", ok: true, result: {} },
			{ type: "query_response", ok: false, error: { message: "query denied" } },
			{ type: "query_response", ok: true, page: { items: [], complete: false } },
			{ type: "query_response", ok: true, page: { items: [], complete: true, continuationCursor: "unexpected" } },
			{ type: "query_response", ok: true, page: { items: [], complete: false, continuationCursor: "" } },
			{ type: "query_response", ok: true, page: { items: {}, complete: true } },
		]) {
			const fake = new FakeRuntime();
			fake.queryHandler = async () => response;
			await expect(
				createManagedSessionOperations(fake.runtime).query(authority, "models.list/current"),
			).rejects.toThrow();
			expect(fake.requests).toHaveLength(1);
		}
	});

	test("uses one total query deadline rather than renewing the timeout on each page", async () => {
		const fake = new FakeRuntime();
		const releaseSecond = deferred<Record<string, unknown>>();
		fake.queryHandler = async (_frame, page) => {
			if (page === 1) {
				await new Promise(resolve => setTimeout(resolve, 50));
				return queryResponse(["one"], "next");
			}
			return releaseSecond.promise;
		};
		await expect(
			createManagedSessionOperations(fake.runtime).query(authority, "models.list/current", {}, 500),
		).rejects.toMatchObject({ code: "timeout" });
		expect(fake.requests).toHaveLength(2);
		expect(fake.requestTimeouts[1]!).toBeLessThan(fake.requestTimeouts[0]! - 10);
		releaseSecond.resolve(queryResponse(["two"], "must-not-fetch"));
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(fake.requests).toHaveLength(2);
	});

	test("bounds generic request acquisition and prevents dispatch after expiration", async () => {
		const fake = new FakeRuntime();
		const release = deferred<void>();
		const acquire = fake.acquireAttachment.bind(fake);
		fake.acquireAttachment = async key => {
			await release.promise;
			return acquire(key);
		};
		const operations = createManagedSessionOperations(fake.runtime, 25);
		await expect(
			operations.request({ authority, operation: "turn.steer", input: { text: "bounded" } }),
		).rejects.toMatchObject({ code: "timeout" });
		expect(fake.requests).toHaveLength(0);
		release.resolve();
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(fake.requests).toHaveLength(0);
	});

	test("cancels hanging generic acquisition without late dispatch", async () => {
		const fake = new FakeRuntime();
		const entered = deferred<void>();
		const release = deferred<void>();
		const acquire = fake.acquireAttachment.bind(fake);
		fake.acquireAttachment = async key => {
			entered.resolve();
			await release.promise;
			return acquire(key);
		};
		const controller = new AbortController();
		const request = createManagedSessionOperations(fake.runtime, 1_000).request({
			authority,
			operation: "turn.steer",
			signal: controller.signal,
		});
		await entered.promise;
		controller.abort();
		await expect(request).rejects.toMatchObject({ code: "gjc_turn_cancelled" });
		release.resolve();
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(fake.requests).toHaveLength(0);
	});

	test("rejects invalid query and turn timeouts before any Router dispatch", async () => {
		for (const timeoutMs of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
			const fake = new FakeRuntime();
			const operations = createManagedSessionOperations(fake.runtime);
			await expect(operations.query(authority, "models.list/current", {}, timeoutMs)).rejects.toBeInstanceOf(
				TypeError,
			);
			await expect(
				operations.prompt({ authority, operation: "turn.prompt", text: "no", timeoutMs }),
			).rejects.toBeInstanceOf(TypeError);
			expect(fake.requests).toHaveLength(0);
		}
	});

	test("requires real terminal events for prompt, follow-up and gate continuation", async () => {
		const fake = new FakeRuntime();
		const operations = createManagedSessionOperations(fake.runtime);
		const input = { authority, operation: "turn.prompt", text: "hello", timeoutMs: 1_000 };
		for (const run of [
			() => operations.prompt(input),
			() => operations.followUp(input),
			() => operations.answerGate({ ...input, gateId: "gate-1", answer: "yes" }),
		]) {
			await expect(run()).resolves.toMatchObject({
				text: "terminal done",
				events: [
					{ type: "message_update", text: "done" },
					{ type: "agent_end", payload: { finalText: "terminal done" } },
				],
			});
			expect(fake.subscriptions).toHaveLength(0);
		}
		expect(fake.requests.filter(request => request.operation === "workflow.gate_answer")[0]?.input).toEqual({
			id: "gate-1",
			response: "yes",
			expectedSessionId: authority.sessionId,
		});
	});
});

function withoutIdentity(): Omit<ManagedTurnAuthority, "sessionId" | "generation"> {
	const { sessionId: _sessionId, generation: _generation, ...value } = authority;
	return value;
}

class FakeRuntime {
	readonly state = "running";
	readonly attachment = { isCurrent: () => true };
	readonly tokens = new Map<string, ManagedSdkAttachment>();
	readonly externalLifecycle: { operation: string; request: Record<string, unknown> }[] = [];
	readonly externalTimeouts: (number | undefined)[] = [];
	readonly lifecycle: { operation: string; request: Record<string, unknown> }[] = [];
	observedOutcomeCount = 0;
	readonly requests: Record<string, unknown>[] = [];
	readonly registered: unknown[] = [];
	readonly subscriptions: ((frame: unknown) => Promise<void>)[] = [];
	status: "retired" | "current" | "unknown" = "current";
	retirementOutcome: Record<string, unknown> = { ok: true, result: { sessionId: authority.sessionId } };
	lifecycleOutcome: Record<string, unknown> | Promise<Record<string, unknown>> | undefined;
	rejectTenant = false;
	repeatCursor = false;
	queryHandler: ((frame: Record<string, unknown>, page: number) => Promise<Record<string, unknown>>) | undefined;
	readonly requestTimeouts: (number | undefined)[] = [];
	readonly reconcileTimeouts: (number | undefined)[] = [];
	readonly acquireTimeouts: (number | undefined)[] = [];
	readonly statusTimeouts: (number | undefined)[] = [];
	queryCount = 0;
	get runtime(): ManagedSdkRuntime {
		return this as unknown as ManagedSdkRuntime;
	}
	async reconcile(timeoutMs?: number) {
		this.reconcileTimeouts.push(timeoutMs);
	}
	async acquireAttachment(key: unknown, timeoutMs?: number) {
		this.acquireTimeouts.push(timeoutMs);
		const tenant = key as typeof authority;
		if (
			this.rejectTenant ||
			tenant.principalId !== authority.principalId ||
			tenant.projectId !== authority.projectId ||
			tenant.canonicalWorkspace !== authority.canonicalWorkspace ||
			tenant.chatId !== authority.chatId ||
			tenant.sessionId !== authority.sessionId ||
			tenant.generation !== authority.generation ||
			tenant.leaseId !== authority.leaseId ||
			tenant.epoch !== authority.epoch
		)
			throw new Error("Exact tenant mismatch");
		return this.token(tenant);
	}
	async registerLifecycleTenant(key: unknown, outcome: unknown) {
		this.registered.push({ key, outcome });
		return this.token(key as TenantSessionKey);
	}
	async proveLifecycleTenant(key: TenantSessionKey) {
		return this.registerLifecycleTenant(key, undefined);
	}
	private token(key: TenantSessionKey): ManagedSdkAttachment {
		const identity = JSON.stringify(key);
		let token = this.tokens.get(identity);
		if (token === undefined) {
			token = { tenant: key, generation: key.generation, isCurrent: this.attachment.isCurrent };
			this.tokens.set(identity, token);
		}
		return token;
	}
	async createPreparedExternalLifecycleSession(
		_authority: unknown,
		request: Record<string, unknown>,
		timeoutMs?: number,
		onOutcome?: (outcome: unknown) => void | Promise<void>,
	) {
		this.externalTimeouts.push(timeoutMs);
		this.externalLifecycle.push({ operation: "create", request });
		const outcome = await (this.lifecycleOutcome ?? lifecycleSuccess());
		await onOutcome?.(outcome);
		this.observedOutcomeCount++;
		return outcome;
	}
	async resumeExternalLifecycleSession(
		_tenant: unknown,
		request: Record<string, unknown>,
		timeoutMs?: number,
		onOutcome?: (outcome: unknown) => void | Promise<void>,
	) {
		this.externalTimeouts.push(timeoutMs);
		this.externalLifecycle.push({ operation: "resume", request });
		const outcome = { kind: "result", outcome: await (this.lifecycleOutcome ?? lifecycleSuccess("session.resume")) };
		await onOutcome?.(outcome);
		this.observedOutcomeCount++;
		return outcome;
	}
	async request(
		_attachment: unknown,
		frame: Record<string, unknown>,
		options?: { beforeDispatch?: () => void; onDispatch?: () => void; timeoutMs?: number },
	) {
		options?.beforeDispatch?.();
		this.requests.push(frame);
		this.requestTimeouts.push(options?.timeoutMs);
		options?.onDispatch?.();
		if (frame.type === "query_request" && this.queryHandler !== undefined)
			return await this.queryHandler(frame, ++this.queryCount);
		if (
			frame.operation === "turn.prompt" ||
			frame.operation === "turn.follow_up" ||
			frame.operation === "workflow.gate_answer"
		) {
			const listener = this.subscriptions.at(-1);
			if (listener === undefined) throw new Error("managed frame subscription must precede request");
			await listener({
				frame: {
					body: { type: "message_update", id: "frame-1", text: "done" },
					sessionId: authority.sessionId,
					generation: authority.generation,
					commandId: "command-1",
					turnId: "turn-1",
					seq: 1,
				},
			});
			await listener({
				frame: {
					body: { type: "agent_end", finalText: "terminal done" },
					sessionId: authority.sessionId,
					generation: authority.generation,
					commandId: "command-1",
					turnId: "turn-1",
					seq: 2,
				},
			});
		}
		if (frame.type === "query_request" && frame.query === "models.list/current")
			return queryResponse(
				frame.cursor === undefined || this.repeatCursor ? ["one"] : ["two"],
				frame.cursor === undefined || this.repeatCursor ? "next" : undefined,
			);
		if (frame.type === "query_request") return queryResponse([]);
		return {
			type: "control_response",
			ok: true,
			result: { accepted: true, commandId: "command-1", turnId: "turn-1" },
		};
	}
	subscribeFrames(
		_attachment: unknown,
		_operation: string,
		_correlation: unknown,
		listener: (frame: unknown) => Promise<void>,
	) {
		this.subscriptions.push(listener);
		const unsubscribe = (() => {
			this.subscriptions.splice(this.subscriptions.indexOf(listener), 1);
		}) as (() => void) & {
			drain(): Promise<void>;
		};
		unsubscribe.drain = async () => undefined;
		return unsubscribe;
	}
	prepareFrameSubscription(_attachment: unknown, _operation: string, listener: (frame: unknown) => Promise<void>) {
		const buffered: unknown[] = [];
		let bound = false;
		let active = true;
		let tail = Promise.resolve();
		const deliver = async (frame: unknown) => {
			if (!bound) {
				buffered.push(frame);
				return;
			}
			tail = tail.then(async () => {
				if (active) await listener(frame);
			});
			void tail.catch(() => undefined);
		};
		this.subscriptions.push(deliver);
		const unsubscribe = (() => {
			if (!active) return;
			active = false;
			this.subscriptions.splice(this.subscriptions.indexOf(deliver), 1);
		}) as (() => void) & { bind(correlation: unknown): void; drain(): Promise<void> };
		unsubscribe.bind = () => {
			bound = true;
			for (const frame of buffered) void deliver(frame);
			buffered.length = 0;
		};
		unsubscribe.drain = async () => {
			await tail;
		};
		return unsubscribe;
	}
	async generationStatus(_key: unknown, timeoutMs?: number) {
		this.statusTimeouts.push(timeoutMs);
		return { status: this.status };
	}
	async forkLifecycleSession(
		_tenant: unknown,
		request: Record<string, unknown>,
		onOutcome?: (outcome: unknown) => void | Promise<void>,
	) {
		this.lifecycle.push({ operation: "fork", request });
		const outcome = await (this.lifecycleOutcome ?? lifecycleSuccess("session.fork"));
		await onOutcome?.(outcome);
		this.observedOutcomeCount++;
		return outcome;
	}
	async closeLifecycleSession(_tenant: unknown, request: Record<string, unknown>) {
		this.lifecycle.push({ operation: "close", request });
		return this.retirementOutcome;
	}
	async deleteLifecycleSession(_tenant: unknown, request: Record<string, unknown>) {
		this.lifecycle.push({ operation: "delete", request });
		return this.retirementOutcome;
	}
	async listLifecycleSessions(_tenant: unknown, request: Record<string, unknown>) {
		this.lifecycle.push({ operation: "list", request });
		return { ok: true, result: { sessions: [] } };
	}
}

function lifecycleSuccess(operation = "session.create") {
	return {
		ok: true as const,
		operation,
		result: {
			sessionId: authority.sessionId,
			endpointGeneration: authority.generation,
			endpointIncarnation: "a".repeat(64),
		},
	};
}
function queryResponse(items: readonly unknown[], continuationCursor?: string) {
	return {
		type: "query_response",
		ok: true as const,
		page: {
			items,
			complete: continuationCursor === undefined,
			...(continuationCursor === undefined ? {} : { continuationCursor }),
		},
	};
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => {
		resolve = done;
	});
	return { promise, resolve };
}
