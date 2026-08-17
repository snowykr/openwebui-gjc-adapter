import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GjcRuntimeLocations, NormalizedModelSelection } from "../src/contracts";
import type { PublicSdkSessionPort } from "../src/gjc/public-sdk-contract";
import { PublicSdkSessionClient } from "../src/gjc/public-sdk-session-port";
import {
	AUTHORITY_BOOT_COMPACTION_THRESHOLD_BYTES,
	FileSessionAuthority,
	findGenerationOffset,
	SessionAuthorityDurabilityError,
} from "../src/gjc/session-authority-persistence";
import type { ProvisionalSessionOperation, SessionAuthorityRecord } from "../src/gjc/session-authority-types";
import {
	FileBackedSessionMappingStore,
	normalizeModelSelection,
	type SessionMapping,
	SessionMappingStore,
} from "../src/gjc/session-router";
import type {
	GjcControlResult,
	GjcLifecyclePublicationAddress,
	GjcLifecycleTestBarrierHook,
	GjcLifecycleTransaction,
	GjcTurnRunner,
} from "../src/gjc/turn-runner";
import type { LiveGatewayRunnerInput } from "../src/live/chat-completions";
import { createGjcRoutingLiveGatewayRunner, createPublicSdkGjcTurnRunner } from "../src/live/gjc-routing-runner";
import { synthesizeProjectionRows } from "../src/live/workflow-gate-projection";
import { buildSessionMappingPayloadHash } from "../src/live/workflow-gate-turns";
import { InMemoryOutboxStore } from "../src/state/outbox";
import { buildProjectionPayloadHash, streamEscapedJsonString, streamPlainJson } from "../src/state/outbox-json";
import { attachmentProof } from "./gjc-lifecycle-fixtures";
import { FakeGjcTurnRunner, project } from "./gjc-routing-runner-fixtures";
import type { SdkFixtureScenario, SdkFixtureServer } from "./gjc-sdk-v3-fixture-types";
import { expectSdkRequest, startSdkFixtureServer } from "./gjc-sdk-v3-fixtures";
import { staticModelReaderFactory } from "./model-selection-fixtures";

describe("createGjcRoutingLiveGatewayRunner persistence", () => {
	test("persists mappings across file-backed store instances", () => {
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-mapping-")), "mappings.json");
		const first = new FileBackedSessionMappingStore(filePath);
		first.set({
			chatId: "chat-1",
			projectId: project.id,
			sessionId: "session-1",
			sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
			activeLeaf: "leaf-1",
			rawFrameCursor: 7,
			eventCursor: 3,
			operationId: "user-1",
			assistantText: "new:hello",
			events: [{ type: "assistant", text: "new:hello" }],
		});

		const second = new FileBackedSessionMappingStore(filePath);
		expect(second.get("chat-1")).toEqual(first.get("chat-1"));
	});
	test("restores source authority after a failed destination turn and restart", async () => {
		const directory = mkdtempSync(join(tmpdir(), "gjc-reassignment-failure-"));
		const filePath = join(directory, "mappings.json");
		const projectB = { ...project, id: "project-b", cwd: "/workspace/project-b" };
		try {
			const mappings = new FileBackedSessionMappingStore(filePath);
			mappings.set({
				chatId: "chat-reassignment-failure",
				projectId: project.id,
				sessionId: "session-a",
				sessionFile: "/workspace/project/.gjc/sessions/session-a.jsonl",
				operationId: "operation-a",
				rawFrameCursor: 1,
				eventCursor: 1,
			});
			const failingRunner = new FakeGjcTurnRunner();
			failingRunner.completionError = new Error("destination start failed");
			const gateway = createGjcRoutingLiveGatewayRunner({ turnRunner: failingRunner, mappings });
			await expect(
				gateway.run({
					project: projectB,
					prompt: "move to B",
					chatId: "chat-reassignment-failure",
					messageId: "assistant-b",
					userMessageId: "operation-b",
					userMessageParentId: "operation-a",
					continued: true,
				}),
			).rejects.toThrow("destination start failed");

			const restarted = new FileBackedSessionMappingStore(filePath);
			expect(restarted.get("chat-reassignment-failure")).toMatchObject({
				projectId: project.id,
				sessionId: "session-a",
			});
			expect(restarted.provisionalOperation("chat-reassignment-failure", "operation-b")).toMatchObject({
				projectId: projectB.id,
				state: "uncertain",
			});
			const retryRunner = new FakeGjcTurnRunner();
			await expect(
				createGjcRoutingLiveGatewayRunner({ turnRunner: retryRunner, mappings: restarted }).run({
					project: projectB,
					prompt: "retry move",
					chatId: "chat-reassignment-failure",
					messageId: "assistant-b-retry",
					userMessageId: "operation-b",
					userMessageParentId: "operation-a",
					continued: true,
				}),
			).rejects.toThrow();
			expect(retryRunner.starts).toHaveLength(0);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	test("surfaces a reassignment rollback persistence failure", async () => {
		class RollbackFailingMappings extends SessionMappingStore {
			override rollbackProjectReassignment(): void {
				throw new Error("rollback persistence failed");
			}
		}

		const mappings = new RollbackFailingMappings();
		const projectB = { ...project, id: "project-b", cwd: "/workspace/project-b" };
		mappings.set({
			chatId: "chat-rollback-failure",
			projectId: project.id,
			sessionId: "session-a",
			sessionFile: "/workspace/project/.gjc/sessions/session-a.jsonl",
			operationId: "operation-a",
			rawFrameCursor: 1,
			eventCursor: 1,
		});
		const runner = new FakeGjcTurnRunner();
		runner.completionError = new Error("destination start failed");

		await expect(
			createGjcRoutingLiveGatewayRunner({ turnRunner: runner, mappings }).run({
				project: projectB,
				prompt: "move to B",
				chatId: "chat-rollback-failure",
				messageId: "assistant-b",
				userMessageId: "operation-b",
				userMessageParentId: "operation-a",
				continued: true,
			}),
		).rejects.toThrow("Failed to roll back project reassignment for chat chat-rollback-failure.");
	});

	test("retains retired source identity fences after destination commit and restart", async () => {
		const directory = mkdtempSync(join(tmpdir(), "gjc-reassignment-commit-"));
		const filePath = join(directory, "mappings.json");
		const projectB = { ...project, id: "project-b", cwd: "/workspace/project-b" };
		try {
			const mappings = new FileBackedSessionMappingStore(filePath);
			mappings.set({
				chatId: "chat-reassignment-commit",
				projectId: project.id,
				sessionId: "session-a",
				sessionFile: "/workspace/project/.gjc/sessions/session-a.jsonl",
				operationId: "operation-a",
				rawFrameCursor: 1,
				eventCursor: 1,
			});
			mappings.beginOperation("chat-reassignment-commit", {
				id: "stale-operation-a",
				kind: "prompt",
				detail: "source request",
			});
			mappings.transitionOperation("chat-reassignment-commit", "stale-operation-a", "complete", "source request", {
				kind: "turn",
				assistantText: "source result",
				events: [],
				mapping: {
					chatId: "chat-reassignment-commit",
					projectId: project.id,
					sessionId: "session-a",
					rawFrameCursor: 1,
					eventCursor: 1,
					operationId: "stale-operation-a",
				},
			});
			mappings.reserveProvisionalOperation({
				chatId: "chat-reassignment-commit",
				projectId: project.id,
				id: "stale-provisional-a",
				ingressId: "stale-provisional-ingress-a",
				kind: "create",
				detail: "source provisional",
			});
			mappings.transitionProvisionalOperation("chat-reassignment-commit", "stale-provisional-ingress-a", "complete");
			await createGjcRoutingLiveGatewayRunner({
				turnRunner: new FakeGjcTurnRunner(),
				mappings,
			}).run({
				project: projectB,
				prompt: "move to B",
				chatId: "chat-reassignment-commit",
				messageId: "assistant-b",
				userMessageId: "operation-b",
				userMessageParentId: "operation-a",
				continued: true,
			});

			const restarted = new FileBackedSessionMappingStore(filePath);
			const retryRunner = new FakeGjcTurnRunner();
			const gateway = createGjcRoutingLiveGatewayRunner({ turnRunner: retryRunner, mappings: restarted });
			for (const staleOperationId of ["stale-operation-a", "stale-provisional-a"])
				for (const retryProject of [projectB, project])
					await expect(
						gateway.run({
							project: retryProject,
							prompt: "stale source retry",
							chatId: "chat-reassignment-commit",
							messageId: `assistant-${staleOperationId}-${retryProject.id}`,
							userMessageId: staleOperationId,
							userMessageParentId: null,
							continued: false,
						}),
					).rejects.toThrow("not authorized");
			expect(restarted.get("chat-reassignment-commit")?.projectId).toBe(projectB.id);
			expect(retryRunner.starts).toHaveLength(0);
			expect(retryRunner.switches).toHaveLength(0);
			expect(retryRunner.continues).toHaveLength(0);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	test("isolates nested authority events and observations from insert and read mutations", () => {
		withFileStore((_store, filePath) => {
			const input = {
				...mappingInput(mediumSelection),
				events: [{ type: "assistant", payload: { nested: { value: "original" } } }],
				observations: { state: { value: "original" } },
			};
			const authority = new FileSessionAuthority(filePath);
			const stored = authority.set(input);
			input.events[0].payload.nested.value = "mutated-input";
			input.observations.state.value = "mutated-input";

			const eventPayload = stored.events?.[0]?.payload;
			const observation = stored.observations?.state;
			const eventNested = eventPayload === undefined ? undefined : Reflect.get(eventPayload, "nested");
			if (
				typeof eventNested !== "object" ||
				eventNested === null ||
				typeof observation !== "object" ||
				observation === null
			)
				throw new Error("Expected nested authority values.");
			Reflect.set(eventNested, "value", "mutated-read");
			Reflect.set(observation, "value", "mutated-read");

			expect(authority.get("chat-1")).toMatchObject({
				events: [{ payload: { nested: { value: "original" } } }],
				observations: { state: { value: "original" } },
			});
			expect(new FileSessionAuthority(filePath).get("chat-1")).toMatchObject({
				events: [{ payload: { nested: { value: "original" } } }],
				observations: { state: { value: "original" } },
			});
		});
	});
	test("persists short reassignment aliases", () => {
		const directory = mkdtempSync(join(tmpdir(), "gjc-reassignment-alias-"));
		const filePath = join(directory, "authority.json");
		try {
			const authority = new FileSessionAuthority(filePath);
			authority.set(mappingInput(mediumSelection));
			authority.beginReassignment("chat-1", project.id, "project-b");
			expect(readAuthorityMerged(filePath).mappings[0].reassignment).toMatchObject({
				state: "pending",
				targetProjectId: "project-b",
			});

			authority.rollbackReassignment("chat-1", project.id);
			expect(readAuthorityMerged(filePath).mappings[0].reassignment).toMatchObject({
				state: "rolled_back",
				targetProjectId: "project-b",
			});
			expect(new FileSessionAuthority(filePath).get("chat-1")?.reassignment).toMatchObject({
				state: "rolled_back",
				targetProjectId: "project-b",
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	test("reloads under the mutation lock so two stores retain both interleaved writes", () => {
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-authority-interleave-")), "mappings.json");
		const first = new FileSessionAuthority(filePath);
		const second = new FileSessionAuthority(filePath);
		first.set(mappingInput(mediumSelection));
		second.set({ ...mappingInput(mediumSelection), chatId: "chat-2", operationId: "user-2" });

		expect(
			new FileSessionAuthority(filePath)
				.entries()
				.map(record => record.chatId)
				.sort(),
		).toEqual(["chat-1", "chat-2"]);
	});
	test.each(["open", "fsync", "close"])(
		"rolls back memory and boot state after an injected WAL append %s failure",
		phase => {
			const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-authority-failure-")), "mappings.json");
			const authority = new FailingFileSessionAuthority(filePath);
			authority.set(mappingInput(mediumSelection));
			authority.walFailure = new Error(`injected wal ${phase} failure`);

			expect(() =>
				authority.set({
					...mappingInput(mediumSelection),
					chatId: `${phase}-chat`,
					operationId: `${phase}-operation`,
				}),
			).toThrow(`injected wal ${phase} failure`);
			expect(authority.entries().map(record => record.chatId)).toEqual(["chat-1"]);
			expect(new FileSessionAuthority(filePath).entries().map(record => record.chatId)).toEqual(["chat-1"]);
		},
	);
	test("keeps a WAL-append mutation durable when a later compaction rewrite fails", () => {
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-authority-compaction-failure-")), "mappings.json");
		const authority = new FailingFileSessionAuthority(filePath);
		authority.set(mappingInput(mediumSelection));
		authority.set({ ...mappingInput(mediumSelection), chatId: "chat-2", operationId: "user-2" });
		authority.failure = new Error("injected compaction failure");

		expect(() => authority.forceCompaction()).toThrow("injected compaction failure");
		// the WAL still carries chat-2, so neither memory nor boot state loses it
		expect(
			authority
				.entries()
				.map(record => record.chatId)
				.sort(),
		).toEqual(["chat-1", "chat-2"]);
		expect(
			new FileSessionAuthority(filePath)
				.entries()
				.map(record => record.chatId)
				.sort(),
		).toEqual(["chat-1", "chat-2"]);
	});
	test("rolls back a compaction rewrite failure inside a mutation to the pre-mutation snapshot", () => {
		const filePath = join(
			mkdtempSync(join(tmpdir(), "gjc-session-authority-compaction-mutation-failure-")),
			"mappings.json",
		);
		const authority = new CompactionFailingFileSessionAuthority(filePath);
		authority.set(mappingInput(mediumSelection));
		authority.set({ ...mappingInput(mediumSelection), chatId: "chat-2", operationId: "user-2" });
		authority.failure = new Error("injected compaction failure");
		const candidate = authority.set({ ...mappingInput(mediumSelection), chatId: "chat-3", operationId: "user-3" });

		expect(() => authority.replaceAllDuringMutation([candidate], [])).toThrow("injected compaction failure");
		// memory rolls back to the snapshot taken at mutation entry (chat-1..chat-3),
		// and the WAL still carries chat-2 and chat-3, so boot state matches
		expect(
			authority
				.entries()
				.map(record => record.chatId)
				.sort(),
		).toEqual(["chat-1", "chat-2", "chat-3"]);
		expect(
			new FileSessionAuthority(filePath)
				.entries()
				.map(record => record.chatId)
				.sort(),
		).toEqual(["chat-1", "chat-2", "chat-3"]);
	});
	test.each(["open", "fsync", "close"])("reloads visible authority after an injected directory %s failure", phase => {
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-authority-directory-failure-")), "mappings.json");
		const authority = new FailingFileSessionAuthority(filePath);
		authority.set(mappingInput(mediumSelection));
		authority.directoryFailure = new Error(`injected directory ${phase} failure`);

		let error: unknown;
		try {
			authority.set({
				...mappingInput(mediumSelection),
				chatId: `${phase}-chat`,
				operationId: `${phase}-operation`,
			});
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(SessionAuthorityDurabilityError);
		expect((error as Error & { cause?: unknown }).cause).toBe(authority.directoryFailure);
		expect(
			authority
				.entries()
				.map(record => record.chatId)
				.sort(),
		).toEqual(["chat-1", `${phase}-chat`]);
		expect(
			new FileSessionAuthority(filePath)
				.entries()
				.map(record => record.chatId)
				.sort(),
		).toEqual(["chat-1", `${phase}-chat`]);
	});
	class SmallThresholdFailingFileSessionAuthority extends FailingFileSessionAuthority {
		protected override walCompactionThresholdBytes = 1024;
	}
	class WALResetFailingFileSessionAuthority extends FailingFileSessionAuthority {
		syncCalls = 0;

		protected override syncDirectory(): void {
			this.syncCalls += 1;
			// The first call follows the successful rename inside persist(); the
			// second is resetWalFile's directory sync after the WAL truncation.
			if (this.syncCalls === 2 && this.failure !== undefined) throw this.failure;
			super.syncDirectory();
		}
	}
	class SmallThresholdWALResetFailingFileSessionAuthority extends WALResetFailingFileSessionAuthority {
		protected override walCompactionThresholdBytes = 1024;
	}
	class FailedRollbackFileSessionAuthority extends FailingFileSessionAuthority {
		readonly durabilityPath: string;
		postWriteFailure: Error | undefined;

		constructor(filePath: string) {
			super(filePath);
			this.durabilityPath = filePath;
		}

		protected override appendWal(
			records: readonly SessionAuthorityRecord[],
			provisional: readonly { readonly key: string; readonly operation: ProvisionalSessionOperation }[],
		): void {
			// walFailure stays unset so the real append runs; the failure is only
			// reported AFTER the complete delta was written and fsynced (e.g. a
			// failing close) with an unverifiable rollback, so the contract must
			// surface uncertain durability and retain the WAL-visible state.
			super.appendWal(records, provisional);
			if (this.postWriteFailure !== undefined) {
				this.postWriteFailure = new Error("injected rollback failure");
				throw new SessionAuthorityDurabilityError(this.durabilityPath, this.postWriteFailure);
			}
		}
	}

	const padding = "x".repeat(2048);
	test("surfaces uncertain durability when compaction fails after the WAL append", () => {
		const filePath = join(
			mkdtempSync(join(tmpdir(), "gjc-session-authority-wal-compaction-failure-")),
			"mappings.json",
		);
		const authority = new SmallThresholdFailingFileSessionAuthority(filePath);
		authority.set(mappingInput(mediumSelection));
		authority.failure = new Error("injected compaction failure");

		let error: unknown;
		try {
			authority.set({
				...mappingInput(mediumSelection),
				chatId: "chat-2",
				operationId: "user-2",
				assistantText: `${padding}turn-2`,
			});
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(SessionAuthorityDurabilityError);
		// The mutation was already WAL-committed; memory retains the WAL-visible
		// state instead of rolling back to a pre-mutation snapshot.
		expect(
			authority
				.entries()
				.map(record => record.chatId)
				.sort(),
		).toEqual(["chat-1", "chat-2"]);
		expect(
			new FileSessionAuthority(filePath)
				.entries()
				.map(record => record.chatId)
				.sort(),
		).toEqual(["chat-1", "chat-2"]);
	});
	test("treats a post-rewrite WAL reset failure as a durability error", () => {
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-authority-wal-reset-failure-")), "mappings.json");
		const authority = new SmallThresholdWALResetFailingFileSessionAuthority(filePath);
		authority.set(mappingInput(mediumSelection));
		authority.failure = new Error("injected WAL reset failure");

		let error: unknown;
		try {
			authority.set({
				...mappingInput(mediumSelection),
				chatId: "chat-2",
				operationId: "user-2",
				assistantText: `${padding}turn-2`,
			});
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(SessionAuthorityDurabilityError);
		// The base was renamed before the reset failure, so the mutation is
		// committed and memory retains it instead of rolling back.
		expect(
			authority
				.entries()
				.map(record => record.chatId)
				.sort(),
		).toEqual(["chat-1", "chat-2"]);
		expect(
			new FileSessionAuthority(filePath)
				.entries()
				.map(record => record.chatId)
				.sort(),
		).toEqual(["chat-1", "chat-2"]);
	});
	test("surfaces uncertain durability when WAL rollback recovery fails", () => {
		const filePath = join(
			mkdtempSync(join(tmpdir(), "gjc-session-authority-wal-rollback-failure-")),
			"mappings.json",
		);
		const authority = new FailedRollbackFileSessionAuthority(filePath);
		authority.set(mappingInput(mediumSelection));
		authority.postWriteFailure = new Error("injected append failure after a complete write");

		let error: unknown;
		try {
			authority.set({
				...mappingInput(mediumSelection),
				chatId: "chat-2",
				operationId: "user-2",
				assistantText: `${padding}turn-2`,
			});
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(SessionAuthorityDurabilityError);
		// The complete delta remains replayable; memory and boot both retain the
		// WAL-visible state so a retry cannot duplicate a committed operation.
		expect(
			authority
				.entries()
				.map(record => record.chatId)
				.sort(),
		).toEqual(["chat-1", "chat-2"]);
		expect(
			new FileSessionAuthority(filePath)
				.entries()
				.map(record => record.chatId)
				.sort(),
		).toEqual(["chat-1", "chat-2"]);
	});
	test("discards a stale WAL when the base is replaced with a same-size same-mtime document", () => {
		const filePath = join(
			mkdtempSync(join(tmpdir(), "gjc-session-authority-stale-wal-generation-")),
			"mappings.json",
		);
		const authority = new FileSessionAuthority(filePath);
		authority.set(mappingInput(mediumSelection));
		authority.set({ ...mappingInput(mediumSelection), chatId: "chat-2", operationId: "user-2" });
		expect(existsSync(`${filePath}.wal`)).toBe(true);

		// Replace the base with a same-size document whose mtime is preserved
		// (e.g. cp -p / restore tooling) but whose content and generation differ.
		const original = readFileSync(filePath, "utf8");
		const replaced = JSON.parse(original) as Record<string, unknown> & {
			mappings: { readonly chatId: string }[];
		};
		replaced.mappings = replaced.mappings.slice(0, 1);
		replaced.generation = "replacement-generation";
		const bytes = Buffer.from(`${JSON.stringify(replaced).padEnd(original.length - 1)}\n`, "utf8");
		expect(bytes.length).toBe(original.length);
		const mtimeMs = statSync(filePath).mtimeMs;
		writeFileSync(filePath, bytes);
		utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);

		// The stat identity is unchanged, but the generation differs: the stale
		// WAL must be discarded and the replacement must win.
		expect(
			new FileSessionAuthority(filePath)
				.entries()
				.map(record => record.chatId)
				.sort(),
		).toEqual(["chat-1"]);
	});
	test("reloads a live authority when the base generation changes behind its back", () => {
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-authority-live-generation-")), "mappings.json");
		const authority = new FileSessionAuthority(filePath);
		authority.set(mappingInput(mediumSelection));
		authority.set({ ...mappingInput(mediumSelection), chatId: "chat-2", operationId: "user-2" });
		expect(existsSync(`${filePath}.wal`)).toBe(true);

		// Swap the base behind the running instance's back with a same-size,
		// timestamp-preserved document carrying a different generation.
		const original = readFileSync(filePath, "utf8");
		const replaced = JSON.parse(original) as Record<string, unknown> & {
			mappings: { readonly chatId: string }[];
		};
		replaced.mappings = replaced.mappings.slice(0, 1);
		replaced.generation = "live-replacement-generation";
		const bytes = Buffer.from(`${JSON.stringify(replaced).padEnd(original.length - 1)}\n`, "utf8");
		expect(bytes.length).toBe(original.length);
		const mtimeMs = statSync(filePath).mtimeMs;
		writeFileSync(filePath, bytes);
		utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);

		// The next mutation must detect the generation change, reload, and append
		// under the replacement generation so the acknowledged mutation survives.
		authority.set({ ...mappingInput(mediumSelection), chatId: "chat-3", operationId: "user-3" });
		expect(
			new FileSessionAuthority(filePath)
				.entries()
				.map(record => record.chatId)
				.sort(),
		).toEqual(["chat-1", "chat-3"]);
	});
	test("reloads a live authority when the WAL is replaced with a same-size same-mtime document", () => {
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-authority-live-wal-swap-")), "mappings.json");
		const walPath = `${filePath}.wal`;
		const authority = new FileSessionAuthority(filePath);
		authority.set(mappingInput(mediumSelection));
		authority.set({ ...mappingInput(mediumSelection), chatId: "chat-2", operationId: "user-2" });
		expect(existsSync(walPath)).toBe(true);

		// Replace the WAL with different contents (the delta now names chat-9)
		// while preserving the byte length and the mtime: the final line's
		// embedded chain head no longer matches its body, so the per-append
		// authentication detects the replacement and fails closed instead of
		// silently appending against stale state.
		const original = readFileSync(walPath, "utf8");
		const replaced = original.replaceAll("chat-2", "chat-9");
		expect(replaced.length).toBe(original.length);
		const mtimeMs = statSync(walPath).mtimeMs;
		writeFileSync(walPath, replaced);
		utimesSync(walPath, mtimeMs / 1000, mtimeMs / 1000);

		expect(() =>
			authority.set({ ...mappingInput(mediumSelection), chatId: "chat-3", operationId: "user-3" }),
		).toThrow("chain is broken");
		expect(() => new FileSessionAuthority(filePath)).toThrow("chain is broken");
	});
	test("preserves events for an ambiguous legacy gate chain during compaction", () => {
		class SmallThresholdCompactingAuthority extends FileSessionAuthority {
			protected override walCompactionThresholdBytes = 1024;
		}
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-authority-legacy-gate-chain-")), "mappings.json");
		const authority = new SmallThresholdCompactingAuthority(filePath);
		authority.set(mappingInput(mediumSelection));
		// A legacy completed gate operation from a SEQUENTIAL chain: its events
		// begin with a gate accepted by an EARLIER operation, followed by the gate
		// this operation answered. The answered gate is ambiguous, so the events
		// must be preserved (not stripped and bound to the wrong gate).
		const legacyChainResult = {
			kind: "control" as const,
			assistantText: "gate answered",
			events: [
				{
					type: "workflow_gate",
					id: "gate-earlier",
					payload: {
						gateId: "gate-earlier",
						commandId: "c-e",
						turnId: "t-e",
						sessionId: "s-e",
						status: "accepted",
					},
				},
				{
					type: "workflow_gate",
					id: "gate-answered",
					payload: { gateId: "gate-answered", commandId: "c-a", turnId: "t-a", sessionId: "s-a" },
				},
			],
			mapping: {
				chatId: "chat-1",
				projectId: project.id,
				sessionId: "session-1",
				rawFrameCursor: 0,
				eventCursor: 0,
				operationId: "user-gate",
			},
		};
		authority.beginOperation("chat-1", { id: "user-gate", kind: "gate", detail: "gate-hash" });
		authority.transitionOperation("chat-1", "user-gate", "complete", "gate-hash", legacyChainResult);
		authority.set({
			...mappingInput(mediumSelection),
			chatId: "chat-1",
			operationId: "user-2",
			assistantText: `${padding}turn-2`,
		});

		const persisted = readFileSync(filePath, "utf8");
		// The ambiguous chain kept its events (the answered gate stays verifiable
		// by the legacy replay path) and no binding was synthesized.
		expect(persisted).toContain('"type":"workflow_gate"');
		expect(persisted).toContain('"gateId":"gate-answered"');
		expect(persisted).toContain('"gateId":"gate-earlier"');
	});
	test("preserves legacy gate evidence as a compact binding during compaction", () => {
		class SmallThresholdCompactingAuthority extends FileSessionAuthority {
			protected override walCompactionThresholdBytes = 1024;
		}
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-authority-legacy-gate-binding-")), "mappings.json");
		const authority = new SmallThresholdCompactingAuthority(filePath);
		authority.set(mappingInput(mediumSelection));
		// A legacy completed gate operation whose result carries the answered
		// gate event as its only evidence and has NO compact gate binding.
		const legacyGateResult = {
			kind: "control" as const,
			assistantText: "gate answered",
			events: [
				{
					type: "workflow_gate",
					id: "gate-1",
					payload: {
						gateId: "gate-1",
						commandId: "command-1",
						turnId: "turn-1",
						sessionId: "session-1",
					},
				},
			],
			mapping: {
				chatId: "chat-1",
				projectId: project.id,
				sessionId: "session-1",
				rawFrameCursor: 0,
				eventCursor: 0,
				operationId: "user-gate",
			},
		};
		authority.beginOperation("chat-1", { id: "user-gate", kind: "gate", detail: "gate-hash" });
		authority.transitionOperation("chat-1", "user-gate", "complete", "gate-hash", legacyGateResult);
		// A padded mutation crosses the small threshold and triggers compaction.
		authority.set({
			...mappingInput(mediumSelection),
			chatId: "chat-1",
			operationId: "user-2",
			assistantText: `${padding}turn-2`,
		});

		const persisted = readFileSync(filePath, "utf8");
		// The legacy gate op's events were stripped (the event type and its id are
		// gone) and a compact gate binding was synthesized in their place.
		expect(persisted).not.toContain('"type":"workflow_gate"');
		expect(persisted).toContain('"gateId":"gate-1"');
		expect(persisted).toContain('"commandId":"command-1"');
	});
	test("keeps the live fast path O(1) for generation-preserving base edits and discards the stale WAL at boot", () => {
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-authority-live-base-edit-")), "mappings.json");
		const walPath = `${filePath}.wal`;
		const authority = new FileSessionAuthority(filePath);
		authority.set(mappingInput(mediumSelection));
		authority.set({ ...mappingInput(mediumSelection), chatId: "chat-2", operationId: "user-2" });
		expect(existsSync(walPath)).toBe(true);

		// An external tool edits the base IN PLACE (same generation, byte length,
		// and mtime) while the instance is live. The per-mutation fast path stays
		// O(1) (stat + generation window; no full base re-read), so the append
		// proceeds against in-memory state; the WAL header digest binding then
		// discards the stale WAL at boot, preserving the edit.
		const original = readFileSync(filePath, "utf8");
		const rewritten = original.replaceAll("session-1", "session-9");
		expect(rewritten.length).toBe(original.length);
		const mtimeMs = statSync(filePath).mtimeMs;
		writeFileSync(filePath, rewritten);
		utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);

		authority.set({ ...mappingInput(mediumSelection), chatId: "chat-3", operationId: "user-3" });

		// Boot discards the stale WAL (digest mismatch): the edit is preserved
		// and the acknowledged mutation chained to the old digest is not replayed
		// over the edited base.
		const booted = new FileSessionAuthority(filePath);
		expect(
			booted
				.entries()
				.map(record => record.sessionId)
				.sort(),
		).toEqual(["session-9"]);
		expect(
			booted
				.entries()
				.map(record => record.chatId)
				.sort(),
		).toEqual(["chat-1"]);
	});
	test("upgrades a chained WAL whose header predates the base digest before appending", () => {
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-authority-digest-less-header-")), "mappings.json");
		const walPath = `${filePath}.wal`;
		const authority = new FileSessionAuthority(filePath);
		authority.set(mappingInput(mediumSelection));

		// Hand-craft an older-release v2 WAL: a header WITHOUT the base digest,
		// with its chain computed over that exact header text, plus a delta for a
		// second mapping.
		const stat = statSync(filePath);
		const baseDoc = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
		const seed = "openwebui-gjc-session-authority-wal:v2";
		const chain = (prev: string, text: string) =>
			createHash("sha256").update(prev).update("\n").update(text).digest("hex");
		const headerJson = JSON.stringify({
			kind: "openwebui-gjc-session-authority-wal",
			version: 2,
			base: { size: stat.size, mtimeMs: stat.mtimeMs, generation: baseDoc.generation },
			prevHash: seed,
		});
		const headerHead = chain(seed, headerJson);
		const rec1 = authority.entries()[0]!;
		const rec2 = {
			...JSON.parse(JSON.stringify(rec1)),
			chatId: "chat-2",
			operationId: "user-2",
			header: { ...rec1.header, chatId: "chat-2" },
			journal: [{ ...rec1.journal[0]!, id: "user-2", ingressId: "user-2" }],
		};
		const body = {
			kind: "openwebui-gjc-session-authority-wal",
			version: 2,
			records: [rec2],
			provisional: [],
			prevHash: headerHead,
		};
		const deltaJson = JSON.stringify({ ...body, head: chain(headerHead, JSON.stringify(body)) });
		writeFileSync(walPath, `${headerJson}\n${deltaJson}\n`);

		// Boot replays the legacy header (deltas applied, stat/generation-bound),
		// and the next mutation upgrades the WAL to a digest-bound header instead
		// of appending beneath the digest-less one.
		const live = new FileSessionAuthority(filePath);
		expect(
			live
				.entries()
				.map(record => record.chatId)
				.sort(),
		).toEqual(["chat-1", "chat-2"]);
		live.set({ ...mappingInput(mediumSelection), chatId: "chat-3", operationId: "user-3" });

		// The digest-less WAL was compacted into the base (reset), so no
		// digest-less header can persist; the state survives a restart.
		expect(existsSync(walPath)).toBe(false);
		expect(
			new FileSessionAuthority(filePath)
				.entries()
				.map(record => record.chatId)
				.sort(),
		).toEqual(["chat-1", "chat-2", "chat-3"]);
	});
	test("does not recompact an already-normalized oversized authority on later boots", () => {
		const directory = mkdtempSync(join(tmpdir(), "gjc-session-authority-boot-compaction-once-"));
		const filePath = join(directory, "mappings.json");
		try {
			// A normalized oversized document (written by our own persist, so it
			// carries the marker): many mappings keep it above the threshold but
			// no legacy normalization is needed, so later boots must not rewrite
			// it again.
			const oversized = oversizedAuthorityJson(70 * 1024 * 1024);
			const document = JSON.parse(oversized.json) as Record<string, unknown>;
			document.normalized = true;
			writeFileSync(filePath, JSON.stringify(document));
			const firstBytes = statSync(filePath).size;

			const store = new FileBackedSessionMappingStore(filePath);
			expect(store.bootCompaction).toBeUndefined();
			expect(statSync(filePath).size).toBe(firstBytes);

			// A second boot also leaves the file untouched.
			new FileBackedSessionMappingStore(filePath);
			expect(statSync(filePath).size).toBe(firstBytes);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	test("reports boot compaction from the original size even when recovery compacts first", () => {
		const directory = mkdtempSync(join(tmpdir(), "gjc-session-authority-boot-compaction-recovery-"));
		const filePath = join(directory, "mappings.json");
		try {
			// An oversized legacy document that ALSO has a pending operation: the
			// recovery branch persists first (shrinking the file), but the boot
			// compaction diagnostic must still report the ORIGINAL oversized size.
			const oversized = oversizedAuthorityJson(70 * 1024 * 1024);
			const document = JSON.parse(oversized.json) as Record<string, unknown>;
			const mappings = document.mappings as Array<Record<string, unknown>>;
			const record = mappings[0]!;
			const journal = record.journal as Array<Record<string, unknown>>;
			journal.push({
				id: "pending-op",
				kind: "prompt",
				state: "pending",
				startedAt: "2026-01-01T00:00:00.000Z",
			});
			writeFileSync(filePath, JSON.stringify(document));
			const originalBytes = statSync(filePath).size;
			expect(originalBytes).toBeGreaterThan(AUTHORITY_BOOT_COMPACTION_THRESHOLD_BYTES);

			const store = new FileBackedSessionMappingStore(filePath);
			expect(store.bootCompaction?.beforeBytes).toBe(originalBytes);
			expect(store.bootCompaction?.afterBytes ?? 0).toBeLessThan(originalBytes);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	test("does not rewrite a second time when recovery persists first", () => {
		const directory = mkdtempSync(join(tmpdir(), "gjc-session-authority-recovery-then-compaction-"));
		const filePath = join(directory, "mappings.json");
		try {
			// An oversized legacy document with a pending operation: the recovery
			// branch persists (writing a normalized base) before the oversized
			// condition; the in-memory normalized marker must prevent a second
			// full rewrite, so the file is written exactly once during boot.
			const oversized = oversizedAuthorityJson(70 * 1024 * 1024);
			const document = JSON.parse(oversized.json) as Record<string, unknown>;
			const mappings = document.mappings as Array<Record<string, unknown>>;
			const record = mappings[0]!;
			const journal = record.journal as Array<Record<string, unknown>>;
			journal.push({
				id: "pending-op",
				kind: "prompt",
				state: "pending",
				startedAt: "2026-01-01T00:00:00.000Z",
			});
			writeFileSync(filePath, JSON.stringify(document));
			const originalBytes = statSync(filePath).size;

			const store = new FileBackedSessionMappingStore(filePath);
			// The recovery persist already normalized the base (the marker is set in
			// memory), so the oversized condition does NOT rewrite it a second time,
			// but the compaction is still reported from the original size.
			expect(store.bootCompaction?.beforeBytes).toBe(originalBytes);
			expect(statSync(filePath).size).toBeLessThan(originalBytes);
			expect(statSync(filePath).size).toBeLessThan(AUTHORITY_BOOT_COMPACTION_THRESHOLD_BYTES);

			// A second boot is also stable.
			const stableBytes = statSync(filePath).size;
			new FileBackedSessionMappingStore(filePath);
			expect(statSync(filePath).size).toBe(stableBytes);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	test("routes oversized normalized recovery through the reference writer", () => {
		const directory = mkdtempSync(join(tmpdir(), "gjc-session-authority-normalized-recovery-"));
		const filePath = join(directory, "mappings.json");
		try {
			// A legitimately oversized NORMALIZED authority (marker set) with a
			// pending operation: recovery must still write through the
			// reference-based writer (no entries() deep copy of retained events),
			// persist the reconciled state, and stay stable on later boots.
			const oversized = oversizedAuthorityJson(70 * 1024 * 1024);
			const document = JSON.parse(oversized.json) as Record<string, unknown>;
			document.normalized = true;
			const mappings = document.mappings as Array<Record<string, unknown>>;
			const record = mappings[0]!;
			const journal = record.journal as Array<Record<string, unknown>>;
			journal.push({
				id: "pending-op",
				kind: "prompt",
				state: "pending",
				startedAt: "2026-01-01T00:00:00.000Z",
			});
			writeFileSync(filePath, JSON.stringify(document));
			const originalBytes = statSync(filePath).size;

			const store = new FileBackedSessionMappingStore(filePath);
			// Recovery persisted the reconciled state (reported from the original
			// size) without a second rewrite, and a later boot is stable.
			expect(store.bootCompaction?.beforeBytes).toBe(originalBytes);
			const stableBytes = statSync(filePath).size;
			new FileBackedSessionMappingStore(filePath);
			expect(statSync(filePath).size).toBe(stableBytes);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	test("streams retained record events through boot compaction byte-consistently", () => {
		const directory = mkdtempSync(join(tmpdir(), "gjc-session-authority-streamed-events-"));
		const filePath = join(directory, "mappings.json");
		try {
			// A legacy record with MANY retained events: the boot compaction must
			// stream them element by element and the reloaded document must carry
			// every event intact (byte-consistent round trip).
			const oversized = oversizedAuthorityJson(70 * 1024 * 1024);
			const document = JSON.parse(oversized.json) as Record<string, unknown>;
			writeFileSync(filePath, JSON.stringify(document));

			const store = new FileBackedSessionMappingStore(filePath);
			expect(store.bootCompaction?.beforeBytes).toBeGreaterThan(0);

			const reloaded = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
			const reloadedMapping = (reloaded.mappings as Array<Record<string, unknown>>)[0]!;
			const reloadedJournal = reloadedMapping.journal as Array<Record<string, unknown>>;
			// The retained result events survive the streamed write.
			expect(reloadedJournal[0]?.result).toBeDefined();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	test("routes a WAL-only oversized recovery through the reference writer", () => {
		const directory = mkdtempSync(join(tmpdir(), "gjc-session-authority-wal-oversized-"));
		const filePath = join(directory, "mappings.json");
		const walPath = `${filePath}.wal`;
		try {
			// Small base: nothing requires boot compaction on its own.
			const writer = new FileSessionAuthority(filePath);
			writer.set(mappingInput(mediumSelection));
			// A second mutation appends to a v2 WAL (the first write persists the
			// base directly because the file does not exist yet).
			writer.set({ ...mappingInput(mediumSelection), chatId: "chat-2", operationId: "user-2" });
			expect(statSync(filePath).size).toBeLessThan(AUTHORITY_BOOT_COMPACTION_THRESHOLD_BYTES);

			// A large delta fsynced just before the normal WAL threshold
			// compaction: the WAL is oversized and must be replayed, but the
			// ORIGINAL base is small, so the recovered authority (not the base)
			// is what exceeds the boot compaction threshold. The recovery must
			// route through the reference-based compaction writer instead of
			// persist()'s deep copy of the replayed state.
			const lines = readFileSync(walPath, "utf8").trimEnd().split("\n");
			const lastHead = (JSON.parse(lines[lines.length - 1]!) as { readonly head: string }).head;
			const chunk = "x".repeat(512 * 1024);
			const events = Array.from({ length: 130 }, (_, index) => ({
				type: "assistant" as const,
				text: `event-${index}`,
				payload: { transcript: `${chunk}-${index}` },
			}));
			const document = validAuthorityDocument();
			document.provisionalOperations = [];
			const record = document.mappings[0];
			record.chatId = "chat-9";
			record.header = { chatId: "chat-9", projectId: record.projectId, sessionId: record.sessionId };
			record.operationId = "user-9";
			record.events = events;
			record.journal[0].id = "user-9";
			record.journal[0].result.mapping = {
				chatId: "chat-9",
				projectId: record.projectId,
				sessionId: record.sessionId,
				rawFrameCursor: record.rawFrameCursor,
				eventCursor: record.eventCursor,
				operationId: "user-9",
			};
			const body = {
				kind: "openwebui-gjc-session-authority-wal",
				version: 2,
				records: [record],
				provisional: [],
				prevHash: lastHead,
			};
			const head = createHash("sha256").update(lastHead).update("\n").update(JSON.stringify(body)).digest("hex");
			appendFileSync(walPath, `${JSON.stringify({ ...body, head })}\n`);
			expect(statSync(walPath).size).toBeGreaterThan(AUTHORITY_BOOT_COMPACTION_THRESHOLD_BYTES);

			const store = new FileBackedSessionMappingStore(filePath);
			// The reference-based compaction ran (not persist()'s deep copy) and
			// reported the rewrite.
			expect(store.bootCompaction?.beforeBytes).toBeGreaterThan(0);
			// The replayed large authority survived intact.
			expect(store.get("chat-9")?.events).toHaveLength(130);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	test("streams projection payload hashes byte-identically to whole-string canonicalization", () => {
		// The boot synthesis hashes must stay byte-identical to the previous
		// eager shape (JSON.stringify(event.payload) collected into a mapped
		// array, then whole-string canonicalization) so stored outbox rows and
		// persisted projection hashes keep matching across the streaming change.
		const mapping: SessionMapping = {
			...mappingInput(mediumSelection),
			chatId: "chat-1",
			events: [
				{
					type: "assistant",
					text: "hi",
					id: "e1",
					payload: { transcript: [{ role: "assistant", content: "hi" }] },
				},
				{
					type: "user",
					text: "hello\nworld",
					id: "e0",
					payload: { transcript: [{ role: "user", content: "hello\nworld" }] },
				},
			],
		};
		const legacyShape = {
			chatId: mapping.chatId,
			projectId: mapping.projectId,
			sessionId: mapping.sessionId,
			sessionFile: mapping.sessionFile ?? null,
			activeLeaf: mapping.activeLeaf ?? null,
			rawFrameCursor: mapping.rawFrameCursor,
			eventCursor: mapping.eventCursor,
			operationId: mapping.operationId,
			assistantText: mapping.assistantText ?? null,
			modelSelection: normalizeModelSelection(mapping.modelSelection) ?? null,
			events: (mapping.events ?? []).map(event => ({
				type: event.type,
				text: event.text ?? null,
				id: event.id ?? null,
				payloadJson: event.payload === undefined ? null : JSON.stringify(event.payload),
			})),
		};
		expect(buildSessionMappingPayloadHash(mapping)).toBe(buildProjectionPayloadHash(legacyShape));

		// A payload whose string ends in an UNMATCHED high surrogate must still
		// hash byte-identically: JSON.stringify escapes a terminal lone
		// surrogate (\\ud800) while an unescaped raw code unit would be encoded
		// by Bun as the replacement character, diverging from stored hashes.
		const terminalSurrogate = "ends-in-\uD800";
		expect(JSON.stringify(terminalSurrogate)).toBe('"ends-in-\\ud800"');
		let escapedTerminal = "";
		streamEscapedJsonString(terminalSurrogate, chunk => (escapedTerminal += chunk));
		expect(escapedTerminal).toBe(JSON.stringify(terminalSurrogate).slice(1, -1));

		// streamPlainJson / streamEscapedJsonString must reproduce
		// JSON.stringify and its string-value escape byte for byte.
		const payload = { a: 'x"y', b: ["\n", "\u0001"], c: { d: "\u{1F600}" } };
		let streamed = "";
		streamPlainJson(payload, chunk => streamEscapedJsonString(chunk, fragment => (streamed += fragment)));
		expect(streamed).toBe(JSON.stringify(JSON.stringify(payload)).slice(1, -1));
	});
	test("hashes a large assistantText byte-identically to whole-string canonicalization", () => {
		// A large persisted response must not materialize an assistant-sized
		// string on each projection hashing pass; the streamed escape must stay
		// byte-identical to JSON.stringify so stored outbox rows keep matching.
		const bigText = `${"x".repeat(1024 * 1024)}\n"quoted"\\slash\u0001\uD800 tail`;
		const mapping: SessionMapping = {
			...mappingInput(mediumSelection),
			chatId: "chat-1",
			assistantText: bigText,
			events: [],
		};
		const legacyShape = {
			chatId: mapping.chatId,
			projectId: mapping.projectId,
			sessionId: mapping.sessionId,
			sessionFile: mapping.sessionFile ?? null,
			activeLeaf: mapping.activeLeaf ?? null,
			rawFrameCursor: mapping.rawFrameCursor,
			eventCursor: mapping.eventCursor,
			operationId: mapping.operationId,
			assistantText: mapping.assistantText ?? null,
			modelSelection: normalizeModelSelection(mapping.modelSelection) ?? null,
			events: (mapping.events ?? []).map(event => ({
				type: event.type,
				text: event.text ?? null,
				id: event.id ?? null,
				payloadJson: event.payload === undefined ? null : JSON.stringify(event.payload),
			})),
		};
		expect(buildSessionMappingPayloadHash(mapping)).toBe(buildProjectionPayloadHash(legacyShape));
	});
	test("routes a CJK-heavy WAL recovery by UTF-8 bytes through the reference writer", () => {
		const directory = mkdtempSync(join(tmpdir(), "gjc-session-authority-wal-cjk-"));
		const filePath = join(directory, "mappings.json");
		const walPath = `${filePath}.wal`;
		try {
			// Small base: nothing requires boot compaction on its own.
			const writer = new FileSessionAuthority(filePath);
			writer.set(mappingInput(mediumSelection));
			writer.set({ ...mappingInput(mediumSelection), chatId: "chat-2", operationId: "user-2" });
			expect(statSync(filePath).size).toBeLessThan(AUTHORITY_BOOT_COMPACTION_THRESHOLD_BYTES);

			// ~26 MiB of CJK characters serialize to ~78 MiB UTF-8 (3 bytes per
			// code unit) but only ~26 MiB of UTF-16 code units: the recovered
			// authority must be measured in serialized BYTES so it routes
			// through the reference-based compaction writer.
			const lines = readFileSync(walPath, "utf8").trimEnd().split("\n");
			const lastHead = (JSON.parse(lines[lines.length - 1]!) as { readonly head: string }).head;
			const cjkChunk = "가".repeat(512 * 1024);
			const events = Array.from({ length: 52 }, (_, index) => ({
				type: "assistant" as const,
				text: `event-${index}`,
				payload: { transcript: `${cjkChunk}-${index}` },
			}));
			const document = validAuthorityDocument();
			document.provisionalOperations = [];
			const record = document.mappings[0];
			record.chatId = "chat-9";
			record.header = { chatId: "chat-9", projectId: record.projectId, sessionId: record.sessionId };
			record.operationId = "user-9";
			record.events = events;
			record.journal[0].id = "user-9";
			record.journal[0].result.mapping = {
				chatId: "chat-9",
				projectId: record.projectId,
				sessionId: record.sessionId,
				rawFrameCursor: record.rawFrameCursor,
				eventCursor: record.eventCursor,
				operationId: "user-9",
			};
			const body = {
				kind: "openwebui-gjc-session-authority-wal",
				version: 2,
				records: [record],
				provisional: [],
				prevHash: lastHead,
			};
			const head = createHash("sha256").update(lastHead).update("\n").update(JSON.stringify(body)).digest("hex");
			appendFileSync(walPath, `${JSON.stringify({ ...body, head })}\n`);
			// The replayed authority is ~78 MiB of UTF-8 but its UTF-16 length is
			// below the threshold: only a BYTE-based measurement routes it to the
			// reference writer.
			expect(statSync(walPath).size).toBeGreaterThan(AUTHORITY_BOOT_COMPACTION_THRESHOLD_BYTES);

			const store = new FileBackedSessionMappingStore(filePath);
			expect(store.bootCompaction?.beforeBytes).toBeGreaterThan(0);
			expect(store.get("chat-9")?.events).toHaveLength(52);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	test("streams oversized provisional result events through boot compaction", () => {
		const directory = mkdtempSync(join(tmpdir(), "gjc-session-authority-provisional-"));
		const filePath = join(directory, "mappings.json");
		const walPath = `${filePath}.wal`;
		try {
			// A large WAL delta carrying a pending provisional operation whose
			// normalized result retains a multi-gate event array: replaying it
			// recovers an oversized authority (small original base) so the boot
			// compaction writer must serialize the provisional with
			// streamProvisional (per-event chunks) instead of an eager
			// provisional-sized string.
			const writer = new FileSessionAuthority(filePath);
			writer.set(mappingInput(mediumSelection));
			writer.set({ ...mappingInput(mediumSelection), chatId: "chat-2", operationId: "user-2" });
			expect(statSync(filePath).size).toBeLessThan(AUTHORITY_BOOT_COMPACTION_THRESHOLD_BYTES);

			const lines = readFileSync(walPath, "utf8").trimEnd().split("\n");
			const lastHead = (JSON.parse(lines[lines.length - 1]!) as { readonly head: string }).head;
			const chunk = "x".repeat(512 * 1024);
			// Ambiguous multi-gate events (two workflow-gate events, so no single
			// gate binding can be synthesized): normalization preserves the
			// retained array, and the compaction writer must stream it per
			// element instead of serializing the whole provisional eagerly.
			const events = Array.from({ length: 140 }, (_, index) => ({
				type: "workflow_gate" as const,
				text: `event-${index}`,
				payload: {
					gateId: `gate-${index % 2}`, // two distinct gates: ambiguous
					schemaHash: `schema-${index % 2}`,
					transcript: `${chunk}-${index}`,
				},
			}));
			const document = validAuthorityDocument();
			document.mappings[0].journal[0].result.events = [];
			const provisional = {
				id: "operation-2",
				kind: "create",
				state: "complete",
				startedAt: (document.mappings[0] as Record<string, unknown>).createdAt as string,
				completedAt: (document.mappings[0] as Record<string, unknown>).createdAt as string,
				chatId: "chat-2",
				projectId: (document.mappings[0] as Record<string, unknown>).projectId as string,
				result: {
					kind: "turn",
					assistantText: "done",
					events,
					mapping: {
						chatId: "chat-2",
						projectId: (document.mappings[0] as Record<string, unknown>).projectId as string,
						sessionId: "session-2",
						rawFrameCursor: 0,
						eventCursor: 0,
						operationId: "operation-2",
					},
				},
			};
			const body = {
				kind: "openwebui-gjc-session-authority-wal",
				version: 2,
				records: [document.mappings[0]],
				provisional: [{ key: JSON.stringify(["chat-2", "operation-2"]), operation: provisional }],
				prevHash: lastHead,
			};
			const head = createHash("sha256").update(lastHead).update("\n").update(JSON.stringify(body)).digest("hex");
			appendFileSync(walPath, `${JSON.stringify({ ...body, head })}\n`);
			expect(statSync(walPath).size).toBeGreaterThan(AUTHORITY_BOOT_COMPACTION_THRESHOLD_BYTES);

			const store = new FileBackedSessionMappingStore(filePath);
			// The reference-based compaction ran (streaming the provisional) and
			// reported the rewrite.
			expect(store.bootCompaction?.beforeBytes).toBeGreaterThan(0);

			const reloaded = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
			const reloadedProvisional = reloaded.provisionalOperations as Array<Record<string, unknown>>;
			const reloadedEvents = (reloadedProvisional[0]?.result as Record<string, unknown> | undefined)?.events;
			expect(Array.isArray(reloadedEvents)).toBe(true);
			expect((reloadedEvents as unknown[]).length).toBe(140);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	test("preserves an empty journal through boot compaction so the rewritten base still validates", () => {
		const directory = mkdtempSync(join(tmpdir(), "gjc-session-authority-empty-journal-"));
		const filePath = join(directory, "mappings.json");
		const walPath = `${filePath}.wal`;
		try {
			const writer = new FileSessionAuthority(filePath);
			writer.set(mappingInput(mediumSelection));
			writer.set({ ...mappingInput(mediumSelection), chatId: "chat-2", operationId: "user-2" });
			expect(statSync(filePath).size).toBeLessThan(AUTHORITY_BOOT_COMPACTION_THRESHOLD_BYTES);

			const lines = readFileSync(walPath, "utf8").trimEnd().split("\n");
			const lastHead = (JSON.parse(lines[lines.length - 1]!) as { readonly head: string }).head;
			const chunk = "x".repeat(512 * 1024);
			// An empty journal is a REQUIRED v2 record field: isV2Record checks
			// Array.isArray(journal) and hasOnlyKeys includes "journal", so a
			// compaction writer that omits the field produces a base the next
			// boot rejects. The oversized delta forces compaction to run.
			const document = validAuthorityDocument();
			document.provisionalOperations = [];
			const record = document.mappings[0];
			record.journal = [];
			record.events = Array.from({ length: 140 }, (_, index) => ({
				type: "assistant" as const,
				text: `event-${index}`,
				payload: { transcript: `${chunk}-${index}` },
			}));
			const body = {
				kind: "openwebui-gjc-session-authority-wal",
				version: 2,
				records: [record],
				provisional: [],
				prevHash: lastHead,
			};
			const head = createHash("sha256").update(lastHead).update("\n").update(JSON.stringify(body)).digest("hex");
			appendFileSync(walPath, `${JSON.stringify({ ...body, head })}\n`);
			expect(statSync(walPath).size).toBeGreaterThan(AUTHORITY_BOOT_COMPACTION_THRESHOLD_BYTES);

			const store = new FileBackedSessionMappingStore(filePath);
			expect(store.bootCompaction?.beforeBytes).toBeGreaterThan(0);
			// The rewritten base must still parse and validate on the NEXT boot
			// (the WAL was reset by compaction), so the empty journal field must
			// be present.
			const booted = new FileSessionAuthority(filePath);
			expect(
				booted
					.entries()
					.map(record => record.chatId)
					.sort(),
			).toEqual(["chat-1", "chat-2"]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	test("streams ambiguous multi-gate events retained inside a tombstone journal through boot compaction", () => {
		const directory = mkdtempSync(join(tmpdir(), "gjc-session-authority-tombstone-journal-"));
		const filePath = join(directory, "mappings.json");
		const walPath = `${filePath}.wal`;
		try {
			const writer = new FileSessionAuthority(filePath);
			writer.set(mappingInput(mediumSelection));
			writer.set({ ...mappingInput(mediumSelection), chatId: "chat-2", operationId: "user-2" });
			expect(statSync(filePath).size).toBeLessThan(AUTHORITY_BOOT_COMPACTION_THRESHOLD_BYTES);

			const lines = readFileSync(walPath, "utf8").trimEnd().split("\n");
			const lastHead = (JSON.parse(lines[lines.length - 1]!) as { readonly head: string }).head;
			const chunk = "x".repeat(256 * 1024);
			// Normalization preserves ambiguous results (multiple workflow-gate
			// events) under journal[].result.events: the tombstone serializer
			// must stream those per element instead of eager-serializing the
			// whole tombstone journal.
			const gateEvents = Array.from({ length: 140 }, (_, index) => ({
				type: "workflow_gate" as const,
				text: `event-${index}`,
				payload: {
					gateId: `gate-${index % 2}`,
					schemaHash: `schema-${index % 2}`,
					transcript: `${chunk}-${index}`,
				},
			}));
			const document = validAuthorityDocument();
			document.provisionalOperations = [];
			const record = document.mappings[0];
			// A committed reassignment moves the mapping INTO the target project: the
			// record's projectId IS the target project, and the tombstone (frozen
			// under the source project) keeps sourceProjectId === tombstone.projectId.
			record.projectId = "project-target";
			record.header = { ...record.header, projectId: "project-target" };
			record.journal = [
				{
					id: "operation-2",
					kind: "prompt",
					state: "complete",
					startedAt: record.createdAt,
					completedAt: record.createdAt,
					result: {
						kind: "turn",
						assistantText: "done",
						events: gateEvents,
						mapping: {
							chatId: "chat-1",
							projectId: "project-target",
							sessionId: record.sessionId,
							rawFrameCursor: record.rawFrameCursor,
							eventCursor: record.eventCursor,
							operationId: "operation-2",
						},
					},
				},
			];
			record.operationId = "operation-2";
			record.events = [];
			record.reassignment = {
				state: "committed",
				sourceProjectId: project.id,
				targetProjectId: "project-target",
				startedAt: record.createdAt,
				completedAt: record.createdAt,
				sourceTombstone: {
					version: 2,
					chatId: "chat-1",
					projectId: project.id, // frozen under the SOURCE project
					sessionId: record.sessionId,
					createdAt: record.createdAt,
					header: { chatId: "chat-1", projectId: project.id, sessionId: record.sessionId },
					rawFrameCursor: record.rawFrameCursor,
					eventCursor: record.eventCursor,
					operationId: "operation-1",
					journal: [
						{
							id: "operation-1",
							kind: "prompt",
							state: "complete",
							startedAt: record.createdAt,
							completedAt: record.createdAt,
							result: {
								kind: "turn",
								assistantText: "done",
								events: gateEvents,
								mapping: {
									chatId: "chat-1",
									projectId: project.id,
									sessionId: record.sessionId,
									rawFrameCursor: record.rawFrameCursor,
									eventCursor: record.eventCursor,
									operationId: "operation-1",
								},
							},
						},
					],
					retiredAt: record.createdAt,
				},
			};
			const body = {
				kind: "openwebui-gjc-session-authority-wal",
				version: 2,
				records: [record],
				provisional: [],
				prevHash: lastHead,
			};
			const head = createHash("sha256").update(lastHead).update("\n").update(JSON.stringify(body)).digest("hex");
			appendFileSync(walPath, `${JSON.stringify({ ...body, head })}\n`);
			expect(statSync(walPath).size).toBeGreaterThan(AUTHORITY_BOOT_COMPACTION_THRESHOLD_BYTES);

			const store = new FileBackedSessionMappingStore(filePath);
			expect(store.bootCompaction?.beforeBytes).toBeGreaterThan(0);
			const reloaded = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
			const mapping = (reloaded.mappings as Array<Record<string, unknown>>)[0]!;
			const tombstone = (mapping.reassignment as Record<string, unknown>).sourceTombstone as Record<string, unknown>;
			const tombstoneEvents = (
				(tombstone.journal as Array<Record<string, unknown>>)[0]?.result as Record<string, unknown> | undefined
			)?.events;
			expect(Array.isArray(tombstoneEvents)).toBe(true);
			expect((tombstoneEvents as unknown[]).length).toBe(140);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	test("streams a single large retained event through boot compaction byte-identically", () => {
		const directory = mkdtempSync(join(tmpdir(), "gjc-session-authority-single-event-"));
		const filePath = join(directory, "mappings.json");
		const walPath = `${filePath}.wal`;
		try {
			const writer = new FileSessionAuthority(filePath);
			writer.set(mappingInput(mediumSelection));
			writer.set({ ...mappingInput(mediumSelection), chatId: "chat-2", operationId: "user-2" });
			expect(statSync(filePath).size).toBeLessThan(AUTHORITY_BOOT_COMPACTION_THRESHOLD_BYTES);

			const lines = readFileSync(walPath, "utf8").trimEnd().split("\n");
			const lastHead = (JSON.parse(lines[lines.length - 1]!) as { readonly head: string }).head;
			const chunk = "x".repeat(512 * 1024);
			// One retained event whose payload alone dominates the authority: an
			// eager JSON.stringify(event) would materialize another
			// payload-sized string, so the event must stream through the
			// incremental plain-JSON writer instead.
			const singleEvent = {
				type: "tool" as const,
				text: "tool-0",
				id: "event-0",
				payload: { toolCallId: "tool-0", transcript: `${chunk.repeat(140)}\n"quoted"\\slash\u0001 tail` },
			};
			const document = validAuthorityDocument();
			document.provisionalOperations = [];
			const record = document.mappings[0];
			record.events = [singleEvent];
			record.journal = [];
			record.operationId = "operation-1";
			const body = {
				kind: "openwebui-gjc-session-authority-wal",
				version: 2,
				records: [record],
				provisional: [],
				prevHash: lastHead,
			};
			const head = createHash("sha256").update(lastHead).update("\n").update(JSON.stringify(body)).digest("hex");
			appendFileSync(walPath, `${JSON.stringify({ ...body, head })}\n`);
			expect(statSync(walPath).size).toBeGreaterThan(AUTHORITY_BOOT_COMPACTION_THRESHOLD_BYTES);

			const store = new FileBackedSessionMappingStore(filePath);
			expect(store.bootCompaction?.beforeBytes).toBeGreaterThan(0);
			const reloaded = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
			const mapping = (reloaded.mappings as Array<Record<string, unknown>>)[0]!;
			const events = mapping.events as Array<Record<string, unknown>>;
			expect(events).toHaveLength(1);
			expect((events[0]!.payload as Record<string, unknown>).transcript).toBe(singleEvent.payload.transcript);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	test("streams large record assistantText and observations through boot compaction byte-identically", () => {
		const directory = mkdtempSync(join(tmpdir(), "gjc-session-authority-large-fields-"));
		const filePath = join(directory, "mappings.json");
		const walPath = `${filePath}.wal`;
		try {
			const writer = new FileSessionAuthority(filePath);
			writer.set(mappingInput(mediumSelection));
			writer.set({ ...mappingInput(mediumSelection), chatId: "chat-2", operationId: "user-2" });
			expect(statSync(filePath).size).toBeLessThan(AUTHORITY_BOOT_COMPACTION_THRESHOLD_BYTES);

			const lines = readFileSync(walPath, "utf8").trimEnd().split("\n");
			const lastHead = (JSON.parse(lines[lines.length - 1]!) as { readonly head: string }).head;
			const chunk = "x".repeat(512 * 1024);
			// assistantText and observations are unbounded record fields: the
			// compaction writer must serialize them incrementally (no
			// payload-sized eager string) while remaining byte-identical, so the
			// rewritten base round-trips exactly. Two 33 MiB copies (record
			// assistantText + nested observations value) push the delta over the
			// 64 MiB compaction threshold.
			const bigText = `${chunk.repeat(66)}\n"quoted"\\backslash\u0001\uD800 tail`;
			const observations = {
				__gjcSessionMappingScope: { chatId: "chat-1", projectId: project.id },
				nested: { deep: [1, null, { value: bigText }] },
			};
			const document = validAuthorityDocument();
			document.provisionalOperations = [];
			const record = document.mappings[0];
			record.assistantText = bigText;
			record.observations = observations;
			record.journal = [
				{
					...record.journal[0]!,
					result: {
						...record.journal[0]!.result!,
						assistantText: bigText,
					},
				},
			];
			const body = {
				kind: "openwebui-gjc-session-authority-wal",
				version: 2,
				records: [record],
				provisional: [],
				prevHash: lastHead,
			};
			const head = createHash("sha256").update(lastHead).update("\n").update(JSON.stringify(body)).digest("hex");
			appendFileSync(walPath, `${JSON.stringify({ ...body, head })}\n`);
			expect(statSync(walPath).size).toBeGreaterThan(AUTHORITY_BOOT_COMPACTION_THRESHOLD_BYTES);

			const store = new FileBackedSessionMappingStore(filePath);
			expect(store.bootCompaction?.beforeBytes).toBeGreaterThan(0);
			const reloaded = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
			const mapping = (reloaded.mappings as Array<Record<string, unknown>>)[0]!;
			expect(mapping.assistantText).toBe(bigText);
			expect(mapping.observations).toEqual(observations);
			const result = (mapping.journal as Array<Record<string, unknown>>)[0]!.result as Record<string, unknown>;
			expect(result.assistantText).toBe(bigText);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	test("streams unbounded operation detail and result correlation through boot compaction byte-identically", () => {
		const directory = mkdtempSync(join(tmpdir(), "gjc-session-authority-detail-correlation-"));
		const filePath = join(directory, "mappings.json");
		const walPath = `${filePath}.wal`;
		try {
			const writer = new FileSessionAuthority(filePath);
			writer.set(mappingInput(mediumSelection));
			writer.set({ ...mappingInput(mediumSelection), chatId: "chat-2", operationId: "user-2" });
			expect(statSync(filePath).size).toBeLessThan(AUTHORITY_BOOT_COMPACTION_THRESHOLD_BYTES);

			const lines = readFileSync(walPath, "utf8").trimEnd().split("\n");
			const lastHead = (JSON.parse(lines[lines.length - 1]!) as { readonly head: string }).head;
			const chunk = "x".repeat(512 * 1024);
			// SessionOperation.detail and a string-valued result.correlation are
			// unbounded by validation but were still eagerly materialized inside
			// JSON.stringify(rest)/JSON.stringify(resultRest): the remaining
			// object metadata must stream too, byte-identically, so an oversized
			// valid authority does not allocate a payload-sized string again.
			const bigDetail = `${chunk.repeat(66)}\n"quoted"\\backslash\u0001 tail`;
			const bigCorrelationValue = `${chunk.repeat(66)}\ncorrelation-value`;
			const document = validAuthorityDocument();
			document.provisionalOperations = [];
			const record = document.mappings[0];
			record.journal[0]!.detail = bigDetail;
			record.journal[0]!.result!.correlation = {
				closeStatus: "closed",
				mappingOperationId: bigCorrelationValue,
			};
			const body = {
				kind: "openwebui-gjc-session-authority-wal",
				version: 2,
				records: [record],
				provisional: [],
				prevHash: lastHead,
			};
			const head = createHash("sha256").update(lastHead).update("\n").update(JSON.stringify(body)).digest("hex");
			appendFileSync(walPath, `${JSON.stringify({ ...body, head })}\n`);
			expect(statSync(walPath).size).toBeGreaterThan(AUTHORITY_BOOT_COMPACTION_THRESHOLD_BYTES);

			const store = new FileBackedSessionMappingStore(filePath);
			expect(store.bootCompaction?.beforeBytes).toBeGreaterThan(0);
			const reloaded = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
			const mapping = (reloaded.mappings as Array<Record<string, unknown>>)[0]!;
			const operation = (mapping.journal as Array<Record<string, unknown>>)[0]!;
			expect(operation.detail).toBe(bigDetail);
			const result = operation.result as Record<string, unknown>;
			expect(result.correlation).toEqual({
				closeStatus: "closed",
				mappingOperationId: bigCorrelationValue,
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	test("fails closed on a malformed WAL header", () => {
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-authority-malformed-header-")), "mappings.json");
		const walPath = `${filePath}.wal`;
		const authority = new FileSessionAuthority(filePath);
		authority.set(mappingInput(mediumSelection));
		authority.set({ ...mappingInput(mediumSelection), chatId: "chat-2", operationId: "user-2" });

		// Corrupt the first byte of the header: the acknowledged delta that
		// follows must not be silently deleted (only a valid stale header bound
		// to another base is deletable).
		const contents = readFileSync(walPath, "utf8");
		writeFileSync(walPath, `X${contents.slice(1)}`);

		expect(() => new FileSessionAuthority(filePath)).toThrow("header is malformed");
		expect(existsSync(walPath)).toBe(true);
	});
	test("discards the WAL when the base is edited in place preserving generation, size, and mtime", () => {
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-authority-base-edit-preserve-")), "mappings.json");
		const walPath = `${filePath}.wal`;
		const authority = new FileSessionAuthority(filePath);
		authority.set(mappingInput(mediumSelection));
		authority.set({ ...mappingInput(mediumSelection), chatId: "chat-2", operationId: "user-2" });
		expect(existsSync(walPath)).toBe(true);

		// An external tool parses and rewrites the base IN PLACE, keeping the
		// same generation value, byte length, and mtime, but changing content
		// (e.g. an operator edit to the session ids).
		const original = readFileSync(filePath, "utf8");
		const rewritten = original.replaceAll("session-1", "session-9");
		expect(rewritten.length).toBe(original.length);
		const mtimeMs = statSync(filePath).mtimeMs;
		writeFileSync(filePath, rewritten);
		utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);

		// Boot must discard the stale WAL (content digest mismatch) instead of
		// replaying it over the edited base and silently reverting the edit.
		const booted = new FileSessionAuthority(filePath);
		expect(
			booted
				.entries()
				.map(record => record.sessionId)
				.sort(),
		).toEqual(["session-9"]);
		expect(
			booted
				.entries()
				.map(record => record.chatId)
				.sort(),
		).toEqual(["chat-1"]);
	});
	test("fails closed when a WAL line before the tail is malformed", () => {
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-authority-wal-corruption-")), "mappings.json");
		const walPath = `${filePath}.wal`;
		const authority = new FileSessionAuthority(filePath);
		authority.set(mappingInput(mediumSelection));
		authority.set({ ...mappingInput(mediumSelection), chatId: "chat-2", operationId: "user-2" });
		authority.set({ ...mappingInput(mediumSelection), chatId: "chat-3", operationId: "user-3" });

		// Corrupt a NON-FINAL line: silently compacting the prefix would delete
		// the acknowledged chat-3 mutation, so boot must fail closed.
		const lines = readFileSync(walPath, "utf8").split("\n");
		lines[1] = "{corrupt-delta";
		writeFileSync(walPath, lines.join("\n"));

		expect(() => new FileSessionAuthority(filePath)).toThrow("corrupt before its final line");
	});
	test("treats an unterminated valid-JSON final line as a torn tail", () => {
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-authority-wal-torn-tail-")), "mappings.json");
		const walPath = `${filePath}.wal`;
		const authority = new FileSessionAuthority(filePath);
		authority.set(mappingInput(mediumSelection));
		authority.set({ ...mappingInput(mediumSelection), chatId: "chat-2", operationId: "user-2" });
		authority.set({ ...mappingInput(mediumSelection), chatId: "chat-3", operationId: "user-3" });

		// A torn write leaves the final delta's JSON but not its newline; the
		// tail must be treated as uncommitted and the valid prefix compacted,
		// not replayed (which would let the next append corrupt the file).
		const contents = readFileSync(walPath, "utf8");
		expect(contents.endsWith("\n")).toBe(true);
		writeFileSync(walPath, contents.slice(0, -1));

		expect(
			new FileSessionAuthority(filePath)
				.entries()
				.map(record => record.chatId)
				.sort(),
		).toEqual(["chat-1", "chat-2"]);
	});
	test("retains the WAL when the base rename durability is uncertain", () => {
		class SmallThresholdDirectoryFailingAuthority extends FailingFileSessionAuthority {
			protected override walCompactionThresholdBytes = 1024;
		}
		const filePath = join(
			mkdtempSync(join(tmpdir(), "gjc-session-authority-wal-retain-on-sync-failure-")),
			"mappings.json",
		);
		const walPath = `${filePath}.wal`;
		const authority = new SmallThresholdDirectoryFailingAuthority(filePath);
		authority.set(mappingInput(mediumSelection));
		authority.set({
			...mappingInput(mediumSelection),
			chatId: "chat-2",
			operationId: "user-2",
			assistantText: `${padding}turn-2`,
		});
		authority.directoryFailure = new Error("injected directory sync failure");

		let error: unknown;
		try {
			authority.set({
				...mappingInput(mediumSelection),
				chatId: "chat-3",
				operationId: "user-3",
				assistantText: `${padding}turn-3`,
			});
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(SessionAuthorityDurabilityError);
		// The rename was not durably synced, so the WAL must be kept to keep the
		// previous base + WAL pair complete if a crash loses the rename.
		expect(existsSync(walPath)).toBe(true);
	});
	test("fails closed at boot when an interior WAL delta was replaced", () => {
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-authority-wal-interior-swap-")), "mappings.json");
		const walPath = `${filePath}.wal`;
		const authority = new FileSessionAuthority(filePath);
		authority.set(mappingInput(mediumSelection));
		const pad = "x".repeat(400 * 1024);
		authority.set({
			...mappingInput(mediumSelection),
			chatId: "chat-2",
			operationId: "user-2",
			assistantText: `${pad}turn-2`,
		});
		authority.set({
			...mappingInput(mediumSelection),
			chatId: "chat-3",
			operationId: "user-3",
			assistantText: `${pad}turn-3`,
		});
		authority.set({
			...mappingInput(mediumSelection),
			chatId: "chat-4",
			operationId: "user-4",
			assistantText: `${pad}turn-4`,
		});
		expect(statSync(walPath).size).toBeGreaterThan(1024 * 1024);

		// Replace an INTERIOR delta: the chained hashes cryptographically cover
		// every line, so the next live verification (and any boot) fails closed on
		// the broken link instead of silently replaying the replaced state.
		const original = readFileSync(walPath, "utf8");
		const replaced = original.replaceAll("chat-2", "chat-9");
		expect(replaced.length).toBe(original.length);
		writeFileSync(walPath, replaced);

		expect(() =>
			authority.set({ ...mappingInput(mediumSelection), chatId: "chat-5", operationId: "user-5" }),
		).toThrow("chain is broken");
		expect(() => new FileSessionAuthority(filePath)).toThrow("chain is broken");
	});
	test("keeps chained digests byte-consistent for non-ASCII WAL content", () => {
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-authority-wal-non-ascii-")), "mappings.json");
		const walPath = `${filePath}.wal`;
		const authority = new FileSessionAuthority(filePath);
		authority.set(mappingInput(mediumSelection));
		authority.set({
			...mappingInput(mediumSelection),
			chatId: "chat-2",
			operationId: "user-2",
			assistantText: "café-한글-β",
		});

		// A restart re-derives the chain identity from the file's UTF-8 bytes; the
		// next mutation must match it (no forced reload/compaction), so the WAL
		// persists with the appended delta.
		const restarted = new FileSessionAuthority(filePath);
		restarted.set({ ...mappingInput(mediumSelection), chatId: "chat-3", operationId: "user-3" });

		expect(existsSync(walPath)).toBe(true);
		expect(
			new FileSessionAuthority(filePath)
				.entries()
				.map(record => record.chatId)
				.sort(),
		).toEqual(["chat-1", "chat-2", "chat-3"]);
	});
	test("verifies the final WAL line without reloading on the next mutation", () => {
		class LoadCountingFileSessionAuthority extends FailingFileSessionAuthority {
			loadCalls = 0;

			protected override load(): void {
				this.loadCalls += 1;
				super.load();
			}
		}
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-authority-final-line-verify-")), "mappings.json");
		const authority = new LoadCountingFileSessionAuthority(filePath);
		authority.set(mappingInput(mediumSelection));
		authority.set({ ...mappingInput(mediumSelection), chatId: "chat-2", operationId: "user-2" });
		const loadCallsAfterAppend = authority.loadCalls;

		// The final-line chain check must match the cached digest, so the next
		// mutation appends without re-reading the whole base and WAL.
		authority.set({ ...mappingInput(mediumSelection), chatId: "chat-3", operationId: "user-3" });

		expect(authority.loadCalls).toBe(loadCallsAfterAppend);
	});
	test("upgrades a base whose generation offset cannot be matched in the raw text", () => {
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-authority-escaped-generation-")), "mappings.json");
		const authority = new FileSessionAuthority(filePath);
		authority.set(mappingInput(mediumSelection));

		// An external writer escapes the generation KEY: JSON.parse still yields
		// the document, but the raw text no longer carries the literal key, so
		// the byte offset cannot be matched. The first mutation must rewrite the
		// base in the standard layout instead of appending under an unverifiable
		// identity.
		const parsed = readFileSync(filePath, "utf8").replace('"generation"', '"gener\\u0061tion"');
		writeFileSync(filePath, parsed);

		const live = new FileSessionAuthority(filePath);
		live.set({ ...mappingInput(mediumSelection), chatId: "chat-2", operationId: "user-2" });

		expect(existsSync(`${filePath}.wal`)).toBe(false);
		const upgraded = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
		expect(typeof upgraded.generation).toBe("string");
		// The rewritten document carries the literal key in the standard layout.
		expect(readFileSync(filePath, "utf8")).toContain('"generation":');
		expect(
			new FileSessionAuthority(filePath)
				.entries()
				.map(record => record.chatId)
				.sort(),
		).toEqual(["chat-1", "chat-2"]);
	});
	test("finds the top-level generation offset even when a nested observation shadows the value", () => {
		// An externally written document places mappings before the generation
		// and carries an observation whose "generation" key holds the SAME value
		// as the top-level key.
		const raw = JSON.stringify({
			kind: "openwebui-gjc-session-authority",
			version: 2,
			mappings: [
				{
					version: 2,
					chatId: "chat-1",
					projectId: "project-1",
					sessionId: "session-1",
					createdAt: "2026-01-01T00:00:00.000Z",
					header: { chatId: "chat-1", projectId: "project-1", sessionId: "session-1" },
					observations: { generation: "shadowed-same-value" },
					journal: [],
					rawFrameCursor: 0,
					eventCursor: 0,
					operationId: "user-1",
				},
			],
			generation: "shadowed-same-value",
		});
		const topLevelIndex = raw.lastIndexOf('"generation"');
		const nestedIndex = raw.indexOf('"generation"');
		expect(nestedIndex).toBeLessThan(topLevelIndex);

		expect(findGenerationOffset(raw, "shadowed-same-value")).toEqual({
			offset: Buffer.byteLength(raw.slice(0, topLevelIndex), "utf8"),
			spanLength: Buffer.byteLength('"generation":"shadowed-same-value"', "utf8"),
		});
	});
	test("compacts a replayed legacy WAL before the first append", () => {
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-authority-legacy-wal-upgrade-")), "mappings.json");
		const authority = new FileSessionAuthority(filePath);
		authority.set(mappingInput(mediumSelection));

		// Build a legacy v1 WAL beside a generation-less base (as an older
		// release would have written it).
		const baseDoc = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
		delete baseDoc.generation;
		const rec1 = authority.entries()[0]!;
		const rec2 = {
			...JSON.parse(JSON.stringify(rec1)),
			chatId: "chat-2",
			operationId: "user-2",
			header: { ...rec1.header, chatId: "chat-2" },
			journal: [{ ...rec1.journal[0]!, id: "user-2", ingressId: "user-2" }],
		};
		writeFileSync(filePath, JSON.stringify(baseDoc));
		const stat = statSync(filePath);
		const legacyHeader = {
			kind: "openwebui-gjc-session-authority-wal",
			version: 1,
			base: { size: stat.size, mtimeMs: stat.mtimeMs },
		};
		const legacyDelta = {
			kind: "openwebui-gjc-session-authority-wal",
			version: 1,
			records: [rec2],
			provisional: [],
		};
		writeFileSync(`${filePath}.wal`, `${JSON.stringify(legacyHeader)}\n${JSON.stringify(legacyDelta)}\n`);

		// The replay seeds a legacy sample identity; the next mutation must
		// compact it into the base before appending, so the WAL becomes
		// chain-covered instead of staying sample-bound.
		const live = new FileSessionAuthority(filePath);
		live.set({ ...mappingInput(mediumSelection), chatId: "chat-3", operationId: "user-3" });

		expect(existsSync(`${filePath}.wal`)).toBe(false);
		expect(
			new FileSessionAuthority(filePath)
				.entries()
				.map(record => record.chatId)
				.sort(),
		).toEqual(["chat-1", "chat-2", "chat-3"]);
	});
	test("upgrades a generation-less base before the first WAL append", () => {
		const filePath = join(
			mkdtempSync(join(tmpdir(), "gjc-session-authority-generation-less-upgrade-")),
			"mappings.json",
		);
		const authority = new FileSessionAuthority(filePath);
		authority.set(mappingInput(mediumSelection));

		// Strip the generation, simulating a pre-upgrade v2 document (or
		// migration output that omits it).
		const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
		delete parsed.generation;
		writeFileSync(filePath, `${JSON.stringify(parsed)}\n`);

		const live = new FileSessionAuthority(filePath);
		live.set({ ...mappingInput(mediumSelection), chatId: "chat-2", operationId: "user-2" });

		// The mutation upgraded the base with a fresh generation instead of
		// appending to a WAL whose header is bound by stat only.
		const upgraded = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
		expect(typeof upgraded.generation).toBe("string");
		expect((upgraded.generation as string).length).toBeGreaterThan(0);
		expect(existsSync(`${filePath}.wal`)).toBe(false);
		expect(
			new FileSessionAuthority(filePath)
				.entries()
				.map(record => record.chatId)
				.sort(),
		).toEqual(["chat-1", "chat-2"]);
	});
	test("finds the base generation regardless of its position in the document", () => {
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-authority-generation-position-")), "mappings.json");
		const authority = new FileSessionAuthority(filePath);
		authority.set(mappingInput(mediumSelection));

		// Rewrite the document (before any WAL exists) with the generation moved
		// AFTER the mappings array: an external writer may reformat or reorder
		// without changing semantics, and the live verification must still find
		// the generation without re-reading and re-parsing the whole base.
		const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
		const generation = parsed.generation;
		delete parsed.generation;
		parsed.generation = generation;
		writeFileSync(filePath, `${JSON.stringify(parsed)}\n`);

		const live = new FileSessionAuthority(filePath);
		live.set({ ...mappingInput(mediumSelection), chatId: "chat-2", operationId: "user-2" });

		// The mutation appended to the WAL (no forced reload/compaction), so the
		// WAL exists and the acknowledged mutation survives a restart.
		expect(existsSync(`${filePath}.wal`)).toBe(true);
		expect(
			new FileSessionAuthority(filePath)
				.entries()
				.map(record => record.chatId)
				.sort(),
		).toEqual(["chat-1", "chat-2"]);
	});
	test("finds the generation when an external writer formats the document with whitespace", () => {
		const filePath = join(
			mkdtempSync(join(tmpdir(), "gjc-session-authority-generation-whitespace-")),
			"mappings.json",
		);
		const authority = new FileSessionAuthority(filePath);
		authority.set(mappingInput(mediumSelection));

		// An external writer may emit formatted JSON such as `"generation": "uuid"`;
		// the scanner must skip whitespace instead of treating it as a scalar
		// token that cancels the pending key-colon state.
		const formatted = JSON.stringify(JSON.parse(readFileSync(filePath, "utf8"))).replace(
			'"generation":',
			'"generation": ',
		);
		writeFileSync(filePath, `${formatted}\n`);

		const live = new FileSessionAuthority(filePath);
		live.set({ ...mappingInput(mediumSelection), chatId: "chat-2", operationId: "user-2" });

		// No forced reload/compaction: the mutation appended to the WAL.
		expect(existsSync(`${filePath}.wal`)).toBe(true);
		expect(
			new FileSessionAuthority(filePath)
				.entries()
				.map(record => record.chatId)
				.sort(),
		).toEqual(["chat-1", "chat-2"]);
	});
	test("normalizes in-memory records after compaction so later WAL deltas stay compact", () => {
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-authority-normalize-memory-")), "mappings.json");
		const authority = new SmallThresholdFailingFileSessionAuthority(filePath);
		authority.set(mappingInput(mediumSelection));
		const legacyResult = {
			kind: "turn" as const,
			assistantText: "legacy",
			events: [
				{ type: "message_update", id: "marker-event", payload: { marker: "giant-legacy-event-payload", padding } },
			],
			mapping: {
				chatId: "chat-1",
				projectId: project.id,
				sessionId: "session-1",
				rawFrameCursor: 0,
				eventCursor: 0,
				operationId: "op-legacy",
			},
		};
		authority.beginOperation("chat-1", { id: "op-legacy", kind: "prompt", detail: "legacy" });
		// The oversized delta triggers a compaction that strips the result events
		// from the rewritten base.
		authority.transitionOperation("chat-1", "op-legacy", "complete", "legacy", legacyResult);
		expect(readFileSync(filePath, "utf8")).not.toContain("giant-legacy-event-payload");

		// The next mutation's WAL delta must stay compact: the stripped events
		// must not be re-introduced from the in-memory journal.
		authority.set({
			...mappingInput(mediumSelection),
			chatId: "chat-1",
			operationId: "user-2",
			assistantText: "follow-up",
		});
		const wal = existsSync(`${filePath}.wal`) ? readFileSync(`${filePath}.wal`, "utf8") : "";
		expect(wal).not.toContain("giant-legacy-event-payload");
		expect(
			new FileSessionAuthority(filePath)
				.entries()
				.map(record => record.chatId)
				.sort(),
		).toEqual(["chat-1"]);
	});
	test("removes the temporary compaction file after a failed persist", () => {
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-authority-compaction-cleanup-")), "mappings.json");
		const directory = dirname(filePath);
		const authority = new SmallThresholdFailingFileSessionAuthority(filePath);
		authority.set(mappingInput(mediumSelection));
		// A failed persist must not leave an uncommitted temporary file behind:
		// retried startups would otherwise accumulate abandoned authority files.
		authority.failure = new Error("injected persist failure");
		expect(() =>
			authority.set({ ...mappingInput(mediumSelection), chatId: "chat-2", operationId: "user-2" }),
		).toThrow();
		expect(readdirSync(directory).filter(name => name.includes(".tmp-"))).toEqual([]);
	});
	test("leaves no temporary compaction file after a committed rewrite", () => {
		const filePath = join(
			mkdtempSync(join(tmpdir(), "gjc-session-authority-compaction-cleanup-ok-")),
			"mappings.json",
		);
		const directory = dirname(filePath);
		const authority = new SmallThresholdFailingFileSessionAuthority(filePath);
		authority.set(mappingInput(mediumSelection));
		authority.set({ ...mappingInput(mediumSelection), chatId: "chat-2", operationId: "user-2" });
		expect(readdirSync(directory).filter(name => name.includes(".tmp-"))).toEqual([]);
	});
	test("compacts the valid WAL prefix on a live reload before appending past garbage", () => {
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-authority-live-wal-garbage-")), "mappings.json");
		const walPath = `${filePath}.wal`;
		const authority = new FileSessionAuthority(filePath);
		authority.set(mappingInput(mediumSelection));
		authority.set({ ...mappingInput(mediumSelection), chatId: "chat-2", operationId: "user-2" });
		expect(existsSync(walPath)).toBe(true);

		// Another process crashed midway through an append: a partial JSON line
		// remains at the end of the WAL.
		appendFileSync(
			walPath,
			'{"kind":"openwebui-gjc-session-authority-wal","version":1,"records":[{"chatId":"chat-pa',
			"utf8",
		);

		// The live instance detects the change on its next mutation, compacts the
		// valid prefix, and appends to a fresh WAL, so the acknowledged mutation
		// survives the next boot instead of being dropped at the malformed line.
		authority.set({ ...mappingInput(mediumSelection), chatId: "chat-3", operationId: "user-3" });

		expect(
			new FileSessionAuthority(filePath)
				.entries()
				.map(record => record.chatId)
				.sort(),
		).toEqual(["chat-1", "chat-2", "chat-3"]);
		expect(readFileSync(walPath, "utf8")).not.toContain("chat-pa");
	});
	class IdentityRefreshFailingFileSessionAuthority extends FailingFileSessionAuthority {
		identityFailure: Error | undefined;

		protected override refreshWalIdentity(writtenDigest: string, lastLineLength: number): void {
			if (this.identityFailure !== undefined) throw this.identityFailure;
			super.refreshWalIdentity(writtenDigest, lastLineLength);
		}
	}
	test("classifies a post-fsync identity refresh failure as a durability error", () => {
		const filePath = join(
			mkdtempSync(join(tmpdir(), "gjc-session-authority-identity-refresh-failure-")),
			"mappings.json",
		);
		const authority = new IdentityRefreshFailingFileSessionAuthority(filePath);
		authority.set(mappingInput(mediumSelection));
		authority.identityFailure = new Error("injected identity refresh failure");

		let error: unknown;
		try {
			authority.set({ ...mappingInput(mediumSelection), chatId: "chat-2", operationId: "user-2" });
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(SessionAuthorityDurabilityError);
		// The delta was fsynced before the identity refresh failed: memory and
		// boot both retain the WAL-visible state instead of rolling back.
		expect(
			authority
				.entries()
				.map(record => record.chatId)
				.sort(),
		).toEqual(["chat-1", "chat-2"]);
		expect(
			new FileSessionAuthority(filePath)
				.entries()
				.map(record => record.chatId)
				.sort(),
		).toEqual(["chat-1", "chat-2"]);
	});
	class ReloadFailingFileSessionAuthority extends FailingFileSessionAuthority {
		loadFailure: Error | undefined;
		protected override walCompactionThresholdBytes = 1024;

		protected override load(): void {
			if (this.loadFailure !== undefined) throw this.loadFailure;
			super.load();
		}
	}
	class BaseStatFailingFileSessionAuthority extends FailingFileSessionAuthority {
		baseStatFailure: Error | undefined;
		protected override walCompactionThresholdBytes = 1024;

		protected override refreshBaseIdentity(nextGeneration: string, digest: string): void {
			if (this.baseStatFailure !== undefined) throw this.baseStatFailure;
			super.refreshBaseIdentity(nextGeneration, digest);
		}
	}
	test("keeps the durability classification when the final base stat fails", () => {
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-authority-base-stat-failure-")), "mappings.json");
		const authority = new BaseStatFailingFileSessionAuthority(filePath);
		authority.set(mappingInput(mediumSelection));
		authority.baseStatFailure = new Error("injected base stat failure");

		let error: unknown;
		try {
			authority.set({
				...mappingInput(mediumSelection),
				chatId: "chat-2",
				operationId: "user-2",
				assistantText: `${padding}turn-2`,
			});
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(SessionAuthorityDurabilityError);
		// The base already contains the committed mutation; memory must not roll
		// back to a pre-mutation snapshot that a retry could duplicate.
		expect(
			authority
				.entries()
				.map(record => record.chatId)
				.sort(),
		).toEqual(["chat-1", "chat-2"]);
		expect(
			new FileSessionAuthority(filePath)
				.entries()
				.map(record => record.chatId)
				.sort(),
		).toEqual(["chat-1", "chat-2"]);
	});
	test("keeps the durability classification when the post-rewrite reload also fails", () => {
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-authority-reload-failure-")), "mappings.json");
		const authority = new ReloadFailingFileSessionAuthority(filePath);
		authority.set(mappingInput(mediumSelection));
		authority.directoryFailure = new Error("injected directory sync failure");
		authority.loadFailure = new Error("injected reload failure");

		let error: unknown;
		try {
			authority.set({
				...mappingInput(mediumSelection),
				chatId: "chat-2",
				operationId: "user-2",
				assistantText: `${padding}turn-2`,
			});
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(SessionAuthorityDurabilityError);
		// The renamed base may contain the mutation, so memory must not roll back
		// to a pre-mutation snapshot that a retry could duplicate.
		expect(
			authority
				.entries()
				.map(record => record.chatId)
				.sort(),
		).toEqual(["chat-1", "chat-2"]);
		expect(
			new FileSessionAuthority(filePath)
				.entries()
				.map(record => record.chatId)
				.sort(),
		).toEqual(["chat-1", "chat-2"]);
	});
	class RecoveryDirectoryFailingFileSessionAuthority extends FailingFileSessionAuthority {
		syncCalls = 0;
		postWriteFailure: Error | undefined;

		protected override appendWal(
			records: readonly SessionAuthorityRecord[],
			provisional: readonly { readonly key: string; readonly operation: ProvisionalSessionOperation }[],
		): void {
			// walFailure stays unset so the real append runs and writes the
			// complete first delta; the failure is then reported the way the real
			// append catch does, invoking the real recovery (unlink + directory
			// sync) with the pre-append identity (undefined for the first WAL).
			super.appendWal(records, provisional);
			if (this.postWriteFailure !== undefined) {
				this.recoverFailedWalAppend(undefined);
				throw this.postWriteFailure;
			}
		}

		protected override syncDirectory(): void {
			this.syncCalls += 1;
			// Call 1 is the WAL creation sync inside appendWal; call 2 is the
			// recovery's directory sync after the unlink.
			if (this.syncCalls === 2 && this.failure !== undefined) throw this.failure;
			super.syncDirectory();
		}
	}
	test("surfaces uncertain durability when the directory sync after a failed new WAL unlink fails", () => {
		const filePath = join(
			mkdtempSync(join(tmpdir(), "gjc-session-authority-wal-unlink-sync-failure-")),
			"mappings.json",
		);
		const authority = new RecoveryDirectoryFailingFileSessionAuthority(filePath);
		authority.set(mappingInput(mediumSelection));
		authority.syncCalls = 0;
		authority.postWriteFailure = new Error("injected append failure after a complete write");
		authority.failure = new Error("injected directory sync failure");

		let error: unknown;
		try {
			authority.set({ ...mappingInput(mediumSelection), chatId: "chat-2", operationId: "user-2" });
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(SessionAuthorityDurabilityError);
		// The deletion durability is unverified, so memory and boot both fall back
		// to the base-visible state instead of retrying a possibly-replayed write.
		expect(
			authority
				.entries()
				.map(record => record.chatId)
				.sort(),
		).toEqual(["chat-1"]);
		expect(
			new FileSessionAuthority(filePath)
				.entries()
				.map(record => record.chatId)
				.sort(),
		).toEqual(["chat-1"]);
	});
	test("a fresh authority sees a WAL-append mutation before any compaction", () => {
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-authority-wal-replay-")), "mappings.json");
		const authority = new FileSessionAuthority(filePath);
		authority.set(mappingInput(mediumSelection));
		authority.set({ ...mappingInput(mediumSelection), chatId: "chat-2", operationId: "user-2" });

		const baseDocument = JSON.parse(readFileSync(filePath, "utf8"));
		expect(baseDocument.mappings.map((record: { readonly chatId: string }) => record.chatId)).toEqual(["chat-1"]);
		expect(readFileSync(`${filePath}.wal`, "utf8")).toContain("chat-2");
		expect(
			new FileSessionAuthority(filePath)
				.entries()
				.map(record => record.chatId)
				.sort(),
		).toEqual(["chat-1", "chat-2"]);
	});
	test("compacts a threshold-crossing WAL into a normalized compact base", () => {
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-authority-compaction-")), "mappings.json");
		const walPath = `${filePath}.wal`;
		const authority = new FileSessionAuthority(filePath);
		authority.set(mappingInput(mediumSelection));
		const padding = "x".repeat(1024 * 1024);
		let previousWalSize = -1;
		let grew = 0;
		let compacted = false;
		let mutation = 0;
		for (; mutation < 400; mutation += 1) {
			authority.set({
				...mappingInput(mediumSelection),
				chatId: "chat-1",
				operationId: `user-${mutation}`,
				assistantText: `${padding}turn-${mutation}`,
			});
			const size = existsSync(walPath) ? statSync(walPath).size : 0;
			if (size > previousWalSize) grew += 1;
			// a compaction rewrite truncates the WAL inside the same mutation
			if (grew >= 3 && size < previousWalSize) {
				compacted = true;
				break;
			}
			previousWalSize = size;
		}
		expect(compacted).toBe(true);

		const baseBytes = readFileSync(filePath, "utf8");
		expect(baseBytes).not.toMatch(/\n {2}/);
		expect(baseBytes).toContain(`turn-${mutation}`);
		expect(existsSync(walPath)).toBe(false);
		const document = JSON.parse(baseBytes) as {
			readonly mappings: readonly {
				readonly journal: readonly { readonly result?: Record<string, unknown> }[];
			}[];
		};
		for (const mapping of document.mappings)
			for (const operation of mapping.journal) {
				if (operation.result !== undefined) expect(operation.result).not.toHaveProperty("events");
			}
		expect(new FileSessionAuthority(filePath).get("chat-1")?.assistantText).toContain(`turn-${mutation}`);
	});
	test("boot recovers the valid WAL prefix and compacts after a crash mid-append", () => {
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-authority-wal-garbage-")), "mappings.json");
		const walPath = `${filePath}.wal`;
		const authority = new FileSessionAuthority(filePath);
		authority.set(mappingInput(mediumSelection));
		authority.set({ ...mappingInput(mediumSelection), chatId: "chat-2", operationId: "user-2" });
		appendFileSync(
			walPath,
			'{"kind":"openwebui-gjc-session-authority-wal","version":1,"records":[{"chatId":"crashed"',
		);

		const booted = new FileSessionAuthority(filePath);
		expect(
			booted
				.entries()
				.map(record => record.chatId)
				.sort(),
		).toEqual(["chat-1", "chat-2"]);
		const document = JSON.parse(readFileSync(filePath, "utf8"));
		expect(document.mappings.map((record: { readonly chatId: string }) => record.chatId).sort()).toEqual([
			"chat-1",
			"chat-2",
		]);
		expect(existsSync(walPath)).toBe(false);
	});
	test("discards a stale WAL when the base is replaced behind the store's back", () => {
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-authority-external-edit-")), "mappings.json");
		const walPath = `${filePath}.wal`;
		const authority = new FileSessionAuthority(filePath);
		authority.set(mappingInput(mediumSelection));
		authority.set({ ...mappingInput(mediumSelection), chatId: "chat-2", operationId: "user-2" });

		const document = JSON.parse(readFileSync(filePath, "utf8"));
		const seeded = document.mappings[0];
		document.mappings.push({
			...seeded,
			chatId: "operator-chat",
			header: { ...seeded.header, chatId: "operator-chat" },
		});
		writeFileSync(filePath, JSON.stringify(document));

		const booted = new FileSessionAuthority(filePath);
		expect(
			booted
				.entries()
				.map(record => record.chatId)
				.sort(),
		).toEqual(["chat-1", "operator-chat"]);
		expect(existsSync(walPath)).toBe(false);
		booted.set({ ...mappingInput(mediumSelection), chatId: "chat-3", operationId: "user-3" });
		expect(
			new FileSessionAuthority(filePath)
				.entries()
				.map(record => record.chatId)
				.sort(),
		).toEqual(["chat-1", "chat-3", "operator-chat"]);
	});
	test("boot-compacts an oversized legacy authority document in one bounded step", () => {
		const directory = mkdtempSync(join(tmpdir(), "gjc-session-authority-boot-compaction-"));
		const filePath = join(directory, "mappings.json");
		try {
			const oversized = oversizedAuthorityJson(70 * 1024 * 1024);
			writeFileSync(filePath, oversized.json);
			const beforeBytes = statSync(filePath).size;
			expect(beforeBytes).toBeGreaterThan(AUTHORITY_BOOT_COMPACTION_THRESHOLD_BYTES);

			const store = new FileBackedSessionMappingStore(filePath);
			const afterBytes = statSync(filePath).size;
			expect(afterBytes).toBeLessThan(AUTHORITY_BOOT_COMPACTION_THRESHOLD_BYTES);
			const compacted = JSON.parse(readFileSync(filePath, "utf8")) as {
				readonly mappings: readonly {
					readonly journal: readonly { readonly result?: Record<string, unknown> }[];
				}[];
			};
			for (const mapping of compacted.mappings)
				for (const operation of mapping.journal)
					if (operation.result !== undefined) expect(operation.result).not.toHaveProperty("events");
			expect(store.bootCompaction).toEqual({ beforeBytes, afterBytes });
			expect(store.bootCompaction?.beforeBytes).toBeGreaterThan(store.bootCompaction?.afterBytes ?? 0);
			expect(store.get("chat-1")).toMatchObject({
				chatId: "chat-1",
				projectId: project.id,
				sessionId: "session-1",
				operationId: "operation-1",
			});
			// Compaction rewrites the in-memory journal to the normalized records
			// (consistent with the persisted file), so the legacy result events are
			// stripped there too; the record and its assistant text survive.
			expect(store.operation("chat-1", "operation-1")?.result?.events).toBeUndefined();
			expect(store.operation("chat-1", "operation-1")?.result?.assistantText).toBe("done");

			const secondBootBytes = statSync(filePath).size;
			const booted = new FileSessionAuthority(filePath);
			expect(statSync(filePath).size).toBe(secondBootBytes);
			expect(booted.lookupOperation("chat-1", "operation-1")?.result?.assistantText).toBe("done");
			expect(new FileBackedSessionMappingStore(filePath).bootCompaction).toBeUndefined();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	test("does not rewrite a boot authority document below the compaction threshold", () => {
		const directory = mkdtempSync(join(tmpdir(), "gjc-session-authority-boot-compaction-threshold-"));
		const filePath = join(directory, "mappings.json");
		try {
			const near = oversizedAuthorityJson(55 * 1024 * 1024);
			writeFileSync(filePath, near.json);
			const beforeBytes = statSync(filePath).size;
			expect(beforeBytes).toBeLessThan(AUTHORITY_BOOT_COMPACTION_THRESHOLD_BYTES);

			const store = new FileBackedSessionMappingStore(filePath);
			expect(statSync(filePath).size).toBe(beforeBytes);
			expect(store.bootCompaction).toBeUndefined();
			expect(store.operation("chat-1", "operation-1")?.result?.events).toHaveLength(near.eventCount);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	test("a no-op mutation does not grow the WAL", () => {
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-authority-noop-")), "mappings.json");
		const walPath = `${filePath}.wal`;
		const authority = new FileSessionAuthority(filePath);
		authority.set(mappingInput(mediumSelection));
		expect(existsSync(walPath)).toBe(false);

		authority.set(mappingInput(mediumSelection));
		expect(existsSync(walPath)).toBe(false);
	});
	test("reconciles a WAL-replayed pending operation on boot", () => {
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-authority-wal-reconcile-")), "mappings.json");
		const authority = new FileSessionAuthority(filePath);
		authority.set(mappingInput(mediumSelection));
		authority.beginOperation("chat-1", { id: "pending-op", kind: "prompt", detail: "hash" });
		expect(readFileSync(`${filePath}.wal`, "utf8")).toContain('"state":"pending"');

		const booted = new FileSessionAuthority(filePath);
		expect(booted.lookupOperation("chat-1", "pending-op")).toMatchObject({ state: "uncertain" });
		// boot compacts after reconciling: the WAL is truncated and the base carries the reconciled state
		expect(existsSync(`${filePath}.wal`)).toBe(false);
		expect(readFileSync(filePath, "utf8")).toContain('"state":"uncertain"');
	});
	test("durably records acknowledged create successors without replacing their predecessor", () => {
		withFileStore((store, filePath) => {
			const predecessor = store.set({
				chatId: "chat-successor",
				projectId: project.id,
				sessionId: "predecessor",
				rawFrameCursor: 0,
				eventCursor: 0,
				operationId: "predecessor-operation",
			});
			store.beginOperation("chat-successor", {
				id: "create-operation",
				ingressId: "create-operation",
				kind: "create",
				detail: "create-hash",
			});
			const successor = {
				sessionId: "successor",
				attachment: {
					descriptorPath: "/workspace/.gjc/state/sdk/successor.json",
					descriptorStat: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
					payloadDigest: "a".repeat(64),
					generation: 4,
					expectedSessionId: "successor",
					expectedCwd: "/workspace",
				},
			};
			expect(
				store.recordAcknowledgedSuccessor("chat-successor", "create-operation", "create-hash", successor),
			).toMatchObject({ state: "pending", acknowledgedSuccessor: successor });
			expect(
				store.recordAcknowledgedSuccessor("chat-successor", "create-operation", "create-hash", successor),
			).toMatchObject({ state: "pending", acknowledgedSuccessor: successor });
			expect(store.get("chat-successor")).toEqual(predecessor);
			expect(() =>
				store.recordAcknowledgedSuccessor("chat-successor", "create-operation", "create-hash", {
					...successor,
					sessionId: "different",
				}),
			).toThrow("conflicting acknowledged successor");
			expect(JSON.parse(readFileSync(filePath, "utf8")).mappings[0].sessionId).toBe("predecessor");

			const restarted = new FileBackedSessionMappingStore(filePath);
			expect(restarted.get("chat-successor")).toEqual(predecessor);
			expect(restarted.operation("chat-successor", "create-operation")).toMatchObject({
				state: "uncertain",
				acknowledgedSuccessor: successor,
			});
			expect(
				restarted.recordAcknowledgedSuccessor("chat-successor", "create-operation", "create-hash", successor),
			).toMatchObject({ state: "uncertain", acknowledgedSuccessor: successor });
			restarted.beginOperation("chat-successor", {
				id: "branch-operation",
				kind: "branch",
				detail: "branch-hash",
			});
			expect(
				restarted.recordAcknowledgedSuccessor("chat-successor", "branch-operation", "branch-hash", successor),
			).toMatchObject({ state: "pending", acknowledgedSuccessor: successor });
			expect(
				new FileBackedSessionMappingStore(filePath).operation("chat-successor", "branch-operation"),
			).toMatchObject({
				state: "uncertain",
				acknowledgedSuccessor: successor,
			});

			restarted.beginOperation("chat-successor", {
				id: "complete-operation",
				kind: "create",
				detail: "complete-hash",
			});
			restarted.recordAcknowledgedSuccessor("chat-successor", "complete-operation", "complete-hash", successor);
			restarted.completeOperationWithMapping(
				"chat-successor",
				"complete-operation",
				"published",
				{ ...predecessor, sessionId: "successor", operationId: "complete-operation" },
				"control",
			);
			expect(new FileBackedSessionMappingStore(filePath).operation("chat-successor", "complete-operation")).toEqual(
				expect.not.objectContaining({ acknowledgedSuccessor: expect.anything() }),
			);
		});
	});

	test("rejects authority model selections that runtime normalization drops", () => {
		withFileStore((store, filePath) => {
			store.set(mappingInput(mediumSelection));
			const document = JSON.parse(readFileSync(filePath, "utf8"));
			document.mappings[0].modelSelection.provider = "a%2Fb";

			writeFileSync(filePath, JSON.stringify(document));

			expect(() => new FileBackedSessionMappingStore(filePath)).toThrow("not a valid v2 authority");
		});
	});

	test("round-trips a normalized tuple through a file-backed reload", () => {
		withFileStore((store, filePath) => {
			store.set(mappingInput(mediumSelection));
			expect(new FileBackedSessionMappingStore(filePath).get("chat-1")?.modelSelection).toEqual(mediumSelection);
		});
	});

	test("includes the normalized tuple in the mapping payload hash", () => {
		withFileStore(store => {
			const mapping = store.set(mappingInput(mediumSelection));
			expect(buildSessionMappingPayloadHash(mapping)).not.toBe(
				buildSessionMappingPayloadHash({ ...mapping, modelSelection: undefined }),
			);
		});
	});

	test("quarantines legacy mappings when loading a file-backed mapping store", () => {
		withFileStore((store, filePath) => {
			const mapping = store.set(mappingInput(mediumSelection));
			writeFileSync(
				filePath,
				JSON.stringify({ mappings: [{ ...mapping, modelSelection: { ...mediumSelection, provider: "a%2Fb" } }] }),
			);
			expect(new FileBackedSessionMappingStore(filePath).get("chat-1")).toBeUndefined();
		});
	});

	test("rejects authority model selections with fields normalization would drop", () => {
		withFileStore((store, filePath) => {
			store.set(mappingInput(mediumSelection));
			const document = JSON.parse(readFileSync(filePath, "utf8"));
			document.mappings[0].modelSelection.canonicalId = "gjc/anthropic/claude-sonnet-4:medium";

			writeFileSync(filePath, JSON.stringify(document));

			expect(() => new FileBackedSessionMappingStore(filePath)).toThrow("not a valid v2 authority");
		});
	});
	test("fails closed on corrupt v2 authority records", () => {
		withFileStore((store, filePath) => {
			const mapping = store.set(mappingInput(mediumSelection));
			writeFileSync(
				filePath,
				JSON.stringify({
					kind: "openwebui-gjc-session-authority",
					version: 2,
					mappings: [
						{
							...mapping,
							rawFrameCursor: -1,
							modelSelection: { ...mediumSelection, thinkingLevel: "invalid" },
							journal: [{ id: "user-1", kind: "unknown", state: "complete", startedAt: "not-a-date" }],
						},
					],
				}),
			);
			expect(() => new FileBackedSessionMappingStore(filePath)).toThrow("not a valid v2 authority");
		});
	});
	test("fails closed when persisted attachment proof lacks descriptor identity", () => {
		withFileStore((store, filePath) => {
			const mapping = store.set(mappingInput(mediumSelection));
			writeFileSync(
				filePath,
				JSON.stringify({
					kind: "openwebui-gjc-session-authority",
					version: 2,
					mappings: [
						{
							...mapping,
							attachment: {
								descriptorPath: "/workspace/.gjc/endpoints/session-1.json",
								descriptorStat: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
								generation: 0,
								expectedSessionId: "session-1",
								expectedCwd: "/workspace",
							},
						},
					],
				}),
			);
			expect(() => new FileBackedSessionMappingStore(filePath)).toThrow("not a valid v2 authority");
		});
	});
	test("retains complete pane proof structurally but rejects partial pane proof", () => {
		withFileStore((_store, filePath) => {
			const valid = validAuthorityDocument();
			valid.mappings[0].attachment = {
				descriptorPath: "/workspace/.gjc/endpoints/session-1.json",
				descriptorStat: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
				payloadDigest: "0000000000000000000000000000000000000000000000000000000000000000",
				generation: 4,
				expectedSessionId: "session-1",
				expectedCwd: "/workspace",
				tmuxSocket: "default",
				tmuxPane: "%10",
				tmuxPanePid: 42,
				tmuxOwnershipTag: "gjc",
				ownedAt: "2026-01-01T00:00:00.000Z",
			};
			writeFileSync(filePath, JSON.stringify(valid));
			expect(new FileBackedSessionMappingStore(filePath).get("chat-1")?.attachment).toMatchObject({
				payloadDigest: "0000000000000000000000000000000000000000000000000000000000000000",
				tmuxPane: "%10",
				tmuxPanePid: 42,
				tmuxOwnershipTag: "gjc",
			});

			const missingDigest = validAuthorityDocument();
			missingDigest.mappings[0].attachment = { ...valid.mappings[0].attachment, payloadDigest: undefined };
			writeFileSync(filePath, JSON.stringify(missingDigest));
			expect(() => new FileBackedSessionMappingStore(filePath)).toThrow("not a valid v2 authority");

			const splitGeneration = validAuthorityDocument();
			splitGeneration.mappings[0].attachment = { ...valid.mappings[0].attachment, generation: 5 };
			writeFileSync(filePath, JSON.stringify(splitGeneration));
			expect(() => new FileBackedSessionMappingStore(filePath)).toThrow("not a valid v2 authority");
		});
	});
	test.each([
		[
			"tmux field",
			(successor: any): void => {
				successor.attachment.tmuxPane = "%10";
			},
		],
		[
			"session file",
			(successor: any): void => {
				successor.attachment.sessionFile = "/workspace/session.jsonl";
			},
		],
		[
			"credential",
			(successor: any): void => {
				successor.attachment.token = "secret";
			},
		],
		[
			"endpoint URL",
			(successor: any): void => {
				successor.attachment.url = "http://localhost";
			},
		],
		[
			"unknown key",
			(successor: any): void => {
				successor.extra = true;
			},
		],
		[
			"session ID mismatch",
			(successor: any): void => {
				successor.sessionId = "session-other";
			},
		],
	] as const)("fails closed on an invalid acknowledged successor %s", (_field, corrupt) => {
		withFileStore((_store, filePath) => {
			const document = validAuthorityDocument();
			const operation = document.mappings[0].journal[0];
			operation.kind = "create";
			operation.state = "pending";
			delete operation.completedAt;
			delete operation.result;
			operation.acknowledgedSuccessor = acknowledgedSuccessor();
			corrupt(operation.acknowledgedSuccessor);
			writeFileSync(filePath, JSON.stringify(document));
			expect(() => new FileBackedSessionMappingStore(filePath)).toThrow("not a valid v2 authority");
		});
	});
	test.each([
		[
			"non-create operation",
			(operation: any): void => {
				operation.kind = "prompt";
			},
		],
		[
			"complete operation",
			(operation: any): void => {
				operation.state = "complete";
				operation.completedAt = "2026-01-01T00:00:00.000Z";
			},
		],
		[
			"conflict operation",
			(operation: any): void => {
				operation.state = "conflict";
			},
		],
	] as const)("fails closed on an acknowledged successor for a %s", (_field, corrupt) => {
		withFileStore((_store, filePath) => {
			const document = validAuthorityDocument();
			const operation = document.mappings[0].journal[0];
			operation.kind = "create";
			operation.state = "pending";
			delete operation.completedAt;
			delete operation.result;
			operation.acknowledgedSuccessor = acknowledgedSuccessor();
			corrupt(operation);
			writeFileSync(filePath, JSON.stringify(document));
			expect(() => new FileBackedSessionMappingStore(filePath)).toThrow("not a valid v2 authority");
		});
	});
	test.each(["pending", "uncertain"] as const)("loads a %s create acknowledged successor", state => {
		withFileStore((_store, filePath) => {
			const document = validAuthorityDocument();
			const operation = document.mappings[0].journal[0];
			operation.kind = "create";
			operation.state = state;
			delete operation.completedAt;
			delete operation.result;
			operation.acknowledgedSuccessor = acknowledgedSuccessor();
			writeFileSync(filePath, JSON.stringify(document));
			expect(() => new FileBackedSessionMappingStore(filePath)).not.toThrow();
		});
	});
	test.each([
		[
			"document",
			(document: any) => {
				document.unexpected = true;
			},
		],
		[
			"mapping",
			(document: any) => {
				document.mappings[0].unexpected = true;
			},
		],
		[
			"header",
			(document: any) => {
				document.mappings[0].header.unexpected = true;
			},
		],
		[
			"event",
			(document: any) => {
				document.mappings[0].events[0].unexpected = true;
			},
		],
		[
			"selection",
			(document: any) => {
				document.mappings[0].modelSelection.unexpected = true;
			},
		],
		[
			"attachment",
			(document: any) => {
				document.mappings[0].attachment.unexpected = true;
			},
		],
		[
			"operation",
			(document: any) => {
				document.mappings[0].journal[0].unexpected = true;
			},
		],
		[
			"result",
			(document: any) => {
				document.mappings[0].journal[0].result.unexpected = true;
			},
		],
		[
			"provisional",
			(document: any) => {
				document.provisionalOperations[0].unexpected = true;
			},
		],
	] as const)("fails closed on an unknown key in the v2 %s", (_field, corrupt) => {
		withFileStore((_store, filePath) => {
			const document = validAuthorityDocument();
			corrupt(document);
			writeFileSync(filePath, JSON.stringify(document));
			expect(() => new FileBackedSessionMappingStore(filePath)).toThrow("not a valid v2 authority");
		});
	});
	test.each([
		[
			"event payload",
			(document: any) => {
				document.mappings[0].events[0].payload = [];
			},
		],
		[
			"selection enum",
			(document: any) => {
				document.mappings[0].modelSelection.thinkingLevel = "invalid";
			},
		],
		[
			"attachment stat",
			(document: any) => {
				document.mappings[0].attachment.descriptorStat.ino = -1;
			},
		],
		[
			"attachment digest missing",
			(document: any) => {
				delete document.mappings[0].attachment.payloadDigest;
			},
		],
		[
			"attachment digest malformed",
			(document: any) => {
				document.mappings[0].attachment.payloadDigest = "not-a-sha256-digest";
			},
		],
		[
			"operation completion",
			(document: any) => {
				document.mappings[0].journal[0].completedAt = "not-a-date";
			},
		],
		[
			"result cursor",
			(document: any) => {
				document.mappings[0].journal[0].result.mapping.eventCursor = -1;
			},
		],
		[
			"provisional timestamp",
			(document: any) => {
				document.provisionalOperations[0].startedAt = "not-a-date";
			},
		],
	] as const)("fails closed on corrupt v2 %s", (_field, corrupt) => {
		withFileStore((_store, filePath) => {
			const document = validAuthorityDocument();
			corrupt(document);
			writeFileSync(filePath, JSON.stringify(document));
			expect(() => new FileBackedSessionMappingStore(filePath)).toThrow("not a valid v2 authority");
		});
	});
	test("fails closed when an immutable operation attachment belongs to another session", () => {
		withFileStore((_store, filePath) => {
			const document = validAuthorityDocument();
			document.mappings[0].journal[0].result.mapping.attachment = {
				descriptorPath: "/workspace/.gjc/endpoints/session-other.json",
				descriptorStat: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
				payloadDigest: "0000000000000000000000000000000000000000000000000000000000000000",
				generation: 4,
				expectedSessionId: "session-other",
				expectedCwd: "/workspace",
			};
			writeFileSync(filePath, JSON.stringify(document));
			expect(() => new FileBackedSessionMappingStore(filePath)).toThrow("not a valid v2 authority");
		});
	});

	test("returns cached duplicate content after store reload without rerunning", async () => {
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-mapping-")), "mappings.json");
		const firstRunner = new FakeGjcTurnRunner();
		const firstStore = new FileBackedSessionMappingStore(filePath);
		const first = createGjcRoutingLiveGatewayRunner({ turnRunner: firstRunner, mappings: firstStore });
		expect(
			await first.run({
				project,
				prompt: "hello",
				chatId: "chat-1",
				messageId: "assistant-1",
				userMessageId: "user-1",
				userMessageParentId: null,
				continued: false,
			}),
		).toEqual({ content: "new:hello" });

		const secondRunner = new FakeGjcTurnRunner();
		const secondStore = new FileBackedSessionMappingStore(filePath);
		const second = createGjcRoutingLiveGatewayRunner({ turnRunner: secondRunner, mappings: secondStore });

		expect(
			await second.run({
				project,
				prompt: "hello",
				chatId: "chat-1",
				messageId: "assistant-1",
				userMessageId: "user-1",
				userMessageParentId: null,
				continued: false,
			}),
		).toEqual({ content: "new:hello" });
		expect(secondRunner.starts).toHaveLength(0);
		expect(secondRunner.switches).toHaveLength(0);
		expect(secondRunner.continues).toHaveLength(0);
	});
	test("replays an older persisted prompt after later completions without runner effects", async () => {
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-mapping-")), "mappings.json");
		const firstRunner = new FakeGjcTurnRunner();
		const first = createGjcRoutingLiveGatewayRunner({
			turnRunner: firstRunner,
			mappings: new FileBackedSessionMappingStore(filePath),
		});
		const firstTurn = {
			project,
			prompt: "first",
			chatId: "chat-1",
			messageId: "assistant-1",
			userMessageId: "user-1",
			userMessageParentId: null,
			continued: false,
		};
		expect(await first.run(firstTurn)).toEqual({ content: "new:first" });
		expect(
			await first.run({
				...firstTurn,
				prompt: "second",
				messageId: "assistant-2",
				userMessageId: "user-2",
				userMessageParentId: "assistant-1",
				continued: true,
			}),
		).toEqual({ content: "continued:second" });

		const replayRunner = new FakeGjcTurnRunner();
		const replay = createGjcRoutingLiveGatewayRunner({
			turnRunner: replayRunner,
			mappings: new FileBackedSessionMappingStore(filePath),
		});
		expect(await replay.run(firstTurn)).toEqual({ content: "new:first" });
		expect(replayRunner.starts).toHaveLength(0);
		expect(replayRunner.switches).toHaveLength(0);
		expect(replayRunner.states).toHaveLength(0);
		expect(replayRunner.continues).toHaveLength(0);
		expect(replayRunner.gateResponses).toHaveLength(0);
	});
	test("isolates persisted create, resume, and replay mappings by principal", async () => {
		const root = mkdtempSync(join(tmpdir(), "gjc-principal-session-mapping-"));
		const filePath = join(root, "mappings.json");
		const firstRunner = new FakeGjcTurnRunner();
		const first = createGjcRoutingLiveGatewayRunner({
			turnRunner: firstRunner,
			mappings: new FileBackedSessionMappingStore(filePath),
		});
		const firstTurn = (ownerUserId: string, prompt: string) => ({
			project,
			prompt,
			chatId: "shared-chat",
			messageId: "assistant-create",
			userMessageId: "shared-create",
			userMessageParentId: null,
			continued: false,
			ownerUserId,
		});
		const resumeTurn = (ownerUserId: string, prompt: string) => ({
			project,
			prompt,
			chatId: "shared-chat",
			messageId: "assistant-resume",
			userMessageId: "shared-resume",
			userMessageParentId: "assistant-create",
			continued: true,
			ownerUserId,
		});
		try {
			await expect(first.run(firstTurn("principal-a", "from-a"))).resolves.toEqual({ content: "new:from-a" });
			await expect(first.run(firstTurn("principal-b", "from-b"))).resolves.toEqual({ content: "new:from-b" });
			await expect(first.run(resumeTurn("principal-a", "resume-a"))).resolves.toEqual({
				content: "continued:resume-a",
			});
			await expect(first.run(resumeTurn("principal-b", "resume-b"))).resolves.toEqual({
				content: "continued:resume-b",
			});

			const persisted = new FileBackedSessionMappingStore(filePath);
			expect(persisted.get("shared-chat")).toBeUndefined();
			expect(persisted.getScoped({ principalId: "principal-a", chatId: "shared-chat" })).toMatchObject({
				principalId: "principal-a",
				assistantText: "continued:resume-a",
				operationId: "shared-resume",
			});
			expect(persisted.getScoped({ principalId: "principal-b", chatId: "shared-chat" })).toMatchObject({
				principalId: "principal-b",
				assistantText: "continued:resume-b",
				operationId: "shared-resume",
			});

			const replayRunner = new FakeGjcTurnRunner();
			const replay = createGjcRoutingLiveGatewayRunner({
				turnRunner: replayRunner,
				mappings: new FileBackedSessionMappingStore(filePath),
			});
			await expect(replay.run(firstTurn("principal-a", "from-a"))).resolves.toEqual({ content: "new:from-a" });
			await expect(replay.run(firstTurn("principal-b", "from-b"))).resolves.toEqual({ content: "new:from-b" });
			await expect(replay.run(resumeTurn("principal-a", "resume-a"))).resolves.toEqual({
				content: "continued:resume-a",
			});
			await expect(replay.run(resumeTurn("principal-b", "resume-b"))).resolves.toEqual({
				content: "continued:resume-b",
			});
			expect(replayRunner.starts).toHaveLength(0);
			expect(replayRunner.switches).toHaveLength(0);
			expect(replayRunner.continues).toHaveLength(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	test("persists endpoint-backed provisional create authority before a transcript exists and reconciles it on restart", () => {
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-mapping-")), "mappings.json");
		const first = new FileBackedSessionMappingStore(filePath);
		first.reserveProvisionalOperation({
			id: "user-1",
			kind: "create",
			ingressId: "user-1",
			chatId: "chat-1",
			projectId: project.id,
			detail: "hash",
		});
		const attachment = {
			descriptorPath: "/workspace/project/.gjc/state/sdk/session-created.json",
			descriptorStat: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
			payloadDigest: "0000000000000000000000000000000000000000000000000000000000000000",
			generation: 4,
			expectedSessionId: "session-created",
			expectedCwd: "/workspace/project",
			tmuxSocket: "/tmp/tmux-1000/default",
			tmuxPane: "%42",
			tmuxPanePid: 42,
			tmuxOwnershipTag: "gjc:session-created",
			ownedAt: "2026-07-20T00:00:00.000Z",
		};
		first.attachProvisionalOperation("chat-1", "user-1", {
			sessionId: "session-created",
			attachment,
		});

		const second = new FileBackedSessionMappingStore(filePath);
		expect(second.get("chat-1")).toBeUndefined();
		expect(second.provisionalOperation("chat-1", "user-1")).toEqual({
			id: "user-1",
			kind: "create",
			ingressId: "user-1",
			chatId: "chat-1",
			projectId: project.id,
			detail: "hash",
			state: "uncertain",
			startedAt: expect.any(String),
			sessionId: "session-created",
			attachment,
		});
		expect(second.provisionalOperation("chat-1", "user-1")?.attachment?.expectedSessionId).toBe(
			second.provisionalOperation("chat-1", "user-1")?.sessionId,
		);
		expect(() =>
			second.reserveProvisionalOperation({
				id: "user-1",
				kind: "create",
				ingressId: "user-1",
				chatId: "chat-1",
				projectId: project.id,
				detail: "hash",
			}),
		).toThrow("requires reconciliation");
	});

	test("cold-resumes only the file-backed branch successor after restart", async () => {
		const root = mkdtempSync(join(tmpdir(), "gjc-branch-restart-"));
		const sessionRoot = join(root, ".gjc", "sessions");
		mkdirSync(sessionRoot, { recursive: true });
		const filePath = join(root, "mappings.json");
		const endpointRoot = join(root, ".gjc", "state", "sdk");
		const predecessorPath = join(sessionRoot, "predecessor.jsonl");
		const successorPath = join(realpathSync(root), ".gjc", "sessions", "successor.jsonl");
		writeFileSync(
			predecessorPath,
			`${JSON.stringify({ type: "session", version: 3, id: "predecessor", timestamp: "2026-01-01T00:00:00.000Z", cwd: root })}\n`,
		);
		class BranchFakeGjcTurnRunner extends FakeGjcTurnRunner {
			async runControl(
				_input: LiveGatewayRunnerInput,
				_mapping: Parameters<NonNullable<GjcTurnRunner["runControl"]>>[1],
				_lifecycle: Parameters<NonNullable<GjcTurnRunner["runControl"]>>[2],
			): Promise<GjcControlResult> {
				writeFileSync(
					successorPath,
					`${JSON.stringify({ type: "session", version: 3, id: "successor", timestamp: "2026-01-01T00:00:00.000Z", cwd: root })}\n`,
				);
				mkdirSync(endpointRoot, { recursive: true });
				const descriptorPath = join(endpointRoot, "successor.json");
				const descriptor = JSON.stringify({ version: 1, url: "ws://127.0.0.1:1", token: "successor-token" });
				writeFileSync(descriptorPath, descriptor);
				const descriptorStat = statSync(descriptorPath);
				const proof = {
					descriptorPath,
					descriptorStat: {
						dev: descriptorStat.dev,
						ino: descriptorStat.ino,
						size: descriptorStat.size,
						mtimeMs: descriptorStat.mtimeMs,
					},
					payloadDigest: createHash("sha256").update(descriptor).digest("hex"),
					generation: descriptorStat.mtimeMs,
					expectedSessionId: "successor",
					expectedCwd: root,
				};
				return {
					sessionId: "successor",
					sessionFile: successorPath,
					attachment: proof,
				};
			}
		}
		const branchRunner = new BranchFakeGjcTurnRunner();
		const branchProject = { ...project, cwd: root, sessionRoot };
		const firstStore = new FileBackedSessionMappingStore(filePath);
		firstStore.set({
			...mappingInput(mediumSelection),
			sessionId: "predecessor",
			sessionFile: predecessorPath,
			activeLeaf: "leaf-predecessor",
		});
		const first = createGjcRoutingLiveGatewayRunner({
			turnRunner: branchRunner,
			mappings: firstStore,
			ownerUserId: "owner-1",
		});

		await first.run({
			project: branchProject,
			prompt: "",
			chatId: "chat-1",
			messageId: "assistant-1",
			userMessageId: "branch-1",
			userMessageParentId: "assistant-1",
			continued: true,
			control: { operation: "branch" },
			messageMetadata: {
				gjc_adapter: {
					ownerUserId: "owner-1",
					projectId: project.id,
					gjcSessionId: "predecessor",
					gjcEntryId: "assistant-1",
				},
			},
		});

		expect(readFileSync(successorPath, "utf8")).toContain('"id":"successor"');
		const persisted = new FileBackedSessionMappingStore(filePath).get("chat-1");
		expect(persisted).toMatchObject({
			sessionId: "successor",
			sessionFile: successorPath,
			attachment: {
				expectedSessionId: "successor",
				expectedCwd: root,
			},
		});

		const coldRunner = new FakeGjcTurnRunner();
		coldRunner.state = {
			sessionFile: successorPath,
			activeLeaf: "leaf-successor",
			rawFrameCursor: 0,
			eventCursor: 0,
		};
		const cold = createGjcRoutingLiveGatewayRunner({
			turnRunner: coldRunner,
			mappings: new FileBackedSessionMappingStore(filePath),
		});
		await cold.run({
			project: branchProject,
			prompt: "continue successor",
			chatId: "chat-1",
			messageId: "assistant-2",
			userMessageId: "user-2",
			userMessageParentId: "assistant-1",
			continued: true,
		});
		expect(coldRunner.continues).toHaveLength(1);
		expect(coldRunner.switches).toHaveLength(1);
		expect(coldRunner.switches[0]).toMatchObject({ sessionId: "successor", sessionFile: successorPath });
		expect(coldRunner.switches[0]?.sessionFile).not.toBe(predecessorPath);
		expect(coldRunner.continues[0]).toMatchObject({ sessionId: "successor" });
	});

	test("enqueues a stable session_mapping outbox operation when provided", async () => {
		const turnRunner = new FakeGjcTurnRunner();
		const mappings = new SessionMappingStore();
		const outbox = new InMemoryOutboxStore();
		const runner = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings, outbox, ownerUserId: "owner-1" });

		await runner.run({
			project,
			prompt: "hello",
			chatId: "chat-1",
			messageId: "assistant-1",
			userMessageId: "user-1",
			userMessageParentId: null,
			continued: false,
		});

		const operations = outbox.listPending();
		const sessionMappingPayloadHash = operations[0]?.payloadHash;
		const eventPayloadHash = operations[1]?.payloadHash;
		expect(operations).toHaveLength(2);
		expect(operations).toMatchObject([
			{
				operationId: "user-1",
				ownerUserId: "owner-1",
				projectId: project.id,
				chatId: "chat-1",
				kind: "session_mapping",
				state: "pending",
				payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
			},
			{
				operationId: "user-1:event",
				ownerUserId: "owner-1",
				projectId: project.id,
				chatId: "chat-1",
				kind: "event",
				state: "pending",
				payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
			},
		]);
		expect(operations[0]?.operationId).not.toBe(operations[1]?.operationId);
		expect(outbox.get("user-1")?.payloadHash).toBe(sessionMappingPayloadHash);
		expect(outbox.get("user-1:event")?.payloadHash).toBe(eventPayloadHash);
	});
	test("uses the authenticated principal for scoped projection rows and synthesized replay", async () => {
		const outbox = new InMemoryOutboxStore();
		const mappings = new SessionMappingStore();
		const runner = createGjcRoutingLiveGatewayRunner({
			turnRunner: new FakeGjcTurnRunner(),
			mappings,
			outbox,
			ownerUserId: "admin-1",
		});

		await runner.run({
			project,
			prompt: "normal turn",
			chatId: "normal-chat",
			messageId: "normal-assistant",
			userMessageId: "normal-user-message",
			userMessageParentId: null,
			continued: false,
			ownerUserId: "normal-1",
		});

		expect(outbox.listPending()).toMatchObject([
			{ operationId: "normal-user-message", principalId: "normal-1", ownerUserId: "normal-1" },
			{ operationId: "normal-user-message:event", principalId: "normal-1", ownerUserId: "normal-1" },
		]);
		synthesizeProjectionRows(outbox, mappings, "admin-1", "admin-1");
		expect(outbox.listPending()).toHaveLength(2);

		await runner.run({
			project,
			prompt: "admin turn",
			chatId: "admin-chat",
			messageId: "admin-assistant",
			userMessageId: "admin-user-message",
			userMessageParentId: null,
			continued: false,
			ownerUserId: "admin-1",
		});

		expect(outbox.listPending().filter(operation => operation.chatId === "admin-chat")).toMatchObject([
			{ operationId: "admin-user-message", principalId: "admin-1", ownerUserId: "admin-1" },
			{ operationId: "admin-user-message:event", principalId: "admin-1", ownerUserId: "admin-1" },
		]);
	});

	test("preserves the authenticated principal for session.new control publication and synthesis", async () => {
		const root = mkdtempSync(join(tmpdir(), "gjc-session-new-projection-"));
		const mappingFile = join(root, "mappings.json");
		const sessionRoot = join(root, ".gjc", "sessions");
		const controlPrincipal = "normal-control-user";
		const adminPrincipal = "admin-1";
		const turn: LiveGatewayRunnerInput = {
			project: { ...project, cwd: root, sessionRoot },
			prompt: "create a session",
			chatId: "control-chat",
			messageId: "control-assistant",
			userMessageId: "control-session-new",
			userMessageParentId: null,
			continued: true,
			ownerUserId: controlPrincipal,
			control: { operation: "session.new" },
		};
		class ControlRunner extends FakeGjcTurnRunner {
			async runControl(
				input: LiveGatewayRunnerInput,
				_mapping: Parameters<NonNullable<GjcTurnRunner["runControl"]>>[1],
				lifecycle: Parameters<NonNullable<GjcTurnRunner["runControl"]>>[2],
			): Promise<GjcControlResult> {
				const sessionId = "session-control";
				const sessionFile = join(sessionRoot, `${sessionId}.jsonl`);
				const attachment = attachmentProof({ cwd: input.project.cwd, sessionId });
				await lifecycle.handoff(
					{
						...lifecycle.address,
						sessionId,
						sessionFile,
						recoveryAttachment: attachment,
					},
					attachment,
				);
				return {
					sessionId,
					sessionFile,
					attachment,
					result: {
						text: "session created",
						events: [{ type: "assistant", text: "session created" }],
						sessionFile,
						rawFrameCursor: 2,
						eventCursor: 1,
						attachment,
					},
				};
			}
		}
		const mappings = new FileBackedSessionMappingStore(mappingFile);
		mappings.setScoped(
			{ principalId: controlPrincipal, chatId: turn.chatId },
			{ ...mappingInput(mediumSelection), chatId: turn.chatId },
		);
		const outbox = new InMemoryOutboxStore();
		try {
			const first = createGjcRoutingLiveGatewayRunner({
				turnRunner: new ControlRunner(),
				mappings,
				outbox,
				ownerUserId: adminPrincipal,
			});
			await first.run(turn);
			expect(outbox.listPending()).toMatchObject([
				{
					operationId: turn.userMessageId,
					principalId: controlPrincipal,
					ownerUserId: controlPrincipal,
					chatId: turn.chatId,
				},
				{
					operationId: `${turn.userMessageId}:event`,
					principalId: controlPrincipal,
					ownerUserId: controlPrincipal,
					chatId: turn.chatId,
				},
			]);

			const restartedMappings = new FileBackedSessionMappingStore(mappingFile);
			synthesizeProjectionRows(outbox, restartedMappings, adminPrincipal, adminPrincipal);
			expect(outbox.listPending()).toMatchObject([
				{ operationId: turn.userMessageId, principalId: controlPrincipal, ownerUserId: controlPrincipal },
				{
					operationId: `${turn.userMessageId}:event`,
					principalId: controlPrincipal,
					ownerUserId: controlPrincipal,
				},
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	test("marks a branch uncertain and clears cancellation after post-RPC abort", async () => {
		let fixture!: ReturnType<typeof setupPublicSdkBranchFixture>;
		const controller = new AbortController();
		let barrierHits = 0;
		fixture = await setupPublicSdkBranchFixture("branch_regenerate", phase => {
			expect(phase).toBe("between_branch_phases");
			barrierHits += 1;
			controller.abort();
		});
		try {
			await expect(fixture.runner.run({ ...fixture.turn, signal: controller.signal })).rejects.toMatchObject({
				name: "GjcTurnCancelledError",
			});
			expect(barrierHits).toBe(1);
			expect(
				new FileBackedSessionMappingStore(fixture.mappingFile).operationScoped({
					principalId: "owner-q16",
					chatId: "chat-q16",
				}, "branch-q16"),
			).toMatchObject({
				state: "uncertain",
				acknowledgedSuccessor: {
					sessionId: "sdk-session-successor",
				},
			});
			await expect(
				fixture.runner.run({ ...fixture.turn, signal: new AbortController().signal }),
			).rejects.toThrow("requires reconciliation");
		} finally {
			fixture.dispose();
		}
	});
	test.each([
		["start", false],
		["continuation", true],
	] as const)("reports the returned %s selection instead of its requested alias", async (_label, continued) => {
		const turnRunner = new FakeGjcTurnRunner();
		turnRunner.startModelSelection = mediumSelection;
		turnRunner.continueModelSelection = mediumSelection;
		const mappings = new SessionMappingStore();
		if (continued) mappings.set(mappingInput(mediumSelection));
		const transcript: string[] = [];
		const runner = createGjcRoutingLiveGatewayRunner({
			turnRunner,
			mappings,
			requestedModelId: () => "foreign-callback-must-not-win",
			createNeutralModelReader: () => neutralReader(transcript),
		});

		const result = await runner.run({
			...turn(continued ? "chat-1" : "chat-neutral", "user-2", continued),
			requestedModelId: "gjc",
		});
		const selectedInput = continued ? turnRunner.continues[0] : turnRunner.starts[0];
		expect(transcript).toEqual(["catalog", "state", "stop"]);
		expect(selectedInput?.modelSelection).toEqual(lowSelection);
		if (continued) {
			expect(turnRunner.states).toHaveLength(1);
			expect(selectedInput).toMatchObject({
				activeLeaf: "leaf-1",
				rawFrameCursor: 7,
				eventCursor: 3,
			});
		}
		expect(mappings.get(continued ? "chat-1" : "chat-neutral")?.modelSelection).toEqual(mediumSelection);
		expect(result.model).toBe("gjc/anthropic/claude-sonnet-4:medium");
	});
	test("composes authenticated Q16 branch regeneration through public SDK persistence and restart", async () => {
		const fixture = await setupPublicSdkBranchFixture("branch_regenerate");
		try {
			const result = await fixture.runner.run(fixture.turn);
			expect(result).toMatchObject({ content: "successor assistant" });
			expectSdkRequest(fixture.server.frames, "query_request", "session.branch_candidates");
			const branch = expectSdkRequest(fixture.server.frames, "control_request", "session.branch");
			expect(branch.input).toEqual({ entryId: "entry-q16" });
			expect(fixture.server.persistenceObservedBeforePrompt).toBe(false);

			const ordered = fixture.server.frames.map(frame =>
				frame.type === "query_request" ? frame.query : frame.operation,
			);
			const branchIndex = ordered.indexOf("session.branch");
			const successorQ14Index = ordered.findIndex(
				(operation, index) => index > branchIndex && operation === "session.metadata",
			);
			expect(ordered.indexOf("session.branch_candidates")).toBeLessThan(branchIndex);
			expect(branchIndex).toBeLessThan(successorQ14Index);
			expect(successorQ14Index).toBeLessThan(ordered.indexOf("turn.prompt"));

			const persisted = new FileBackedSessionMappingStore(fixture.mappingFile).getScoped({
				principalId: "owner-q16",
				chatId: "chat-q16",
			});
			expect(persisted).toMatchObject({
				sessionId: "sdk-session-successor",
				sessionFile: fixture.successorPath,
				operationId: "branch-q16",
			});
			expect(persisted?.attachment).toMatchObject({
				descriptorPath: join(fixture.project.cwd, ".gjc", "state", "sdk", "sdk-session-successor.json"),
				expectedSessionId: "sdk-session-successor",
				expectedCwd: fixture.project.cwd,
			});
			expect(persisted?.attachment).not.toHaveProperty("tmuxPane");
			expect(persisted?.attachment).not.toHaveProperty("tmuxOwnershipTag");
			const restartedTurnRunner = createPublicSdkGjcTurnRunner(fixture.runnerInput);
			const restartAddress = {
				cwd: fixture.project.cwd,
				sessionRoot: fixture.project.sessionRoot ?? "",
				projectId: fixture.project.id,
				chatId: "chat-q16",
				sessionId: "sdk-session-successor",
				sessionFile: fixture.successorPath,
			};
			await withLifecyclePublication(restartedTurnRunner, restartAddress, lifecycle =>
				restartedTurnRunner.switchSession({ ...restartAddress, lifecycle }),
			);
			await withLifecyclePublication(restartedTurnRunner, restartAddress, lifecycle =>
				restartedTurnRunner.continueSession({
					...restartAddress,
					text: "restart successor",
					userMessageId: "restart-q16",
					rawFrameCursor: 0,
					eventCursor: 0,
					operationId: "restart-q16",
					lifecycle,
				}),
			);
			expect(
				fixture.server.frames.filter(
					frame => frame.type === "control_request" && frame.operation === "session.branch",
				),
			).toHaveLength(1);
			expect(
				fixture.server.frames.filter(
					frame => frame.type === "control_request" && frame.operation === "turn.prompt",
				),
			).toHaveLength(2);
		} finally {
			fixture.dispose();
		}
	});
	test("aborts an in-flight branch through its active port before branch successor work starts", async () => {
		let branchCandidatesStarted!: () => void;
		const branchCandidatesReady = new Promise<void>(resolve => {
			branchCandidatesStarted = resolve;
		});
		let releaseBranchCandidates!: () => void;
		const branchCandidatesRelease = new Promise<void>(resolve => {
			releaseBranchCandidates = resolve;
		});
		const portLifecycle: string[] = [];
		let abortCalls = 0;
		let aborted = false;
		let fixture!: ReturnType<typeof setupPublicSdkBranchFixture>;
		const sessionPortFactory = () => {
			const client = new PublicSdkSessionClient();
			return new Proxy(client, {
				get(target, property) {
					const value = Reflect.get(target, property, target);
					if (property === "branchCandidates") {
						return async (...args: Parameters<PublicSdkSessionPort["branchCandidates"]>) => {
							branchCandidatesStarted();
							await branchCandidatesRelease;
							if (aborted) throw new Error("branch candidates cancelled");
							return await (value as PublicSdkSessionPort["branchCandidates"]).apply(target, args);
						};
					}
					if (property === "abort") {
						return async (...args: Parameters<PublicSdkSessionPort["abort"]>) => {
							abortCalls += 1;
							aborted = true;
							portLifecycle.push("abort-start");
							const pendingAbort = (value as PublicSdkSessionPort["abort"]).apply(target, args);
							let dispatched = false;
							for (let attempt = 0; attempt < 100; attempt += 1) {
								if (
									fixture.server.frames.some(
										frame => frame.type === "control_request" && frame.operation === "turn.abort",
									)
								) {
									dispatched = true;
									break;
								}
								await Bun.sleep(0);
							}
							if (!dispatched) throw new Error("C04 abort was not dispatched");
							portLifecycle.push("abort-finished");
							void pendingAbort.catch(() => undefined);
							return { status: "accepted" };
						};
					}
					if (property === "detach") {
						return () => {
							portLifecycle.push("detach");
							return (value as PublicSdkSessionPort["detach"]).call(target);
						};
					}
					return typeof value === "function" ? value.bind(target) : value;
				},
			}) as unknown as PublicSdkSessionPort;
		};
		fixture = await setupPublicSdkBranchFixture("branch_regenerate", undefined, sessionPortFactory);
		try {
			const controller = new AbortController();
			const pending = fixture.runner.run({ ...fixture.turn, signal: controller.signal });
			await branchCandidatesReady;
			controller.abort();
			await expect(
				Promise.race([
					pending,
					Bun.sleep(100).then(() => {
						throw new Error("branch cancellation waited for the background branch operation");
					}),
				]),
			).rejects.toMatchObject({ name: "GjcTurnCancelledError" });
			releaseBranchCandidates();
			await expect(pending).rejects.toMatchObject({ name: "GjcTurnCancelledError" });
			expect(abortCalls).toBe(1);
			expect(portLifecycle.indexOf("abort-finished")).toBeLessThan(portLifecycle.indexOf("detach"));
			expectSdkRequest(fixture.server.frames, "control_request", "turn.abort");
			expect(
				fixture.server.frames.some(
					frame => frame.type === "query_request" && frame.query === "session.branch_candidates",
				),
			).toBe(false);
			expect(
				fixture.server.frames.some(frame => frame.type === "control_request" && frame.operation === "session.branch"),
			).toBe(false);
		} finally {
			fixture.dispose();
		}
	});
	test("keeps an acknowledged branch checkpoint uncertain after restart without remote replay", async () => {
		let barrierHits = 0;
		const fixture = await setupPublicSdkBranchFixture("branch_regenerate", async (phase, evidence) => {
			expect(phase).toBe("between_branch_phases");
			expect(evidence).toMatchObject({ cwd: fixture.project.cwd, sessionId: "sdk-session-successor" });
			barrierHits += 1;
			throw new Error("post-ack interruption");
		});
		try {
			await expect(fixture.runner.run(fixture.turn)).rejects.toThrow("post-ack interruption");
			const restartedMappings = new FileBackedSessionMappingStore(fixture.mappingFile);
			expect(
				restartedMappings.operationScoped({ principalId: "owner-q16", chatId: "chat-q16" }, "branch-q16"),
			).toMatchObject({
				id: "branch-q16",
				kind: "branch",
				state: "uncertain",
				acknowledgedSuccessor: {
					sessionId: "sdk-session-successor",
					attachment: expect.objectContaining({
						expectedSessionId: "sdk-session-successor",
						expectedCwd: fixture.project.cwd,
					}),
				},
			});
			const checkpoint = restartedMappings.operationScoped(
				{ principalId: "owner-q16", chatId: "chat-q16" },
				"branch-q16",
			)?.acknowledgedSuccessor;
			expect(Object.keys(checkpoint?.attachment ?? {}).sort()).toEqual([
				"descriptorPath",
				"descriptorStat",
				"expectedCwd",
				"expectedSessionId",
				"generation",
				"payloadDigest",
			]);
			expect(
				new FileBackedSessionMappingStore(fixture.mappingFile).operationScoped(
					{ principalId: "owner-q16", chatId: "chat-q16" },
					"branch-q16",
				),
			).toMatchObject({ acknowledgedSuccessor: checkpoint });
			expect(restartedMappings.getScoped({ principalId: "owner-q16", chatId: "chat-q16" })).toMatchObject({
				sessionId: "sdk-session-created",
				operationId: "predecessor-q16",
			});

			const restarted = createGjcRoutingLiveGatewayRunner({
				turnRunner: createPublicSdkGjcTurnRunner(fixture.runnerInput),
				mappings: restartedMappings,
				ownerUserId: "owner-q16",
			});
			await expect(restarted.run(fixture.turn)).rejects.toThrow("requires reconciliation");
			expect(barrierHits).toBe(1);
			expect(
				fixture.server.frames.filter(
					frame => frame.type === "control_request" && frame.operation === "session.branch",
				),
			).toHaveLength(1);
			expect(
				fixture.server.frames.filter(
					frame => frame.type === "control_request" && frame.operation === "turn.prompt",
				),
			).toHaveLength(0);
			expect(fixture.server.frames.some(frame => frame.operation === "session.close")).toBe(false);
			expect(
				new FileBackedSessionMappingStore(fixture.mappingFile).getScoped({
					principalId: "owner-q16",
					chatId: "chat-q16",
				}),
			).toMatchObject({
				sessionId: "sdk-session-created",
				operationId: "predecessor-q16",
			});
			expect(
				new FileBackedSessionMappingStore(fixture.mappingFile).operationScoped(
					{ principalId: "owner-q16", chatId: "chat-q16" },
					"branch-q16",
				),
			).toMatchObject({ state: "uncertain", acknowledgedSuccessor: checkpoint });
		} finally {
			fixture.dispose();
		}
	});

	test.each([
		["branch_candidate_absent", "branch_lineage_branch-candidate-absent"],
		["branch_candidate_duplicate", "duplicate entry id"],
		["branch_candidate_drift", "branch_lineage_branch-candidate-drift"],
	] as const)("does not prompt when Q16 candidate is %s", async (scenario, reason) => {
		const fixture = await setupPublicSdkBranchFixture(scenario);
		try {
			await expect(fixture.runner.run(fixture.turn)).rejects.toThrow(reason);
			expectSdkRequest(fixture.server.frames, "query_request", "session.branch_candidates");
			expect(
				fixture.server.frames.some(
					frame => frame.type === "control_request" && frame.operation === "session.branch",
				),
			).toBe(false);
			expect(
				fixture.server.frames.some(frame => frame.type === "control_request" && frame.operation === "turn.prompt"),
			).toBe(false);
		} finally {
			fixture.dispose();
		}
	});

	test("does not query Q16 or prompt when authenticated branch lineage mismatches", async () => {
		const fixture = await setupPublicSdkBranchFixture("branch_regenerate");
		try {
			await expect(
				fixture.runner.run({
					...fixture.turn,
					messageMetadata: {
						gjc_adapter: {
							ownerUserId: "owner-q16",
							projectId: fixture.project.id,
							gjcSessionId: "sdk-session-created",
							gjcEntryId: "entry-q16",
							openwebuiMessageId: "other-message",
						},
					},
				}),
			).rejects.toThrow("branch_lineage_message-entry-mismatch");
			expect(
				fixture.server.frames.some(
					frame => frame.type === "query_request" && frame.query === "session.branch_candidates",
				),
			).toBe(false);
			expect(
				fixture.server.frames.some(frame => frame.type === "control_request" && frame.operation === "turn.prompt"),
			).toBe(false);
		} finally {
			fixture.dispose();
		}
	});
});
test("reuses a live published endpoint from a file-backed restart without invoking the CLI", async () => {
	const root = mkdtempSync(join(tmpdir(), "gjc-endpoint-restart-"));
	const sessionRoot = join(root, ".gjc", "sessions");
	const endpointRoot = join(root, ".gjc", "state", "sdk");
	const sessionFile = join(sessionRoot, "session-live.jsonl");
	const mappingFile = join(root, "mappings.json");
	mkdirSync(sessionRoot, { recursive: true });
	mkdirSync(endpointRoot, { recursive: true });
	writeFileSync(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: "session-live", timestamp: "2026-01-01T00:00:00.000Z", cwd: root })}\n`,
	);
	let metadataQueries = 0;
	const server = Bun.serve({
		port: 0,
		fetch(request, bunServer) {
			return bunServer.upgrade(request) ? undefined : new Response("upgrade required", { status: 426 });
		},
		websocket: {
			open(socket) {
				socket.send(JSON.stringify({ type: "server_hello", protocolVersion: 3, connectionId: "restart-fixture" }));
			},
			message(socket, message) {
				const frame = JSON.parse(String(message)) as { type: string; id: string; query?: string };
				if (frame.type !== "query_request") return;
				if (frame.query === "session.metadata") {
					metadataQueries += 1;
					socket.send(
						JSON.stringify({
							type: "query_response",
							id: frame.id,
							ok: true,
							page: { items: [{ sessionId: "session-live", cwd: root }], complete: true },
						}),
					);
					return;
				}
				if (frame.query === "config.list/get") {
					socket.send(
						JSON.stringify({
							type: "query_response",
							id: frame.id,
							ok: true,
							page: {
								items: [
									{
										mode: "default",
										thinking: "medium",
										steeringMode: "all",
										followUpMode: "all",
										interruptMode: "all",
									},
								],
								complete: true,
							},
						}),
					);
					return;
				}
				if (frame.query === "models.list/current") {
					socket.send(
						JSON.stringify({
							type: "query_response",
							id: frame.id,
							ok: true,
							page: {
								items: [
									{
										provider: "anthropic",
										id: "claude-sonnet-4",
										current: true,
										currentThinkingLevel: "medium",
									},
								],
								complete: true,
							},
						}),
					);
				}
			},
		},
	});
	try {
		writeFileSync(
			join(endpointRoot, "session-live.json"),
			JSON.stringify({ version: 1, url: `ws://127.0.0.1:${server.port}`, token: "restart-token" }),
		);
		const first = new FileBackedSessionMappingStore(mappingFile);
		first.set({
			...mappingInput(mediumSelection),
			sessionId: "session-live",
			sessionFile,
		});
		const mapping = new FileBackedSessionMappingStore(mappingFile).get("chat-1");
		if (mapping === undefined) throw new Error("expected persisted mapping");
		const runner = createPublicSdkGjcTurnRunner({
			cliPath: join(root, "missing-gjc-cli"),
			runtimeLocations: {
				childEnvironment: {
					HOME: root,
					GJC_CONFIG_DIR: join(root, ".gjc"),
					GJC_CODING_AGENT_DIR: join(root, ".gjc"),
				},
			} as GjcRuntimeLocations,
			turnTimeoutMs: 1_000,
		});
		await withLifecyclePublication(
			runner,
			{
				cwd: root,
				sessionRoot,
				projectId: mapping.projectId,
				chatId: mapping.chatId,
				sessionId: mapping.sessionId,
				sessionFile: mapping.sessionFile,
			},
			lifecycle =>
				runner.switchSession({
					cwd: root,
					sessionRoot,
					projectId: mapping.projectId,
					chatId: mapping.chatId,
					sessionId: mapping.sessionId,
					sessionFile: mapping.sessionFile,
					lifecycle,
				}),
		);
		expect(metadataQueries).toBe(0);
	} finally {
		server.stop(true);
		rmSync(root, { recursive: true, force: true });
	}
});
test("refreshes a cached attachment when the same session ID endpoint is replaced without a proven close", async () => {
	const root = mkdtempSync(join(tmpdir(), "gjc-runner-cache-eviction-"));
	const sessionId = "sdk-session-created";
	const sessionRoot = join(root, ".gjc", "sessions");
	const endpointRoot = join(root, ".gjc", "state", "sdk");
	const sessionFile = join(sessionRoot, `${sessionId}.jsonl`);
	const firstServer = startSdkFixtureServer("turn_complete", root);
	const secondServer = startSdkFixtureServer("turn_complete", root);
	try {
		mkdirSync(endpointRoot, { recursive: true });
		mkdirSync(sessionRoot, { recursive: true });
		writeFileSync(
			sessionFile,
			`${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: root })}\n`,
		);
		writeFileSync(
			join(endpointRoot, `${sessionId}.json`),
			JSON.stringify({ version: 1, url: firstServer.url, token: firstServer.token }),
		);
		const runner = createPublicSdkGjcTurnRunner({
			cliPath: join(root, "missing-gjc-cli"),
			runtimeLocations: {
				childEnvironment: {
					HOME: root,
					GJC_CONFIG_DIR: join(root, ".gjc"),
					GJC_CODING_AGENT_DIR: join(root, ".gjc"),
				},
			} as GjcRuntimeLocations,
			turnTimeoutMs: 1_000,
		});
		const address = { cwd: root, sessionRoot, projectId: "project", chatId: "chat", sessionId, sessionFile };
		await withLifecyclePublication(runner, address, lifecycle => runner.switchSession({ ...address, lifecycle }));
		const first = await withLifecyclePublication(runner, address, lifecycle =>
			runner.continueSession({
				...address,
				text: "first",
				userMessageId: "first-message",
				rawFrameCursor: 0,
				eventCursor: 0,
				operationId: "first-message",
				lifecycle,
			}),
		);
		unlinkSync(join(endpointRoot, `${sessionId}.json`));
		writeFileSync(
			join(endpointRoot, `${sessionId}.json`),
			JSON.stringify({ version: 1, url: secondServer.url, token: secondServer.token }),
		);
		await withLifecyclePublication(runner, address, lifecycle => runner.switchSession({ ...address, lifecycle }));
		const second = await withLifecyclePublication(runner, address, lifecycle =>
			runner.continueSession({
				...address,
				text: "second",
				userMessageId: "second-message",
				rawFrameCursor: 0,
				eventCursor: 0,
				operationId: "second-message",
				lifecycle,
			}),
		);

		expectSdkRequest(firstServer.frames, "query_request", "session.metadata");
		expectSdkRequest(secondServer.frames, "query_request", "session.metadata");
		expect(first.attachment).toMatchObject({
			expectedSessionId: sessionId,
			expectedCwd: root,
			payloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		expect(second.attachment).toMatchObject({
			expectedSessionId: sessionId,
			expectedCwd: root,
			payloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		expect(second.attachment?.payloadDigest).not.toBe(first.attachment?.payloadDigest);
		expect(first.attachment).not.toHaveProperty("tmuxPane");
		expect(second.attachment).not.toHaveProperty("tmuxPane");
		expect(
			firstServer.frames.filter(frame => frame.type === "control_request" && frame.operation === "turn.prompt"),
		).toHaveLength(1);
		expect(
			secondServer.frames.filter(frame => frame.type === "control_request" && frame.operation === "turn.prompt"),
		).toHaveLength(1);
	} finally {
		firstServer.stop();
		secondServer.stop();
		rmSync(root, { recursive: true, force: true });
	}
});
test("keeps duplicate session IDs isolated across canonical project cwd values in the public SDK runner cache", async () => {
	const root = mkdtempSync(join(tmpdir(), "gjc-runner-cache-isolation-"));
	const firstCwd = join(root, "first");
	const secondCwd = join(root, "second");
	const sessionId = "sdk-session-created";
	const firstServer = startSdkFixtureServer("turn_complete", firstCwd);
	const secondServer = startSdkFixtureServer("turn_complete", secondCwd);
	try {
		for (const [cwd, server] of [
			[firstCwd, firstServer],
			[secondCwd, secondServer],
		] as const) {
			const sessionRoot = join(cwd, ".gjc", "sessions");
			mkdirSync(sessionRoot, { recursive: true });
			mkdirSync(join(cwd, ".gjc", "state", "sdk"), { recursive: true });
			writeFileSync(
				join(sessionRoot, `${sessionId}.jsonl`),
				`${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd })}\n`,
			);
			writeFileSync(
				join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`),
				JSON.stringify({ version: 1, url: server.url, token: server.token }),
			);
		}
		const runner = createPublicSdkGjcTurnRunner({
			cliPath: join(root, "missing-gjc-cli"),
			runtimeLocations: {
				childEnvironment: {
					HOME: root,
					GJC_CONFIG_DIR: join(root, ".gjc"),
					GJC_CODING_AGENT_DIR: join(root, ".gjc"),
				},
			} as GjcRuntimeLocations,
			turnTimeoutMs: 1_000,
		});
		const firstSessionRoot = join(firstCwd, ".gjc", "sessions");
		const secondSessionRoot = join(secondCwd, ".gjc", "sessions");
		const firstSessionFile = join(firstSessionRoot, `${sessionId}.jsonl`);
		const secondSessionFile = join(secondSessionRoot, `${sessionId}.jsonl`);
		const firstAddress = {
			cwd: firstCwd,
			sessionRoot: firstSessionRoot,
			projectId: "first",
			chatId: "first",
			sessionId,
			sessionFile: firstSessionFile,
		};
		await withLifecyclePublication(runner, firstAddress, lifecycle =>
			runner.switchSession({ ...firstAddress, lifecycle }),
		);
		const first = await withLifecyclePublication(runner, firstAddress, lifecycle =>
			runner.continueSession({
				...firstAddress,
				text: "first",
				userMessageId: "first-message",
				rawFrameCursor: 0,
				eventCursor: 0,
				operationId: "first-message",
				lifecycle,
			}),
		);
		const secondAddress = {
			cwd: secondCwd,
			sessionRoot: secondSessionRoot,
			projectId: "second",
			chatId: "second",
			sessionId,
			sessionFile: secondSessionFile,
		};
		await withLifecyclePublication(runner, secondAddress, lifecycle =>
			runner.switchSession({ ...secondAddress, lifecycle }),
		);
		const second = await withLifecyclePublication(runner, secondAddress, lifecycle =>
			runner.continueSession({
				...secondAddress,
				text: "second",
				userMessageId: "second-message",
				rawFrameCursor: 0,
				eventCursor: 0,
				operationId: "second-message",
				lifecycle,
			}),
		);
		expect(first.attachment?.expectedCwd).toBe(firstCwd);
		expect(second.attachment?.expectedCwd).toBe(secondCwd);
		expect(
			firstServer.frames.filter(frame => frame.type === "control_request" && frame.operation === "turn.prompt"),
		).toHaveLength(1);
		expect(
			secondServer.frames.filter(frame => frame.type === "control_request" && frame.operation === "turn.prompt"),
		).toHaveLength(1);
	} finally {
		firstServer.stop();
		secondServer.stop();
		rmSync(root, { recursive: true, force: true });
	}
});

test("retains a generation-bound persisted pane through a live restart and drops it when a same-ID endpoint is replaced", async () => {
	const root = mkdtempSync(join(tmpdir(), "gjc-pane-recovery-barrier-"));
	const sessionId = "same-id";
	const sessionRoot = join(root, ".gjc", "sessions");
	const endpointRoot = join(root, ".gjc", "state", "sdk");
	const sessionFile = join(sessionRoot, `${sessionId}.jsonl`);
	const mappingFile = join(root, "mappings.json");
	const socket = `gjc-barrier-${process.pid}-${Date.now()}`;
	const pane = tmux([
		"-L",
		socket,
		"new-session",
		"-d",
		"-P",
		"-F",
		"#{pane_id}|#{pane_pid}",
		"-s",
		"owned",
		"tail -f /dev/null",
	]);
	const [tmuxPane, panePid] = pane.split("|");
	const owner = "generation-bound-owner";
	const firstUrl = "ws://127.0.0.1:19001";
	const secondUrl = "ws://127.0.0.1:19002";
	try {
		if (tmuxPane === undefined || panePid === undefined) throw new Error("tmux did not return an owned pane");
		tmux(["-L", socket, "set-option", "-p", "-t", tmuxPane, "@openwebui_gjc_owner", owner]);
		mkdirSync(endpointRoot, { recursive: true });
		mkdirSync(sessionRoot, { recursive: true });
		writeFileSync(
			sessionFile,
			`${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: root })}\n`,
		);
		const descriptorPath = join(endpointRoot, `${sessionId}.json`);
		const firstDescriptor = JSON.stringify({ version: 1, url: firstUrl, token: "first", pid: Number(panePid) });
		writeFileSync(descriptorPath, firstDescriptor);
		const stat = await Bun.file(descriptorPath).stat();
		const mappings = new FileBackedSessionMappingStore(mappingFile);
		mappings.set({
			...mappingInput(mediumSelection),
			sessionId,
			sessionFile,
			attachment: {
				descriptorPath,
				descriptorStat: { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs },
				payloadDigest: createHash("sha256").update(firstDescriptor).digest("hex"),
				generation: stat.mtimeMs,
				expectedSessionId: sessionId,
				expectedCwd: root,
				tmuxSocket: socket,
				tmuxPane,
				tmuxPanePid: Number(panePid),
				tmuxOwnershipTag: owner,
				ownedAt: "2026-01-01T00:00:00.000Z",
			},
		});
		const runnerInput = {
			cliPath: join(root, "missing-gjc-cli"),
			runtimeLocations: {
				childEnvironment: {
					HOME: root,
					GJC_CONFIG_DIR: join(root, ".gjc"),
					GJC_CODING_AGENT_DIR: join(root, ".gjc"),
				},
			} as GjcRuntimeLocations,
			turnTimeoutMs: 1_000,
			sessionPortFactory: () =>
				({
					async attach() {},
					detach() {},
					async getState() {
						return {
							sessionId,
							model: { provider: "anthropic", id: "claude-sonnet-4" },
							thinkingLevel: "medium",
						};
					},
					async prompt() {
						return { events: [], finalizedAssistantText: "durable" };
					},
				}) as any,
		};
		const first = createGjcRoutingLiveGatewayRunner({
			turnRunner: createPublicSdkGjcTurnRunner(runnerInput),
			mappings,
		});
		await first.run({ ...turn("chat-1", "pane-first", true), project: { ...project, cwd: root, sessionRoot } });
		const retained = new FileBackedSessionMappingStore(mappingFile).get("chat-1")?.attachment;
		expect(retained).toMatchObject({
			tmuxPane,
			tmuxPanePid: Number(panePid),
			tmuxOwnershipTag: owner,
			payloadDigest: createHash("sha256").update(firstDescriptor).digest("hex"),
		});

		unlinkSync(descriptorPath);
		const secondDescriptor = JSON.stringify({
			version: 1,
			url: secondUrl,
			token: "second",
			pid: Number(panePid) + 1,
		});
		writeFileSync(descriptorPath, secondDescriptor);
		const restartedMappings = new FileBackedSessionMappingStore(mappingFile);
		const restarted = createGjcRoutingLiveGatewayRunner({
			turnRunner: createPublicSdkGjcTurnRunner(runnerInput),
			mappings: restartedMappings,
		});
		await restarted.run({ ...turn("chat-1", "pane-second", true), project: { ...project, cwd: root, sessionRoot } });
		const replaced = new FileBackedSessionMappingStore(mappingFile).get("chat-1")?.attachment;
		expect(replaced?.payloadDigest).toBe(createHash("sha256").update(secondDescriptor).digest("hex"));
		expect(replaced).not.toHaveProperty("tmuxPane");
		expect(replaced).not.toHaveProperty("tmuxPanePid");
		expect(replaced).not.toHaveProperty("tmuxOwnershipTag");
	} finally {
		tmux(["-L", socket, "kill-server"], false);
		rmSync(root, { recursive: true, force: true });
	}
});

test.each(["post_mutation_pre_proof", "pre_durable_publication"] as const)(
	"rejects stale public SDK work at %s without a durable result",
	async phase => {
		const fixture = setupPublicRunnerBarrierFixture(phase);
		try {
			await withLifecyclePublication(fixture.runner, fixture.address, lifecycle =>
				fixture.runner.switchSession({ ...fixture.address, lifecycle }),
			);
			const continued = withLifecyclePublication(fixture.runner, fixture.address, async lifecycle => {
				const result = await fixture.runner.continueSession({
					...fixture.address,
					text: phase,
					userMessageId: phase,
					rawFrameCursor: 0,
					eventCursor: 0,
					operationId: phase,
					lifecycle,
				});
				if (phase === "pre_durable_publication") {
					if (result.attachment === undefined)
						throw new Error("expected an attachment proof for durable publication");
					await lifecycle.publish(result.attachment, () => undefined);
				}
			});
			await expect(continued).rejects.toThrow("endpoint descriptor");
			expect(fixture.hits).toBe(1);
			expect(
				fixture.server.frames.filter(
					frame => frame.type === "control_request" && frame.operation === "turn.prompt",
				),
			).toHaveLength(1);
		} finally {
			fixture.dispose();
		}
	},
);
test("rejects a close commit when its public SDK descriptor changes after proof", async () => {
	const fixture = setupPublicRunnerBarrierFixture("post_close_proof_pre_commit");
	try {
		await withLifecyclePublication(fixture.runner, fixture.address, lifecycle =>
			fixture.runner.switchSession({ ...fixture.address, lifecycle }),
		);
		const close = withLifecyclePublication(fixture.runner, fixture.address, async lifecycle => {
			const result = await fixture.runner.continueSession({
				...fixture.address,
				text: "close",
				userMessageId: "close",
				rawFrameCursor: 0,
				eventCursor: 0,
				operationId: "close",
				lifecycle,
			});
			if (result.attachment === undefined) throw new Error("expected a close attachment proof");
			await lifecycle.publishClosed(lifecycle.assertClosePreflight(result.attachment), () => undefined);
		});
		await expect(close).rejects.toThrow("Close preflight proof");
	} finally {
		fixture.dispose();
	}
});
test("applies released model selection responses across fresh and continuation turns", async () => {
	const root = mkdtempSync(join(tmpdir(), "gjc-first-turn-continuation-"));
	const sessionRoot = join(root, ".gjc", "sessions");
	const mappingFile = join(root, "mappings.json");
	const server = startSdkFixtureServer("model_catalog", root);
	let checkedProvisionalPersistence = false;
	try {
		writeFileSync(
			join(root, "gjc-sdk-fixture.json"),
			JSON.stringify({
				GJC_SDK_FIXTURE_CLI_TRANSCRIPT: join(root, "sdk-cli.jsonl"),
				GJC_SDK_FIXTURE_ENDPOINT_URL: server.url,
				GJC_SDK_FIXTURE_ENDPOINT_TOKEN: server.token,
				GJC_SDK_FIXTURE_DYNAMIC_AUTHORITY: "1",
			}),
		);
		const runner = createGjcRoutingLiveGatewayRunner({
			turnRunner: createPublicSdkGjcTurnRunner({
				cliPath: join(import.meta.dir, "fixtures", "gjc-sdk-interactive-cli-session-fixture.ts"),
				runtimeLocations: {
					childEnvironment: {
						HOME: root,
						GJC_CONFIG_DIR: join(root, ".gjc"),
						GJC_CODING_AGENT_DIR: join(root, ".gjc"),
					},
				} as GjcRuntimeLocations,
				turnTimeoutMs: 1_000,
				sessionPortFactory: () =>
					provisionalPersistenceCheckingPort(
						mappingFile,
						() => checkedProvisionalPersistence,
						() => {
							checkedProvisionalPersistence = true;
						},
					),
			}),
			mappings: new FileBackedSessionMappingStore(mappingFile),
			requestedModelId: () => "gjc/anthropic/claude-sonnet-4:medium",
			modelReaderFactory: staticModelReaderFactory(),
		});
		const firstTurn = {
			project: { ...project, cwd: root, sessionRoot },
			prompt: "first",
			chatId: "same-session",
			messageId: "assistant-first",
			userMessageId: "user-first",
			userMessageParentId: null,
			continued: false,
		};
		await runner.run(firstTurn);
		expect(checkedProvisionalPersistence).toBe(true);
		const persisted = new FileBackedSessionMappingStore(mappingFile).get("same-session");
		expect(persisted?.sessionFile).toMatch(new RegExp(`^${realpathSync(sessionRoot)}/[^/]+\\.jsonl$`));
		expect(persisted?.sessionFile).toBeDefined();
		await runner.run({
			...firstTurn,
			prompt: "second",
			messageId: "assistant-second",
			userMessageId: "user-second",
			userMessageParentId: "assistant-first",
			continued: true,
		});
		expect(
			server.frames.filter(frame => frame.type === "control_request" && frame.operation === "turn.prompt"),
		).toHaveLength(2);
		expect(
			server.frames.filter(frame => frame.type === "control_request" && frame.operation === "model.set"),
		).toHaveLength(2);
		expect(
			server.frames.filter(frame => frame.type === "control_request" && frame.operation === "thinking.set"),
		).toHaveLength(2);
		expect(
			server.frames.filter(frame => frame.type === "query_request" && frame.query === "models.list/current"),
		).toHaveLength(0);
		expect(readFileSync(join(root, "sdk-cli.jsonl"), "utf8")).toContain('"interactive":"create"');
	} finally {
		server.stop();
		rmSync(root, { recursive: true, force: true });
	}
});
test("cleans up a cancelled new session when model setup finishes before the prompt boundary", async () => {
	const root = mkdtempSync(join(tmpdir(), "gjc-cancel-model-setup-"));
	const sessionRoot = join(root, ".gjc", "sessions");
	const mappingFile = join(root, "mappings.json");
	const server = startSdkFixtureServer("model_catalog", root);
	let releaseSetup!: () => void;
	const setupRelease = new Promise<void>(resolve => {
		releaseSetup = resolve;
	});
	let setupStarted!: () => void;
	const setupReady = new Promise<void>(resolve => {
		setupStarted = resolve;
	});
	let holdFirstSetup = true;
	try {
		writeFileSync(
			join(root, "gjc-sdk-fixture.json"),
			JSON.stringify({
				GJC_SDK_FIXTURE_CLI_TRANSCRIPT: join(root, "sdk-cli.jsonl"),
				GJC_SDK_FIXTURE_ENDPOINT_URL: server.url,
				GJC_SDK_FIXTURE_ENDPOINT_TOKEN: server.token,
				GJC_SDK_FIXTURE_DYNAMIC_AUTHORITY: "1",
			}),
		);
		const sessionPortFactory = () => {
			const client = new PublicSdkSessionClient();
			const syntheticSetup = holdFirstSetup;
			return new Proxy(client, {
				get(target, property) {
					const value = Reflect.get(target, property, target);
					if (property === "setThinking" && syntheticSetup) {
						return async (...args: Parameters<PublicSdkSessionPort["setThinking"]>) => ({
							provider: "anthropic",
							modelId: "claude-sonnet-4",
							thinkingLevel: args[0],
						});
					}
					if (property !== "setModel" || !syntheticSetup || !holdFirstSetup) {
						return typeof value === "function" ? value.bind(target) : value;
					}
					holdFirstSetup = false;
					return async (...args: Parameters<PublicSdkSessionPort["setModel"]>) => {
						setupStarted();
						await setupRelease;
						return args[0];
					};
				},
			}) as unknown as PublicSdkSessionPort;
		};
		const turnRunner = createPublicSdkGjcTurnRunner({
			cliPath: join(import.meta.dir, "fixtures", "gjc-sdk-interactive-cli-session-fixture.ts"),
			runtimeLocations: {
				childEnvironment: {
					HOME: root,
					GJC_CONFIG_DIR: join(root, ".gjc"),
					GJC_CODING_AGENT_DIR: join(root, ".gjc"),
				},
			} as GjcRuntimeLocations,
			turnTimeoutMs: 1_000,
			sessionPortFactory,
		});
		const runner = createGjcRoutingLiveGatewayRunner({
			turnRunner,
			mappings: new FileBackedSessionMappingStore(mappingFile),
			requestedModelId: () => "gjc/anthropic/claude-sonnet-4:medium",
			modelReaderFactory: staticModelReaderFactory(),
		});
		const firstTurn = {
			project: { ...project, cwd: root, sessionRoot },
			prompt: "cancel during setup",
			chatId: "cancel-model-setup",
			messageId: "assistant-cancel-model-setup",
			userMessageId: "cancel-model-setup-1",
			userMessageParentId: null,
			continued: false,
		};
		const controller = new AbortController();
		const pending = runner.run({ ...firstTurn, signal: controller.signal });
		await setupReady;
		controller.abort();
		releaseSetup();
		await expect(pending).rejects.toMatchObject({ name: "GjcTurnCancelledError" });
		expect(
			server.frames.some(frame => frame.type === "control_request" && frame.operation === "turn.prompt"),
		);
		expect(tmuxPanesInCwd(root)).toEqual([]);
	} finally {
		for (const pane of tmuxPanesInCwd(root))
			Bun.spawnSync(["tmux", "kill-pane", "-t", pane], { stdout: "ignore", stderr: "ignore" });
		server.stop();
		rmSync(root, { recursive: true, force: true });
	}
});
test("cleans up exactly the owned CLI pane when the post-CLI binding barrier fails", async () => {
	const root = mkdtempSync(join(tmpdir(), "gjc-post-cli-pre-bind-"));
	const sessionRoot = join(root, ".gjc", "sessions");
	const mappingFile = join(root, "mappings.json");
	const server = startSdkFixtureServer("turn_complete", root);
	let sessionId: string | undefined;
	let barrierHits = 0;
	try {
		writeFileSync(
			join(root, "gjc-sdk-fixture.json"),
			JSON.stringify({
				GJC_SDK_FIXTURE_CLI_TRANSCRIPT: join(root, "sdk-cli.jsonl"),
				GJC_SDK_FIXTURE_ENDPOINT_URL: server.url,
				GJC_SDK_FIXTURE_ENDPOINT_TOKEN: server.token,
				GJC_SDK_FIXTURE_DYNAMIC_AUTHORITY: "1",
			}),
		);
		const publicRunner = createPublicSdkGjcTurnRunner({
			cliPath: join(import.meta.dir, "fixtures", "gjc-sdk-interactive-cli-session-fixture.ts"),
			runtimeLocations: {
				childEnvironment: {
					HOME: root,
					GJC_CONFIG_DIR: join(root, ".gjc"),
					GJC_CODING_AGENT_DIR: join(root, ".gjc"),
				},
			} as GjcRuntimeLocations,
			turnTimeoutMs: 1_000,
			testBarrierHook: (phase, evidence) => {
				expect(phase).toBe("post_cli_pre_bind");
				barrierHits += 1;
				sessionId = evidence.sessionId;
				throw new Error("post-CLI binding barrier failed");
			},
		});
		const runner = createGjcRoutingLiveGatewayRunner({
			turnRunner: publicRunner,
			mappings: new FileBackedSessionMappingStore(mappingFile),
		});
		await expect(
			runner.run({
				...turn("post-cli-pre-bind", "post-cli-pre-bind"),
				project: { ...project, cwd: root, sessionRoot },
			}),
		).rejects.toThrow("post-CLI binding barrier failed");
		if (sessionId === undefined) throw new Error("post-CLI barrier did not report a session id");
		expect(barrierHits).toBe(1);
		expect(tmuxPanesInCwd(root)).toEqual([]);
		expect(new FileBackedSessionMappingStore(mappingFile).get("post-cli-pre-bind")).toBeUndefined();
		expect(await Bun.file(join(root, ".gjc", "state", "sdk", `${sessionId}.json`)).exists()).toBe(true);
		expect(readFileSync(mappingFile, "utf8")).not.toContain("tmuxPane");
		expect(readFileSync(join(root, "sdk-cli.jsonl"), "utf8")).toContain('"interactive":"create"');
		expect(server.frames.some(frame => frame.type === "control_request" && frame.operation === "turn.prompt")).toBe(
			false,
		);
	} finally {
		for (const pane of tmuxPanesInCwd(root))
			Bun.spawnSync({
				cmd: ["tmux", "kill-pane", "-t", pane],
				stdout: "ignore",
				stderr: "ignore",
			});
		server.stop();
		rmSync(root, { recursive: true, force: true });
	}
});
test("retains an acknowledged session.new successor without transcript proof across restart and replay", async () => {
	const fixture = setupAcknowledgedSessionNewFixture("absent");
	try {
		await expect(fixture.runner.run(fixture.turn)).rejects.toThrow();
		expect(fixture.barrierHits).toBe(1);
		const restarted = new FileBackedSessionMappingStore(fixture.mappingFile);
		expect(restarted.get("chat-session-new")).toMatchObject({ sessionId: "sdk-session-created" });
		expect(restarted.operation("chat-session-new", "session-new")).toMatchObject({
			kind: "create",
			state: "uncertain",
			acknowledgedSuccessor: { sessionId: "sdk-session-new" },
		});
		const replay = createGjcRoutingLiveGatewayRunner({
			turnRunner: createPublicSdkGjcTurnRunner(fixture.runnerInput),
			mappings: restarted,
			testBarrierHook: fixture.barrier,
		});
		await expect(replay.run(fixture.turn)).rejects.toThrow("requires reconciliation");
		await expect(replay.run({ ...fixture.turn, prompt: "conflicting replay" })).rejects.toThrow(
			"requires reconciliation",
		);
		expect(fixture.server.frames.filter(frame => frame.operation === "session.new")).toHaveLength(1);
		expect(fixture.server.frames.some(frame => frame.operation === "session.close")).toBe(false);
		expect(await Bun.file(fixture.predecessorPath).exists()).toBe(true);
	} finally {
		fixture.dispose();
	}
});
test("promotes a delayed acknowledged session.new successor after restart", async () => {
	const fixture = setupAcknowledgedSessionNewFixture("absent");
	try {
		await expect(fixture.runner.run(fixture.turn)).rejects.toThrow();
		writeFileSync(
			fixture.successorPath,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "sdk-session-new",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: fixture.root,
			})}\n`,
		);
		const acknowledged = new FileBackedSessionMappingStore(fixture.mappingFile).operation(
			"chat-session-new",
			"session-new",
		)?.acknowledgedSuccessor;
		expect(acknowledged).toMatchObject({
			sessionId: "sdk-session-new",
			attachment: {
				descriptorPath: fixture.successorEndpointPath,
				expectedSessionId: "sdk-session-new",
				expectedCwd: fixture.root,
			},
		});
		expect(Object.keys(acknowledged?.attachment ?? {}).sort()).toEqual([
			"descriptorPath",
			"descriptorStat",
			"expectedCwd",
			"expectedSessionId",
			"generation",
			"payloadDigest",
		]);
		const outbox = new InMemoryOutboxStore();
		const replay = createGjcRoutingLiveGatewayRunner({
			turnRunner: createPublicSdkGjcTurnRunner(fixture.runnerInput),
			mappings: new FileBackedSessionMappingStore(fixture.mappingFile),
			outbox,
			ownerUserId: "admin-1",
		});
		await expect(replay.run(fixture.turn)).resolves.toMatchObject({ content: "" });
		expect(outbox.listPending()).toContainEqual(
			expect.objectContaining({
				operationId: "session-new",
				ownerUserId: "admin-1",
				chatId: "chat-session-new",
			}),
		);
		const restarted = new FileBackedSessionMappingStore(fixture.mappingFile);
		expect(restarted.get("chat-session-new")).toMatchObject({
			sessionId: "sdk-session-new",
			sessionFile: fixture.successorPath,
			operationId: "session-new",
		});
		expect(restarted.operation("chat-session-new", "session-new")).toEqual(
			expect.not.objectContaining({ acknowledgedSuccessor: expect.anything() }),
		);
		expect(fixture.server.frames.filter(frame => frame.operation === "session.new")).toHaveLength(1);
		expect(
			fixture.server.frames.filter(frame => frame.type === "control_request" && frame.operation === "turn.prompt"),
		).toHaveLength(0);
	} finally {
		fixture.dispose();
	}
});

test.each(["duplicate", "descriptor replacement"] as const)(
	"does not promote an acknowledged session.new successor after restart on %s",
	async failure => {
		const fixture = setupAcknowledgedSessionNewFixture("absent");
		try {
			await expect(fixture.runner.run(fixture.turn)).rejects.toThrow();
			writeFileSync(
				fixture.successorPath,
				`${JSON.stringify({
					type: "session",
					version: 3,
					id: "sdk-session-new",
					timestamp: "2026-01-01T00:00:00.000Z",
					cwd: fixture.root,
				})}\n`,
			);
			if (failure === "duplicate")
				writeFileSync(fixture.successorCopyPath, readFileSync(fixture.successorPath, "utf8"));
			else
				writeFileSync(
					fixture.successorEndpointPath,
					JSON.stringify({ version: 1, url: fixture.server.url, token: "replaced" }),
				);
			const replay = createGjcRoutingLiveGatewayRunner({
				turnRunner: createPublicSdkGjcTurnRunner(fixture.runnerInput),
				mappings: new FileBackedSessionMappingStore(fixture.mappingFile),
			});
			await expect(replay.run(fixture.turn)).rejects.toThrow("requires reconciliation");
			expect(
				new FileBackedSessionMappingStore(fixture.mappingFile).operation("chat-session-new", "session-new"),
			).toMatchObject({
				state: "uncertain",
				acknowledgedSuccessor: { sessionId: "sdk-session-new" },
			});
			expect(fixture.server.frames.filter(frame => frame.operation === "session.new")).toHaveLength(1);
			expect(fixture.server.frames.some(frame => frame.operation === "session.close")).toBe(false);
		} finally {
			fixture.dispose();
		}
	},
);

test("promotes an acknowledged session.new successor only after a unique valid transcript", async () => {
	const fixture = setupAcknowledgedSessionNewFixture("valid");
	try {
		await fixture.runner.run(fixture.turn);
		const restarted = new FileBackedSessionMappingStore(fixture.mappingFile);
		expect(restarted.get("chat-session-new")).toMatchObject({
			sessionId: "sdk-session-new",
			sessionFile: fixture.successorPath,
			operationId: "session-new",
		});
		expect(restarted.operation("chat-session-new", "session-new")).toEqual(
			expect.not.objectContaining({ acknowledgedSuccessor: expect.anything() }),
		);
		expect(fixture.server.frames.some(frame => frame.operation === "session.close")).toBe(false);
	} finally {
		fixture.dispose();
	}
});

test.each(["duplicate", "invalid"] as const)(
	"retains an acknowledged session.new successor when its transcript is %s",
	async transcript => {
		const fixture = setupAcknowledgedSessionNewFixture(transcript);
		try {
			await expect(fixture.runner.run(fixture.turn)).rejects.toThrow();
			const restarted = new FileBackedSessionMappingStore(fixture.mappingFile);
			expect(restarted.get("chat-session-new")).toMatchObject({ sessionId: "sdk-session-created" });
			expect(restarted.operation("chat-session-new", "session-new")).toMatchObject({
				state: "uncertain",
				acknowledgedSuccessor: { sessionId: "sdk-session-new" },
			});
			expect(
				Object.keys(
					restarted.operation("chat-session-new", "session-new")?.acknowledgedSuccessor?.attachment ?? {},
				).sort(),
			).toEqual([
				"descriptorPath",
				"descriptorStat",
				"expectedCwd",
				"expectedSessionId",
				"generation",
				"payloadDigest",
			]);
			expect(fixture.server.frames.some(frame => frame.operation === "session.close")).toBe(false);
			expect(await Bun.file(fixture.predecessorPath).exists()).toBe(true);
		} finally {
			fixture.dispose();
		}
	},
);

function setupAcknowledgedSessionNewFixture(transcript: "absent" | "valid" | "duplicate" | "invalid") {
	const root = mkdtempSync(join(tmpdir(), "gjc-session-new-ack-"));
	const sessionRoot = join(root, ".gjc", "sessions");
	const endpointRoot = join(root, ".gjc", "state", "sdk");
	const mappingFile = join(root, "mappings.json");
	const predecessorPath = join(sessionRoot, "sdk-session-created.jsonl");
	const successorPath = join(realpathSync(root), ".gjc", "sessions", "sdk-session-new.jsonl");
	const server = startSdkFixtureServer("controls", root);
	let barrierHits = 0;
	mkdirSync(endpointRoot, { recursive: true });
	mkdirSync(sessionRoot, { recursive: true });
	writeFileSync(
		predecessorPath,
		`${JSON.stringify({ type: "session", version: 3, id: "sdk-session-created", timestamp: "2026-01-01T00:00:00.000Z", cwd: root })}\n`,
	);
	writeFileSync(
		join(endpointRoot, "sdk-session-created.json"),
		JSON.stringify({ version: 1, url: server.url, token: server.token }),
	);
	const mappings = new FileBackedSessionMappingStore(mappingFile);
	mappings.set({
		...mappingInput(mediumSelection),
		chatId: "chat-session-new",
		sessionId: "sdk-session-created",
		sessionFile: predecessorPath,
		operationId: "predecessor",
	});
	const barrier: GjcLifecycleTestBarrierHook = (phase, evidence) => {
		if (phase !== "post_ack_pre_transcript") return;
		barrierHits += 1;
		expect(evidence).toMatchObject({ cwd: root, sessionId: "sdk-session-new" });
		const persisted: any = readAuthorityMerged(mappingFile);
		expect(persisted.mappings[0]).toMatchObject({ sessionId: "sdk-session-created" });
		expect(persisted.mappings[0].journal).toContainEqual(
			expect.objectContaining({
				id: "session-new",
				kind: "create",
				state: "pending",
				acknowledgedSuccessor: expect.objectContaining({
					sessionId: "sdk-session-new",
					attachment: {
						descriptorPath: expect.any(String),
						descriptorStat: expect.any(Object),
						expectedCwd: root,
						expectedSessionId: "sdk-session-new",
						generation: expect.any(Number),
						payloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
					},
				}),
			}),
		);
		if (transcript === "absent") return;
		const header = {
			type: "session",
			version: 3,
			id: transcript === "invalid" ? "wrong-session" : "sdk-session-new",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: root,
		};
		writeFileSync(successorPath, `${JSON.stringify(header)}\n`);
		if (transcript === "duplicate")
			writeFileSync(join(sessionRoot, "sdk-session-new-copy.jsonl"), `${JSON.stringify(header)}\n`);
	};
	const runnerInput = {
		cliPath: join(root, "missing-gjc-cli"),
		runtimeLocations: {
			childEnvironment: { HOME: root, GJC_CONFIG_DIR: join(root, ".gjc"), GJC_CODING_AGENT_DIR: join(root, ".gjc") },
		} as GjcRuntimeLocations,
		turnTimeoutMs: 1_000,
		testBarrierHook: barrier,
	};
	const turn = {
		project: { ...project, cwd: root, sessionRoot },
		prompt: "new successor",
		chatId: "chat-session-new",
		messageId: "assistant-session-new",
		userMessageId: "session-new",
		userMessageParentId: null,
		continued: true,
		control: { operation: "session.new" as const },
	};
	return {
		runner: createGjcRoutingLiveGatewayRunner({
			turnRunner: createPublicSdkGjcTurnRunner(runnerInput),
			mappings,
			testBarrierHook: barrier,
		}),
		runnerInput,
		mappingFile,
		root,
		successorCopyPath: join(sessionRoot, "sdk-session-new-copy.jsonl"),
		successorEndpointPath: join(endpointRoot, "sdk-session-new.json"),
		predecessorPath,
		successorPath,
		server,
		turn,
		barrier,
		get barrierHits() {
			return barrierHits;
		},
		dispose() {
			server.stop();
			rmSync(root, { recursive: true, force: true });
		},
	};
}
function tmuxPanesInCwd(cwd: string): string[] {
	const result = Bun.spawnSync({
		cmd: ["tmux", "list-panes", "-a", "-F", "#{pane_id}|#{pane_current_path}"],
		stdout: "pipe",
		stderr: "ignore",
	});
	if (result.exitCode !== 0) return [];
	return new TextDecoder()
		.decode(result.stdout)
		.split(/\r?\n/)
		.flatMap(line => {
			const [pane, paneCwd, ...extra] = line.split("|");
			return extra.length === 0 && pane !== undefined && paneCwd === cwd ? [pane] : [];
		});
}
class FailingFileSessionAuthority extends FileSessionAuthority {
	failure: Error | undefined;
	walFailure: Error | undefined;
	directoryFailure: Error | undefined;

	forceCompaction(): void {
		this.persist();
	}
	protected override persist(): void {
		if (this.failure !== undefined) throw this.failure;
		super.persist();
	}
	protected override appendWal(
		records: readonly SessionAuthorityRecord[],
		provisional: readonly { readonly key: string; readonly operation: ProvisionalSessionOperation }[],
	): void {
		if (this.walFailure !== undefined) throw this.walFailure;
		super.appendWal(records, provisional);
	}
	protected override syncDirectory(): void {
		if (this.directoryFailure !== undefined) throw this.directoryFailure;
		super.syncDirectory();
	}
}
class CompactionFailingFileSessionAuthority extends FailingFileSessionAuthority {
	replaceAllDuringMutation(
		records: readonly SessionAuthorityRecord[],
		provisional: readonly ProvisionalSessionOperation[] = [],
	): void {
		this.mutate(() => this.replaceAll(records, provisional));
	}
}
const lowSelection = { provider: "anthropic", modelId: "claude-sonnet-4", thinkingLevel: "low" } as const;
const mediumSelection = { ...lowSelection, thinkingLevel: "medium" } as const;

async function withLifecyclePublication<T>(
	runner: GjcTurnRunner,
	address: GjcLifecyclePublicationAddress,
	effect: (lifecycle: GjcLifecycleTransaction) => Promise<T>,
): Promise<T> {
	if (runner.withLifecyclePublication === undefined) throw new Error("GJC runner must provide lifecycle publication.");
	return runner.withLifecyclePublication(address, effect);
}
function readAuthorityMerged(filePath: string): any {
	const base = JSON.parse(readFileSync(filePath, "utf8"));
	const walPath = `${filePath}.wal`;
	let walBytes: string;
	try {
		walBytes = readFileSync(walPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return base;
		throw error;
	}
	const lines = walBytes.split("\n").filter(line => line.length > 0);
	if (lines.length === 0) return base;
	let header: any;
	try {
		header = JSON.parse(lines[0]!);
	} catch {
		return base;
	}
	const baseStat = statSync(filePath);
	if (header?.base?.size !== baseStat.size || header?.base?.mtimeMs !== baseStat.mtimeMs) return base;
	const records = new Map<string, any>();
	const provisional = new Map<string, any>();
	for (const record of base.mappings ?? []) records.set(record.chatId, record);
	for (const operation of base.provisionalOperations ?? [])
		provisional.set(JSON.stringify([operation.chatId, operation.ingressId ?? operation.id]), operation);
	for (const line of lines.slice(1)) {
		let delta: any;
		try {
			delta = JSON.parse(line);
		} catch {
			continue;
		}
		if (delta?.kind !== "openwebui-gjc-session-authority-wal") continue;
		for (const record of delta.records ?? []) records.set(record.chatId, record);
		for (const item of delta.provisional ?? [])
			if (item?.key !== undefined) provisional.set(item.key, item.operation);
	}
	return { ...base, mappings: [...records.values()], provisionalOperations: [...provisional.values()] };
}

function mappingInput(modelSelection: NormalizedModelSelection) {
	return {
		chatId: "chat-1",
		projectId: project.id,
		sessionId: "session-1",
		sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
		rawFrameCursor: 0,
		eventCursor: 0,
		operationId: "user-1",
		modelSelection,
	};
}
function acknowledgedSuccessor(): any {
	return {
		sessionId: "session-successor",
		attachment: {
			descriptorPath: "/workspace/.gjc/endpoints/session-successor.json",
			descriptorStat: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
			payloadDigest: "0000000000000000000000000000000000000000000000000000000000000000",
			generation: 4,
			expectedSessionId: "session-successor",
			expectedCwd: "/workspace",
		},
	};
}
function oversizedAuthorityJson(targetBytes: number): { readonly json: string; readonly eventCount: number } {
	const chunk = "x".repeat(512 * 1024);
	const eventCount = Math.max(2, Math.ceil(targetBytes / (512 * 1024)));
	const events = Array.from({ length: eventCount }, (_, index) => ({
		type: "assistant" as const,
		text: `event-${index}`,
		payload: { transcript: `${chunk}-${index}` },
	}));
	const document = validAuthorityDocument();
	// A pending provisional operation would make boot reconcile-and-persist via
	// the pre-existing branch; the oversized boot-compaction branch is only
	// exercised when nothing else requires a rewrite.
	document.provisionalOperations = [];
	document.mappings[0].journal[0].result.events = events;
	return { json: JSON.stringify(document), eventCount };
}
function validAuthorityDocument(): any {
	const timestamp = "2026-01-01T00:00:00.000Z";
	const mapping = {
		version: 2,
		chatId: "chat-1",
		projectId: project.id,
		sessionId: "session-1",
		createdAt: timestamp,
		header: { chatId: "chat-1", projectId: project.id, sessionId: "session-1" },
		rawFrameCursor: 0,
		eventCursor: 0,
		operationId: "operation-1",
		events: [{ type: "assistant", text: "done", payload: { nested: ["value"] } }],
		modelSelection: { ...mediumSelection },
		attachment: {
			descriptorPath: "/workspace/.gjc/endpoints/session-1.json",
			descriptorStat: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
			payloadDigest: "0000000000000000000000000000000000000000000000000000000000000000",
			generation: 4,
			expectedSessionId: "session-1",
			expectedCwd: "/workspace",
		},
		journal: [
			{
				id: "operation-1",
				kind: "prompt",
				state: "complete",
				startedAt: timestamp,
				completedAt: timestamp,
				result: {
					kind: "turn",
					assistantText: "done",
					events: [{ type: "assistant", text: "done" }],
					mapping: {
						chatId: "chat-1",
						projectId: project.id,
						sessionId: "session-1",
						rawFrameCursor: 0,
						eventCursor: 0,
						operationId: "operation-1",
					},
				},
			},
		],
	};
	return {
		kind: "openwebui-gjc-session-authority",
		version: 2,
		mappings: [mapping],
		provisionalOperations: [
			{
				id: "operation-2",
				kind: "create",
				state: "pending",
				startedAt: timestamp,
				chatId: "chat-2",
				projectId: project.id,
			},
		],
	};
}

function withFileStore(run: (store: FileBackedSessionMappingStore, filePath: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "gjc-selection-mapping-"));
	const filePath = join(root, "mappings.json");
	try {
		run(new FileBackedSessionMappingStore(filePath), filePath);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function neutralReader(transcript: string[]) {
	return {
		async getAvailableModels() {
			transcript.push("catalog");
			return [
				{
					provider: "anthropic",
					id: "claude-sonnet-4",
					reasoning: true,
					thinking: { validLevels: ["off", "low", "medium"] },
				},
			];
		},
		async getActiveProviders() {
			return [{ provider: "anthropic", connectionKind: "credential" }];
		},
		async getState() {
			transcript.push("state");
			return { model: { provider: "anthropic", id: "claude-sonnet-4" }, thinkingLevel: "low" };
		},
		stop() {
			transcript.push("stop");
		},
	};
}

function turn(chatId: string, userMessageId: string, continued = false) {
	return {
		project,
		prompt: "hello",
		chatId,
		messageId: `assistant-${userMessageId}`,
		userMessageId,
		userMessageParentId: null,
		continued,
	};
}
function setupPublicSdkBranchFixture(
	scenario: SdkFixtureScenario,
	routingBarrierHook?: GjcLifecycleTestBarrierHook,
	sessionPortFactory?: () => PublicSdkSessionPort,
) {
	const root = mkdtempSync(join(tmpdir(), "gjc-public-sdk-branch-"));
	const sessionRoot = join(root, ".gjc", "sessions");
	const endpointRoot = join(root, ".gjc", "state", "sdk");
	const mappingFile = join(root, "mappings.json");
	const predecessorPath = join(sessionRoot, "sdk-session-created.jsonl");
	mkdirSync(sessionRoot, { recursive: true });
	mkdirSync(endpointRoot, { recursive: true });
	writeFileSync(
		predecessorPath,
		`${JSON.stringify({ type: "session", version: 3, id: "sdk-session-created", timestamp: "2026-01-01T00:00:00.000Z", cwd: root })}\n`,
	);
	const previousRoot = process.env.GJC_SDK_FIXTURE_BRANCH_ROOT;
	const previousMapping = process.env.GJC_SDK_FIXTURE_MAPPING_FILE;
	const previousCwd = process.env.GJC_SDK_FIXTURE_EXPECTED_CWD;
	process.env.GJC_SDK_FIXTURE_BRANCH_ROOT = root;
	process.env.GJC_SDK_FIXTURE_MAPPING_FILE = mappingFile;
	process.env.GJC_SDK_FIXTURE_EXPECTED_CWD = root;
	const server = startSdkFixtureServer(scenario);
	writeFileSync(
		join(endpointRoot, "sdk-session-created.json"),
		JSON.stringify({ version: 1, url: server.url, token: server.token }),
	);
	const branchProject = { ...project, cwd: root, sessionRoot };
	const mappings = new FileBackedSessionMappingStore(mappingFile);
	mappings.setScoped(
		{ principalId: "owner-q16", chatId: "chat-q16" },
		{
			...mappingInput(mediumSelection),
			chatId: "chat-q16",
			projectId: branchProject.id,
			sessionId: "sdk-session-created",
			sessionFile: predecessorPath,
			operationId: "predecessor-q16",
			modelSelection: undefined,
		},
	);
	const runnerInput = {
		cliPath: join(root, "missing-gjc-cli"),
		runtimeLocations: {
			childEnvironment: { HOME: root, GJC_CONFIG_DIR: join(root, ".gjc"), GJC_CODING_AGENT_DIR: join(root, ".gjc") },
		} as GjcRuntimeLocations,
		turnTimeoutMs: 1_000,
		...(sessionPortFactory === undefined ? {} : { sessionPortFactory }),
	};
	const runner = createGjcRoutingLiveGatewayRunner({
		turnRunner: createPublicSdkGjcTurnRunner(runnerInput),
		mappings,
		ownerUserId: "owner-q16",
		testBarrierHook: routingBarrierHook,
	});
	return {
		server,
		runner,
		runnerInput,
		mappingFile,
		project: branchProject,
		successorPath: join(realpathSync(root), ".gjc", "sessions", "sdk-session-successor.jsonl"),
		turn: {
			project: branchProject,
			prompt: "branch successor",
			chatId: "chat-q16",
			messageId: "assistant-q16",
			userMessageId: "branch-q16",
			userMessageParentId: "assistant-q16",
			continued: true,
			ownerUserId: "owner-q16",
			control: { operation: "branch" as const },
			messageMetadata: {
				gjc_adapter: {
					ownerUserId: "owner-q16",
					projectId: branchProject.id,
					gjcSessionId: "sdk-session-created",
					gjcEntryId: "entry-q16",
					openwebuiMessageId: "assistant-q16",
				},
			},
		},
		dispose() {
			server.stop();
			rmSync(root, { recursive: true, force: true });
			restoreEnv("GJC_SDK_FIXTURE_BRANCH_ROOT", previousRoot);
			restoreEnv("GJC_SDK_FIXTURE_MAPPING_FILE", previousMapping);
			restoreEnv("GJC_SDK_FIXTURE_EXPECTED_CWD", previousCwd);
		},
	};
}

function setupPublicRunnerBarrierFixture(
	phase: "post_mutation_pre_proof" | "pre_durable_publication" | "post_close_proof_pre_commit",
): {
	readonly runner: ReturnType<typeof createPublicSdkGjcTurnRunner>;
	readonly address: {
		readonly cwd: string;
		readonly sessionRoot: string;
		readonly projectId: string;
		readonly chatId: string;
		readonly sessionId: string;
		readonly sessionFile: string;
	};
	readonly server: SdkFixtureServer;
	readonly hits: number;
	readonly dispose: () => void;
} {
	const root = mkdtempSync(join(tmpdir(), "gjc-public-runner-barrier-"));
	const sessionId = "sdk-session-created";
	const sessionRoot = join(root, ".gjc", "sessions");
	const endpointRoot = join(root, ".gjc", "state", "sdk");
	const sessionFile = join(sessionRoot, `${sessionId}.jsonl`);
	const server = startSdkFixtureServer("turn_complete", root);
	let hits = 0;
	mkdirSync(endpointRoot, { recursive: true });
	mkdirSync(sessionRoot, { recursive: true });
	writeFileSync(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: root })}\n`,
	);
	writeFileSync(
		join(endpointRoot, `${sessionId}.json`),
		JSON.stringify({ version: 1, url: server.url, token: server.token }),
	);
	const runner = createPublicSdkGjcTurnRunner({
		cliPath: join(root, "missing-gjc-cli"),
		runtimeLocations: {
			childEnvironment: { HOME: root, GJC_CONFIG_DIR: join(root, ".gjc"), GJC_CODING_AGENT_DIR: join(root, ".gjc") },
		} as GjcRuntimeLocations,
		turnTimeoutMs: 1_000,
		testBarrierHook: observed => {
			if (observed !== phase) return;
			hits += 1;
			unlinkSync(join(root, ".gjc", "state", "sdk", `${sessionId}.json`));
		},
	});
	return {
		runner,
		address: { cwd: root, sessionRoot, projectId: "barrier", chatId: "barrier", sessionId, sessionFile },
		server,
		get hits() {
			return hits;
		},
		dispose() {
			server.stop();
			rmSync(root, { recursive: true, force: true });
		},
	};
}
function provisionalPersistenceCheckingPort(
	mappingFile: string,
	alreadyChecked: () => boolean,
	observed: () => void,
): PublicSdkSessionPort {
	const client = new PublicSdkSessionClient();
	return new Proxy(client, {
		get(target, property) {
			const value = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			if (property !== "prompt") return value.bind(target);
			return async (...args: Parameters<PublicSdkSessionPort["prompt"]>) => {
				if (!alreadyChecked()) {
					const persisted: unknown = readAuthorityMerged(mappingFile);
					expect(persisted).toMatchObject({
						provisionalOperations: [
							{
								kind: "create",
								state: "pending",
								sessionId: expect.any(String),
								attachment: expect.objectContaining({
									expectedSessionId: expect.any(String),
									expectedCwd: expect.any(String),
								}),
							},
						],
					});
					expect(JSON.stringify(persisted)).not.toContain('"sessionFile"');
					observed();
				}
				return value.call(target, ...args);
			};
		},
	}) as PublicSdkSessionPort;
}
function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}
function tmux(args: readonly string[], required = true): string {
	const result = Bun.spawnSync(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
	if (required && result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
	return new TextDecoder().decode(result.stdout).trim();
}
