import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManagedSdkAttachment } from "../src/gjc/managed-sdk-runtime";
import { routeGjcTurn } from "../src/gjc/session-turn-router";
import { SessionV3FileBackedMappingStore } from "../src/gjc/session-v3-file-backed-mapping-store";
import { GjcTurnCancelledError, type ManagedTurnAuthority } from "../src/gjc/turn-runner";
import type { LiveGatewayRunnerInput } from "../src/live/chat-completions";
import { createManagedV3GenerationStore } from "../src/live/gjc-managed-idle-reaper";
import type { ManagedSuccessorInput } from "../src/live/gjc-managed-successor";
import { createGjcRoutingLiveGatewayRunner } from "../src/live/gjc-routing-gateway";
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
	test("does not route a retired generation awaiting local cleanup after restart", async () => {
		const f = fixture();
		try {
			await routeGjcTurn(f.input());
			const records = createManagedV3GenerationStore(f.store);
			const record = (await records.active())[0]!;
			const intent = { key: "retirement", authority: record.authority, requestedAt: Date.now() };
			expect(await records.prepareClose(record, intent)).toBe(true);
			await records.retire(record, intent);
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

	test("reopens acknowledged branch failure without repeating fork or prompt", async () => {
		const f = fixture();
		try {
			await routeGjcTurn(f.input());
			let forks = 0;
			const runner = Object.assign(f.runner, {
				async forkManagedSuccessor(input: ManagedSuccessorInput): Promise<never> {
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
