import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routeGjcTurn } from "../src/gjc/session-turn-router";
import { SessionV3FileBackedMappingStore } from "../src/gjc/session-v3-file-backed-mapping-store";
import { GjcTurnCancelledError, type ManagedTurnAuthority } from "../src/gjc/turn-runner";
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
