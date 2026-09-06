import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionV3FileBackedMappingStore } from "../src/gjc/session-v3-file-backed-mapping-store";

const scope = { principalId: "owner", chatId: "chat" };
const authority = (sessionId: string, generation: number) => ({
	...scope,
	projectId: "project",
	canonicalWorkspace: "/workspace/project",
	sessionId,
	generation,
	leaseId: `lease-${generation}`,
	epoch: `runtime-${generation}`,
	requestKey: `request-${generation}`,
});
const mapping = (sessionId: string, generation: number, operationId: string) => ({
	...scope,
	projectId: "project",
	sessionId,
	rawFrameCursor: 0,
	eventCursor: 0,
	operationId,
	managedAuthority: authority(sessionId, generation),
});

describe("managed successor restart reconciliation", () => {
	test("publishes a bound initial create reservation as an immutable prompt result", () => {
		const root = mkdtempSync(join(tmpdir(), "gjc-managed-create-receipt-"));
		const file = join(root, "authority.json");
		let store = new SessionV3FileBackedMappingStore(file);
		const operation = {
			id: "initial",
			ingressId: "initial",
			kind: "create" as const,
			detail: "hash",
			chatId: scope.chatId,
			projectId: "project",
		};
		try {
			store.reserveProvisionalOperationScoped(scope, operation);
			store.attachProvisionalOperationScoped(scope, operation.id, {
				sessionId: "created",
				managedAuthority: authority("created", 1),
			});
			store.publishProvisionalOperationScoped(scope, operation, mapping("created", 1, operation.id));
			store.close();
			store = new SessionV3FileBackedMappingStore(file);
			expect(store.provisionalOperationScoped(scope, operation.id)).toMatchObject({
				state: "complete",
				kind: "create",
				managedAuthority: authority("created", 1),
			});
			expect(store.operationScoped(scope, operation.id)).toMatchObject({
				state: "complete",
				kind: "prompt",
				result: { managedAuthority: authority("created", 1) },
			});
		} finally {
			store.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	test.each(["create", "branch"] as const)(
		"completes acknowledged %s using only the original exact managed proof",
		kind => {
			const root = mkdtempSync(join(tmpdir(), "gjc-managed-successor-restart-"));
			const file = join(root, "authority.json");
			let store = new SessionV3FileBackedMappingStore(file);
			try {
				store.setScoped(scope, mapping("source", 1, "initial"));
				store.beginOperationScoped(scope, { id: "successor", kind, detail: "hash" });
				store.recordAcknowledgedSuccessorScoped(scope, "successor", "hash", {
					sessionId: "target",
					managedAuthority: authority("target", 2),
				});
				store.close();
				store = new SessionV3FileBackedMappingStore(file);
				expect(store.operationScoped(scope, "successor")?.state).toBe("uncertain");
				expect(store.operationScoped(scope, "successor")?.acknowledgedSuccessor).toMatchObject({
					sessionId: "target",
					managedAuthority: authority("target", 2),
				});
				const before = readFileSync(file, "utf8");
				const target = mapping("target", 2, "successor");
				for (const substitution of [
					{ principalId: "foreign" },
					{ sessionId: "replacement" },
					{ generation: 3 },
					{ leaseId: "other" },
					{ epoch: "runtime-other" },
					{ requestKey: "new-request" },
				]) {
					expect(() =>
						store.completeOperationWithMappingScoped(
							scope,
							"successor",
							"hash",
							{
								...target,
								managedAuthority: { ...target.managedAuthority, ...substitution },
							},
							"control",
						),
					).toThrow();
					expect(readFileSync(file, "utf8")).toBe(before);
				}
				expect(() =>
					store.completeOperationWithMappingScoped(scope, "successor", "wrong-hash", target, "control"),
				).toThrow();
				store.completeOperationWithMappingScoped(scope, "successor", "hash", target, "control");
				store.close();
				store = new SessionV3FileBackedMappingStore(file);
				expect(store.getScoped(scope)).toMatchObject({
					sessionId: "target",
					managedAuthority: authority("target", 2),
				});
				expect(store.operationScoped(scope, "successor")).toMatchObject({
					state: "complete",
					result: { managedAuthority: authority("target", 2) },
				});
				expect(store.operationScoped(scope, "successor")?.acknowledgedSuccessor).toBeUndefined();
				expect(readFileSync(file, "utf8")).not.toContain("sessionFile");
			} finally {
				store.close();
				rmSync(root, { recursive: true, force: true });
			}
		},
	);
});
