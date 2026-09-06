import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lifecycleExactAuthority } from "../src/gjc/managed-lifecycle-evidence";
import type { ManagedSdkAttachment } from "../src/gjc/managed-sdk-runtime";
import { routeGjcTurn } from "../src/gjc/session-turn-router";
import { SessionV3FileBackedMappingStore } from "../src/gjc/session-v3-file-backed-mapping-store";
import {
	GjcTurnCancelledError,
	type GjcTurnRunner,
	type ManagedLifecycleControlOwner,
	type ManagedTurnAuthority,
} from "../src/gjc/turn-runner";
import type { LiveGatewayRunnerInput } from "../src/live/chat-completions";
import { createManagedV3GenerationStore } from "../src/live/gjc-managed-idle-reaper";
import type { ManagedSuccessorInput } from "../src/live/gjc-managed-successor";
import { createGjcRoutingLiveGatewayRunner } from "../src/live/gjc-routing-gateway";
import { controlOperationHash, lifecycleControlRequestKey } from "../src/live/gjc-routing-publication";
import { managedPreparedAuthority } from "./gjc-lifecycle-fixtures";
import { FakeGjcTurnRunner, project } from "./gjc-routing-runner-fixtures";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "gjc-managed-route-persistence-"));
	const file = join(root, "authority.json");
	const scope = { principalId: "owner-test", chatId: "chat-1" };
	let store = new SessionV3FileBackedMappingStore(file);
	const runner = new FakeGjcTurnRunner();
	const published: string[] = [];
	return {
		file,
		scope,
		runner,
		published,
		get store() {
			return store;
		},
		reopen() {
			store.close();
			store = new SessionV3FileBackedMappingStore(file);
		},
		input(id = "user-1", text = "hello") {
			const authority = store.getScoped(scope)?.managedAuthority;
			return {
				project,
				...scope,
				userMessageId: id,
				text,
				runner,
				mappings: store,
				...(authority === undefined
					? { preparedManagedAuthority: managedPreparedAuthority({ requestKey: id }) }
					: { managedAuthority: authority }),
				afterPublish: (result: { mapping: { operationId?: string } }) => {
					published.push(result.mapping.operationId!);
				},
			};
		},
		close() {
			store.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

describe("managed routing persistence", () => {
	test.each(["session.new", "session.resume"] as const)(
		"journals %s intent, invocation, acknowledgement and proof before publication across reopen",
		async operation => {
			const f = fixture();
			try {
				await routeGjcTurn(f.input());
				const before = f.store.getScoped(f.scope)!.managedAuthority!;
				const turn = lifecycleTurn(operation);
				const hash = controlOperationHash(turn);
				const order: string[] = [];
				let invocations = 0;
				const runner = Object.assign(f.runner, {
					runControl: (async (_turn, _mapping, _transaction, _successor, _dispatch, owner) => {
						invocations += 1;
						expect(owner).toBeDefined();
						const state = () => JSON.parse(readFileSync(f.file, "utf8")).mappings[0].journal.at(-1);
						expect(state()).toMatchObject({
							kind: operation === "session.new" ? "create" : "resume",
							lifecycle: { state: "intent_prepared" },
						});
						order.push("intent_prepared");
						expect(owner!.lifecycleOperation).toEqual({
							operationId: turn.userMessageId,
							payloadHash: hash,
							requestKey: lifecycleControlRequestKey(
								before,
								operation === "session.new" ? "session.create" : "session.resume",
								turn.userMessageId,
								hash,
							),
						});
						await owner!.onInvoking();
						expect(state().lifecycle.state).toBe("invoking");
						order.push("invoking");
						const authority = controlAuthority(owner!);
						await owner!.onAcknowledged(authority);
						expect(state().lifecycle).toMatchObject({
							state: "acknowledged_unproven",
							acknowledged: { ...lifecycleExactAuthority(authority), chatId: f.scope.chatId },
						});
						expect(state().lifecycle.proven).toBeUndefined();
						order.push("acknowledged_unproven");
						expect(f.store.getScoped(f.scope)?.managedAuthority).toEqual(before);
						return controlResult(authority);
					}) satisfies NonNullable<GjcTurnRunner["runControl"]>,
				});
				const getState = runner.getState.bind(runner);
				runner.getState = async input => {
					const durable = f.store.operationScoped(f.scope, turn.userMessageId)!;
					expect(durable.lifecycle?.state).toBe("active_generation_proven");
					expect(durable.lifecycle?.proven).toMatchObject({
						sessionId: input.sessionId,
						generation: input.managedAuthority!.generation,
					});
					expect(f.store.getScoped(f.scope)?.managedAuthority).toEqual(before);
					order.push("active_generation_proven");
					return getState(input);
				};
				const gateway = () => createGjcRoutingLiveGatewayRunner({ turnRunner: runner, mappings: f.store });
				const result = await gateway().run(turn);
				expect(order).toEqual(["intent_prepared", "invoking", "acknowledged_unproven", "active_generation_proven"]);
				const stored = f.store.operationScoped(f.scope, turn.userMessageId)!;
				expect(stored).toMatchObject({
					kind: operation === "session.new" ? "create" : "resume",
					state: "complete",
					lifecycle: { state: "active_generation_proven", payloadHash: hash },
				});
				expect(stored.lifecycle?.source).toEqual({
					...lifecycleExactAuthority(before),
					requestKey: stored.lifecycle!.requestKey,
				});
				expect(f.store.getScoped(f.scope)?.managedAuthority?.requestKey).not.toBe(before.requestKey);
				f.reopen();
				expect(f.store.operationScoped(f.scope, turn.userMessageId)).toEqual(stored);
				expect(await gateway().run(turn)).toEqual(result);
				await expect(gateway().run({ ...turn, prompt: "different" })).rejects.toThrow();
				expect(invocations).toBe(1);
			} finally {
				f.close();
			}
		},
	);

	test.each(["session.new", "session.resume"] as const)(
		"retains acknowledged %s uncertainty and prevents redispatch after reopen",
		async operation => {
			const f = fixture();
			try {
				await routeGjcTurn(f.input());
				const previous = f.store.getScoped(f.scope);
				let calls = 0;
				const failure = new Error("lost after acknowledged lifecycle");
				const runner = Object.assign(f.runner, {
					runControl: (async (_turn, _mapping, _transaction, _successor, _dispatch, owner) => {
						calls += 1;
						await owner!.onInvoking();
						await owner!.onAcknowledged(controlAuthority(owner!));
						throw failure;
					}) satisfies NonNullable<GjcTurnRunner["runControl"]>,
				});
				const gateway = () => createGjcRoutingLiveGatewayRunner({ turnRunner: runner, mappings: f.store });
				const turn = lifecycleTurn(operation);
				await expect(gateway().run(turn)).rejects.toBe(failure);
				f.reopen();
				expect(f.store.operationScoped(f.scope, turn.userMessageId)).toMatchObject({
					state: "uncertain",
					lifecycle: {
						state: "uncertain",
						acknowledged: { sessionId: operation === "session.new" ? "control-successor" : previous!.sessionId },
					},
				});
				expect(f.store.getScoped(f.scope)).toEqual(previous);
				await expect(gateway().run(turn)).rejects.toThrow("requires reconciliation");
				expect(calls).toBe(1);
				expect(f.runner.states).toEqual([]);
			} finally {
				f.close();
			}
		},
	);

	for (const operation of ["session.new", "session.resume"] as const) {
		test.each(["sessionId", "generation", "leaseId", "requestKey"] as const)(
			`${operation} retains its admitted receipt after predecessor %s replacement`,
			async field => {
				const f = fixture();
				try {
					await routeGjcTurn(f.input());
					const original = f.store.getScoped(f.scope)!;
					const replacementAuthority = {
						...original.managedAuthority!,
						[field]: field === "generation" ? 3 : "replacement",
					};
					let calls = 0;
					let adopted = false;
					let acknowledged: ManagedTurnAuthority | undefined;
					const runner = Object.assign(f.runner, {
						runControl: (async (_turn, _mapping, _transaction, _successor, _dispatch, owner) => {
							await owner!.onInvoking();
							calls += 1;
							f.store.setScoped(f.scope, {
								...original,
								sessionId: replacementAuthority.sessionId,
								managedAuthority: replacementAuthority,
							});
							acknowledged = controlAuthority(owner!);
							await owner!.onAcknowledged(acknowledged);
							adopted = true;
							return controlResult(acknowledged);
						}) satisfies NonNullable<GjcTurnRunner["runControl"]>,
					});
					const turn = lifecycleTurn(operation);
					const gateway = () => createGjcRoutingLiveGatewayRunner({ turnRunner: runner, mappings: f.store });
					await expect(gateway().run(turn)).rejects.toThrow(
						field === "sessionId" ? "branch_predecessor_replaced" : "authority changed",
					);
					const receipt = f.store.operationScoped(f.scope, turn.userMessageId)!;
					expect(receipt.lifecycle?.acknowledged).toEqual(lifecycleExactAuthority(acknowledged!));
					expect(receipt.lifecycle?.state).toBe("uncertain");
					expect(receipt.state).toBe("uncertain");
					expect(receipt.lifecycle?.proven).toBeUndefined();
					expect(receipt.result).toBeUndefined();
					if (operation === "session.new")
						expect(receipt.acknowledgedSuccessor).toEqual({
							sessionId: acknowledged!.sessionId,
							managedAuthority: acknowledged!,
						});
					else expect(receipt.acknowledgedSuccessor).toBeUndefined();
					f.reopen();
					expect(f.store.operationScoped(f.scope, turn.userMessageId)).toEqual(receipt);
					expect(f.store.getScoped(f.scope)?.managedAuthority).toEqual(replacementAuthority);
					const bytes = readFileSync(f.file);
					await expect(gateway().run(turn)).rejects.toThrow("requires reconciliation");
					await expect(gateway().run({ ...turn, prompt: "changed payload" })).rejects.toThrow();
					expect(readFileSync(f.file).equals(bytes)).toBe(true);
					expect(calls).toBe(1);
					expect(adopted).toBe(false);
					expect(runner.states).toEqual([]);
					expect(runner.continues).toEqual([]);
				} finally {
					f.close();
				}
			},
		);
	}

	test.each(["before", "invoking", "proven"] as const)(
		"classifies control failure at %s without inventing lifecycle or active proof",
		async stage => {
			const f = fixture();
			try {
				await routeGjcTurn(f.input());
				const turn = lifecycleTurn("session.new");
				const failure = new Error(`${stage} failure`);
				const runner = Object.assign(f.runner, {
					runControl: (async (_turn, _mapping, _transaction, _successor, _dispatch, owner) => {
						if (stage === "before") throw failure;
						await owner!.onInvoking();
						if (stage === "invoking") throw failure;
						const authority = controlAuthority(owner!);
						await owner!.onAcknowledged(authority);
						return controlResult(authority);
					}) satisfies NonNullable<GjcTurnRunner["runControl"]>,
				});
				if (stage === "proven")
					runner.getState = async () => {
						throw failure;
					};
				await expect(
					createGjcRoutingLiveGatewayRunner({ turnRunner: runner, mappings: f.store }).run(turn),
				).rejects.toBe(failure);
				f.reopen();
				const journal = f.store.operationScoped(f.scope, turn.userMessageId);
				if (stage === "before") expect(journal).toBeUndefined();
				else
					expect(journal).toMatchObject({
						state: "uncertain",
						lifecycle: { state: stage === "proven" ? "active_generation_proven" : "uncertain" },
					});
				expect(f.store.getScoped(f.scope)?.sessionId).toBe("session-1");
			} finally {
				f.close();
			}
		},
	);

	test("does not republish source identity or a fabricated result proof for session.new", async () => {
		for (const mode of ["source", "proof"] as const) {
			const f = fixture();
			try {
				await routeGjcTurn(f.input());
				const runner = Object.assign(f.runner, {
					runControl: (async (_turn, _mapping, _transaction, _successor, _dispatch, owner) => {
						await owner!.onInvoking();
						const authority = mode === "source" ? owner!.source : controlAuthority(owner!);
						await owner!.onAcknowledged(authority);
						const result = controlResult(authority);
						return {
							...result,
							result: { ...result.result, managedProof: { ...result.result.managedProof, generation: 999 } },
						};
					}) satisfies NonNullable<GjcTurnRunner["runControl"]>,
				});
				const turn = lifecycleTurn("session.new");
				await expect(
					createGjcRoutingLiveGatewayRunner({ turnRunner: runner, mappings: f.store }).run(turn),
				).rejects.toThrow();
				f.reopen();
				expect(f.store.getScoped(f.scope)?.sessionId).toBe("session-1");
				expect(f.store.operationScoped(f.scope, turn.userMessageId)?.lifecycle?.state).toBe("uncertain");
				expect(f.runner.states).toEqual([]);
			} finally {
				f.close();
			}
		}
	});

	test.each(["session.new", "session.resume"] as const)(
		"rejects preaborted %s without preparing or invoking",
		async operation => {
			const f = fixture();
			try {
				await routeGjcTurn(f.input());
				let calls = 0;
				const runner = Object.assign(f.runner, {
					runControl: async () => {
						calls += 1;
						throw new Error("unexpected");
					},
				});
				const abort = new AbortController();
				abort.abort();
				const turn = { ...lifecycleTurn(operation), signal: abort.signal };
				await expect(
					createGjcRoutingLiveGatewayRunner({ turnRunner: runner, mappings: f.store }).run(turn),
				).rejects.toBeInstanceOf(GjcTurnCancelledError);
				expect(f.store.operationScoped(f.scope, turn.userMessageId)).toBeUndefined();
				expect(calls).toBe(0);
			} finally {
				f.close();
			}
		},
	);
	test("persists initial lifecycle identity and proof in the full canonical journal", async () => {
		const f = fixture();
		try {
			await routeGjcTurn(f.input());
			const operation = f.store.operationScoped(f.scope, "user-1")!;
			expect(operation).toMatchObject({
				kind: "create",
				state: "complete",
				lifecycle: {
					operation: "session.create",
					state: "active_generation_proven",
					requestKey: "user-1",
					preparedAuthority: { principalId: "owner-test", chatId: "chat-1" },
					acknowledged: { sessionId: "session-1", generation: 1 },
					proven: { kind: "managed-generation", sessionId: "session-1", generation: 1 },
				},
			});
			expect(operation.lifecycle?.payloadHash).toBe(operation.detail);
			f.reopen();
			expect(f.store.operationScoped(f.scope, "user-1")).toEqual(operation);
			const bytes = readFileSync(f.file, "utf8");
			expect(() =>
				f.store.recordLifecycleEvidenceScoped(f.scope, "user-1", operation.detail!, operation.lifecycle!),
			).toThrow("immutable");
			expect(readFileSync(f.file, "utf8")).toBe(bytes);
		} finally {
			f.close();
		}
	});
	test("does not route a retired generation awaiting local cleanup after restart", async () => {
		const f = fixture();
		try {
			await routeGjcTurn(f.input());
			const records = createManagedV3GenerationStore(f.store);
			const record = (await records.active())[0]!;
			const intent = { key: "retirement", authority: record.authority, requestedAt: Date.now() };
			expect(await records.prepareClose(record, intent)).toBe(true);
			await records.acknowledge(record, intent, record.authority.sessionId);
			await records.retire(record, intent, {
				source: "session_index",
				observedIndexSeq: 2,
				evidenceIndexSeq: 2,
				event: "session_closed",
			});
			f.reopen();
			const gateway = createGjcRoutingLiveGatewayRunner({ turnRunner: f.runner, mappings: f.store });
			await expect(gateway.run(branchTurn())).rejects.toThrow("retirement requires reconciliation");
			expect(f.runner.states).toHaveLength(0);
			expect(f.runner.continues).toHaveLength(0);
			expect(f.store.getScoped(f.scope)?.sessionId).toBe("session-1");
		} finally {
			f.close();
		}
	});
	test("binds distinct branch ingresses and durably acknowledges before successor work", async () => {
		const f = fixture();
		try {
			await routeGjcTurn(f.input());
			f.runner.events = [{ type: "agent_end", payload: { finalText: "branch prompt complete" } }];
			const forks: ManagedSuccessorInput[] = [];
			const runner = Object.assign(f.runner, {
				async forkManagedSuccessor(input: ManagedSuccessorInput) {
					await input.onInvoking?.();
					forks.push(input);
					const managedAuthority = {
						...input.target,
						sessionId: `branch-${forks.length}`,
						generation: forks.length + 1,
					};
					await input.onAcknowledged?.(managedAuthority);
					const successor: ManagedSdkAttachment = {
						tenant: managedAuthority,
						generation: managedAuthority.generation,
						isCurrent: () => true,
					};
					await input.publish(successor);
					return { successor, managedAuthority, operationHash: input.source.requestKey };
				},
			});
			const originalGetState = runner.getState.bind(runner);
			runner.getState = async input => {
				const persisted = JSON.parse(readFileSync(f.file, "utf8"));
				const operation = persisted.mappings[0].journal.at(-1);
				expect(operation.state).toBe("pending");
				expect(operation.lifecycle).toMatchObject({
					state: "active_generation_proven",
					operation: "session.fork",
					requestKey: input.managedAuthority?.requestKey,
				});
				expect(operation.acknowledgedSuccessor).toMatchObject({
					sessionId: input.sessionId,
					managedAuthority: { ...input.managedAuthority, chatId: persisted.mappings[0].chatId },
				});
				expect(f.store.getScoped(f.scope)?.sessionId).not.toBe(input.sessionId);
				return originalGetState(input);
			};
			const gateway = () => createGjcRoutingLiveGatewayRunner({ turnRunner: runner, mappings: f.store });
			const first = await gateway().run(branchTurn());
			f.reopen();
			expect(await gateway().run(branchTurn())).toEqual(first);
			expect(forks).toHaveLength(1);
			await gateway().run(branchTurn("branch-2"));
			expect(forks).toHaveLength(2);
			expect(forks[0]!.source.requestKey).not.toBe("user-1");
			expect(forks[0]!.source.requestKey).not.toBe(forks[1]!.source.requestKey);
			expect(forks[1]!.target.requestKey).toBe(forks[1]!.source.requestKey);
			f.reopen();
			expect(await gateway().run(branchTurn())).toEqual(first);
			await expect(gateway().run({ ...branchTurn(), prompt: "changed branch payload" })).rejects.toThrow(
				"immutable result binding",
			);
			expect(forks).toHaveLength(2);
		} finally {
			f.close();
		}
	});

	test.each(["fork", "transaction", "state", "prompt", "publication"] as const)(
		"branch %s timeout retains acknowledged uncertainty without late publication",
		async phase => {
			const f = fixture();
			let release!: () => void;
			const gate = new Promise<void>(resolve => {
				release = resolve;
			});
			let reachedPhase = false;
			const waitAtPhase = async () => {
				reachedPhase = true;
				await gate;
			};
			try {
				await routeGjcTurn(f.input());
				const originalMapping = f.store.getScoped(f.scope);
				let forks = 0;
				const runner = Object.assign(f.runner, {
					async forkManagedSuccessor(input: ManagedSuccessorInput) {
						await input.onInvoking?.();
						forks += 1;
						const managedAuthority = { ...input.target, sessionId: "branch-target", generation: 2 };
						await input.onAcknowledged?.(managedAuthority);
						if (phase === "fork") await waitAtPhase();
						const successor = { tenant: managedAuthority, generation: 2, isCurrent: () => true };
						await input.publish(successor);
						return { successor, managedAuthority, operationHash: input.source.requestKey };
					},
				});
				const transaction = runner.withLifecyclePublication.bind(runner);
				runner.withLifecyclePublication = async (address, effect) => {
					if (phase === "transaction") await waitAtPhase();
					return transaction(address, async lifecycle => {
						const publish = lifecycle.publishManaged.bind(lifecycle);
						lifecycle.publishManaged = async (proof, write) => {
							if (phase === "publication") await waitAtPhase();
							return publish(proof, write);
						};
						return effect(lifecycle);
					});
				};
				const state = runner.getState.bind(runner);
				runner.getState = async input => {
					const result = await state(input);
					if (phase === "state") await waitAtPhase();
					return result;
				};
				const prompt = runner.continueSession.bind(runner);
				runner.continueSession = async input => {
					const result = await prompt(input);
					if (phase === "prompt") await waitAtPhase();
					return result;
				};
				const gateway = () =>
					createGjcRoutingLiveGatewayRunner({ turnRunner: runner, mappings: f.store, turnTimeoutMs: 2_000 });
				await expect(gateway().run(branchTurn())).rejects.toMatchObject({ code: "timeout" });
				expect(reachedPhase).toBe(true);
				const bytes = readFileSync(f.file);
				const stateCount = runner.states.length;
				const promptCount = runner.continues.length;
				release();
				await new Promise(resolve => setTimeout(resolve, 0));
				expect(runner.states).toHaveLength(stateCount);
				expect(runner.continues).toHaveLength(promptCount);
				expect(readFileSync(f.file).equals(bytes)).toBe(true);
				f.reopen();
				const receipt = f.store.operationScoped(f.scope, "branch-1")!;
				expect(receipt.state).toBe("uncertain");
				expect(receipt.acknowledgedSuccessor?.sessionId).toBe("branch-target");
				expect(receipt.lifecycle?.state).toBe(phase === "fork" ? "uncertain" : "active_generation_proven");
				expect(receipt.result).toBeUndefined();
				expect(f.store.getScoped(f.scope)).toEqual(originalMapping);
				await expect(gateway().run(branchTurn())).rejects.toThrow("requires reconciliation");
				expect(forks).toBe(1);
			} finally {
				release();
				f.close();
			}
		},
	);

	test("branch fork, state and prompt consume the same configured budget", async () => {
		const f = fixture();
		try {
			await routeGjcTurn(f.input());
			let now = Date.now();
			const clock = spyOn(Date, "now").mockImplementation(() => now);
			let forkTimeout: number | undefined;
			const runner = Object.assign(f.runner, {
				async forkManagedSuccessor(input: ManagedSuccessorInput) {
					forkTimeout = input.timeoutMs;
					await input.onInvoking?.();
					now += 400;
					const managedAuthority = { ...input.target, sessionId: "branch-target", generation: 2 };
					await input.onAcknowledged?.(managedAuthority);
					const successor = { tenant: managedAuthority, generation: 2, isCurrent: () => true };
					await input.publish(successor);
					return { successor, managedAuthority, operationHash: input.source.requestKey };
				},
			});
			const state = runner.getState.bind(runner);
			runner.getState = async input => {
				now += 300;
				return state(input);
			};
			const prompt = runner.continueSession.bind(runner);
			runner.continueSession = async input => {
				now += 400;
				return prompt(input);
			};
			try {
				await expect(
					createGjcRoutingLiveGatewayRunner({ turnRunner: runner, mappings: f.store, turnTimeoutMs: 1_000 }).run(
						branchTurn(),
					),
				).rejects.toMatchObject({ code: "timeout" });
				expect(forkTimeout).toBe(1_000);
				expect(runner.continues[0]?.timeoutMs).toBe(300);
				expect(() => runner.continues[0]?.beforeDispatch?.()).toThrow("timed out");
				expect(f.store.operationScoped(f.scope, "branch-1")?.state).toBe("uncertain");
				expect(f.store.getScoped(f.scope)?.sessionId).toBe("session-1");
			} finally {
				clock.mockRestore();
			}
		} finally {
			f.close();
		}
	});

	test("reopens acknowledged branch failure without repeating fork or prompt", async () => {
		const f = fixture();
		try {
			await routeGjcTurn(f.input());
			let forks = 0;
			const runner = Object.assign(f.runner, {
				async forkManagedSuccessor(input: ManagedSuccessorInput): Promise<never> {
					await input.onInvoking?.();
					forks += 1;
					await input.onAcknowledged?.({ ...input.target, sessionId: "acknowledged-target", generation: 9 });
					throw new Error("interrupted after durable acknowledgement");
				},
			});
			const gateway = () => createGjcRoutingLiveGatewayRunner({ turnRunner: runner, mappings: f.store });
			await expect(gateway().run(branchTurn())).rejects.toThrow("interrupted after durable acknowledgement");
			f.reopen();
			const prior = f.store.operationScoped(f.scope, "branch-1");
			expect(prior).toMatchObject({
				state: "uncertain",
				kind: "branch",
				lifecycle: { state: "uncertain", acknowledged: { sessionId: "acknowledged-target", generation: 9 } },
				acknowledgedSuccessor: { sessionId: "acknowledged-target", managedAuthority: { generation: 9 } },
			});
			expect(f.store.getScoped(f.scope)?.sessionId).toBe("session-1");
			const bytes = readFileSync(f.file, "utf8");
			await expect(gateway().run(branchTurn())).rejects.toThrow("requires reconciliation");
			await expect(gateway().run({ ...branchTurn(), prompt: "changed payload" })).rejects.toThrow();
			expect(readFileSync(f.file, "utf8")).toBe(bytes);
			expect(forks).toBe(1);
			expect(runner.states).toHaveLength(0);
			expect(runner.continues).toHaveLength(0);
		} finally {
			f.close();
		}
	});

	test.each(["sessionId", "generation", "leaseId", "requestKey"] as const)(
		"retains the admitted fork receipt after predecessor %s changes without publishing it",
		async field => {
			const f = fixture();
			try {
				await routeGjcTurn(f.input());
				const original = f.store.getScoped(f.scope)!;
				const replacementAuthority = {
					...original.managedAuthority!,
					[field]: field === "generation" ? 3 : "replacement",
				};
				let forks = 0;
				let adopted = false;
				let acknowledged: ManagedTurnAuthority | undefined;
				const runner = Object.assign(f.runner, {
					async forkManagedSuccessor(input: ManagedSuccessorInput): Promise<never> {
						await input.onInvoking?.();
						forks += 1;
						f.store.setScoped(f.scope, {
							...original,
							sessionId: replacementAuthority.sessionId,
							managedAuthority: replacementAuthority,
						});
						acknowledged = { ...input.target, sessionId: "acknowledged-target", generation: 9 };
						await input.onAcknowledged?.(acknowledged);
						adopted = true;
						throw new Error("replacement must deny adoption");
					},
				});
				const gateway = () => createGjcRoutingLiveGatewayRunner({ turnRunner: runner, mappings: f.store });
				await expect(gateway().run(branchTurn())).rejects.toThrow(
					field === "sessionId" ? "branch_predecessor_replaced" : "authority changed",
				);
				const receipt = f.store.operationScoped(f.scope, "branch-1")!;
				expect(receipt.state).toBe("uncertain");
				expect(receipt.lifecycle?.state).toBe("uncertain");
				expect(receipt.lifecycle?.acknowledged).toEqual(lifecycleExactAuthority(acknowledged!));
				expect(receipt.acknowledgedSuccessor).toEqual({
					sessionId: acknowledged!.sessionId,
					managedAuthority: acknowledged!,
				});
				expect(receipt.lifecycle?.proven).toBeUndefined();
				expect(receipt.result).toBeUndefined();
				f.reopen();
				expect(f.store.operationScoped(f.scope, "branch-1")).toEqual(receipt);
				expect(f.store.getScoped(f.scope)?.managedAuthority).toEqual(replacementAuthority);
				const bytes = readFileSync(f.file);
				await expect(gateway().run(branchTurn())).rejects.toThrow("requires reconciliation");
				await expect(gateway().run({ ...branchTurn(), prompt: "changed payload" })).rejects.toThrow();
				expect(readFileSync(f.file).equals(bytes)).toBe(true);
				expect(forks).toBe(1);
				expect(adopted).toBe(false);
				expect(runner.states).toHaveLength(0);
				expect(runner.continues).toHaveLength(0);
			} finally {
				f.close();
			}
		},
	);

	test("rejects predecessor replacement before the fork invocation callback", async () => {
		const f = fixture();
		try {
			await routeGjcTurn(f.input());
			const original = f.store.getScoped(f.scope)!;
			let forks = 0;
			const runner = Object.assign(f.runner, {
				async forkManagedSuccessor(input: ManagedSuccessorInput): Promise<never> {
					f.store.setScoped(f.scope, {
						...original,
						sessionId: "replacement",
						managedAuthority: { ...original.managedAuthority!, sessionId: "replacement" },
					});
					await input.onInvoking?.();
					forks += 1;
					throw new Error("replacement must deny dispatch");
				},
			});
			const gateway = createGjcRoutingLiveGatewayRunner({ turnRunner: runner, mappings: f.store });
			await expect(gateway.run(branchTurn())).rejects.toThrow("branch_predecessor_replaced");
			f.reopen();
			const receipt = f.store.operationScoped(f.scope, "branch-1")!;
			expect(receipt.lifecycle?.state).toBe("intent_prepared");
			expect(receipt.lifecycle?.acknowledged).toBeUndefined();
			expect(receipt.acknowledgedSuccessor).toBeUndefined();
			expect(forks).toBe(0);
			expect(runner.states).toHaveLength(0);
			expect(runner.continues).toHaveLength(0);
		} finally {
			f.close();
		}
	});

	test("rejects pre-aborted branch before intent and lifecycle dispatch", async () => {
		const f = fixture();
		try {
			await routeGjcTurn(f.input());
			let forks = 0;
			const runner = Object.assign(f.runner, {
				async forkManagedSuccessor(): Promise<never> {
					forks += 1;
					throw new Error("unexpected fork");
				},
			});
			const controller = new AbortController();
			controller.abort();
			const gateway = createGjcRoutingLiveGatewayRunner({ turnRunner: runner, mappings: f.store });
			await expect(gateway.run({ ...branchTurn(), signal: controller.signal })).rejects.toBeInstanceOf(
				GjcTurnCancelledError,
			);
			expect(forks).toBe(0);
			expect(f.store.operationScoped(f.scope, "branch-1")).toBeUndefined();
		} finally {
			f.close();
		}
	});

	test("binds before publishing and replays immutable events across restart and later turns", async () => {
		const f = fixture();
		try {
			const first = await routeGjcTurn(f.input());
			expect(first.assistantText).toBe("new:hello");
			expect(f.store.provisionalOperationScoped(f.scope, "user-1")).toMatchObject({
				state: "complete",
				kind: "create",
				sessionId: "session-1",
			});
			expect(first.mapping.managedAuthority).toMatchObject({ ...f.scope, generation: 1 });
			f.reopen();
			const replay = await routeGjcTurn(f.input());
			expect(replay.events).toEqual(first.events);
			expect(f.runner.managedStarts).toHaveLength(1);
			f.runner.events = [{ type: "assistant", text: "later event" }];
			const later = await routeGjcTurn(f.input("user-2", "continue"));
			expect(later.assistantText).toBe("continued:continue");
			expect(f.runner.continues[0]?.sessionFile).toBeUndefined();
			expect(f.runner.states[0]?.recoveryAttachment).toBeUndefined();
			f.reopen();
			const count = f.published.length;
			expect((await routeGjcTurn(f.input())).events).toEqual(first.events);
			expect(f.published).toHaveLength(count);
			expect(f.runner.continues).toHaveLength(1);
			expect(f.store.getScoped(f.scope)?.operationId).toBe("user-2");
			const bytes = readFileSync(f.file, "utf8");
			for (const field of ["sessionFile", "descriptor", "attachment", "tmuxPane"])
				expect(bytes).not.toContain(`"${field}"`);
		} finally {
			f.close();
		}
	});

	test("requires matching prepared tenant before initial reservation or remote effect", async () => {
		const f = fixture();
		try {
			for (const changed of [
				{ principalId: "foreign" },
				{ projectId: "foreign" },
				{ canonicalWorkspace: "/foreign" },
				{ chatId: "foreign" },
				{ requestKey: "other-ingress" },
				{ leaseId: "" },
				{ epoch: "" },
			]) {
				await expect(
					routeGjcTurn({ ...f.input(), preparedManagedAuthority: managedPreparedAuthority(changed) }),
				).rejects.toThrow();
				expect(f.store.provisionalOperationScoped(f.scope, "user-1")).toBeUndefined();
			}
			expect(f.runner.managedStarts).toHaveLength(0);
		} finally {
			f.close();
		}
	});

	test("retains uncertain initial effect and rejects restart retries without rediscovery", async () => {
		const f = fixture();
		try {
			f.runner.completionError = new Error("effect failed");
			await expect(routeGjcTurn(f.input())).rejects.toThrow("effect failed");
			f.reopen();
			expect(f.store.getScoped(f.scope)).toBeUndefined();
			expect(f.store.provisionalOperationScoped(f.scope, "user-1")).toMatchObject({
				state: "uncertain",
				sessionId: "session-1",
			});
			const bytes = readFileSync(f.file, "utf8");
			await expect(routeGjcTurn(f.input())).rejects.toThrow("requires reconciliation");
			await expect(routeGjcTurn(f.input("user-1", "different"))).rejects.toThrow("different ingress payload");
			expect(f.runner.managedStarts).toHaveLength(1);
			expect(f.runner.states).toHaveLength(0);
			expect(readFileSync(f.file, "utf8")).toBe(bytes);
		} finally {
			f.close();
		}
	});

	test.each(["principalId", "sessionId", "generation", "leaseId", "epoch", "requestKey"] as const)(
		"rejects changed continuation %s before remote effect",
		async field => {
			const f = fixture();
			try {
				await routeGjcTurn(f.input());
				const authority = f.store.getScoped(f.scope)!.managedAuthority!;
				const bytes = readFileSync(f.file, "utf8");
				await expect(
					routeGjcTurn({
						...f.input("user-2"),
						managedAuthority: { ...authority, [field]: field === "generation" ? 2 : "foreign" },
					}),
				).rejects.toThrow();
				expect(f.runner.states).toHaveLength(0);
				expect(readFileSync(f.file, "utf8")).toBe(bytes);
			} finally {
				f.close();
			}
		},
	);

	test("rejects result authority substitution and retains dispatched uncertainty", async () => {
		const f = fixture();
		try {
			await routeGjcTurn(f.input());
			const original = f.runner.continueSession.bind(f.runner);
			f.runner.continueSession = async input => {
				const result = await original(input);
				return {
					...result,
					managedAuthority: { ...result.managedAuthority!, leaseId: "substituted" } as ManagedTurnAuthority,
				};
			};
			await expect(routeGjcTurn(f.input("user-2"))).rejects.toThrow("does not match persisted authority");
			f.reopen();
			expect(f.store.getScoped(f.scope)?.operationId).toBe("user-1");
			expect(f.store.operationScoped(f.scope, "user-2")?.state).toBe("uncertain");
			expect(f.published).toEqual(["user-1"]);
		} finally {
			f.close();
		}
	});

	test.each([false, true])("classifies continuation cancellation with dispatch=%s", async dispatched => {
		const f = fixture();
		try {
			await routeGjcTurn(f.input());
			const original = f.runner.continueSession.bind(f.runner);
			f.runner.continueSession = async input => {
				if (dispatched) input.onDispatch?.();
				throw new GjcTurnCancelledError();
			};
			await expect(routeGjcTurn(f.input("user-2"))).rejects.toBeInstanceOf(GjcTurnCancelledError);
			f.reopen();
			expect(f.store.operationScoped(f.scope, "user-2")?.state).toBe(dispatched ? "uncertain" : undefined);
			f.runner.continueSession = original;
			if (dispatched) await expect(routeGjcTurn(f.input("user-2"))).rejects.toThrow("requires reconciliation");
			else expect((await routeGjcTurn(f.input("user-2"))).assistantText).toBe("continued:hello");
		} finally {
			f.close();
		}
	});
});

function branchTurn(id = "branch-1"): LiveGatewayRunnerInput {
	return {
		project,
		prompt: "branch prompt",
		chatId: "chat-1",
		messageId: id,
		userMessageId: id,
		userMessageParentId: "user-1",
		continued: true,
		ownerUserId: "owner-test",
		control: { operation: "branch" },
	};
}

function lifecycleTurn(operation: "session.new" | "session.resume"): LiveGatewayRunnerInput {
	return {
		...branchTurn(`control-${operation}`),
		prompt: "",
		control: operation === "session.new" ? { operation } : { operation, sessionId: "session-1" },
	};
}
function controlAuthority(owner: ManagedLifecycleControlOwner): ManagedTurnAuthority {
	return {
		...owner.source,
		sessionId: owner.operation === "session.create" ? "control-successor" : owner.source.sessionId,
		generation: owner.operation === "session.create" ? 2 : owner.source.generation,
	};
}
function controlResult(authority: ManagedTurnAuthority) {
	return {
		sessionId: authority.sessionId,
		result: {
			text: "",
			events: [],
			rawFrameCursor: 0,
			eventCursor: 0,
			managedAuthority: authority,
			managedProof: {
				kind: "managed-generation" as const,
				sessionId: authority.sessionId,
				generation: authority.generation,
				leaseId: authority.leaseId,
				epoch: authority.epoch,
			},
		},
	};
}
