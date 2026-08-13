import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { AuthorityMutationLock } from "../src/gjc/session-authority-file";
import {
	preflightSessionAuthorityMigration,
	preflightSessionAuthorityMigrationCandidates,
} from "../src/gjc/session-authority-migration";
import { FileSessionAuthority } from "../src/gjc/session-authority-persistence";

const NOW = () => "2026-01-01T00:00:00.000Z";

function withRoot(run: (root: string, sourcePath: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "gjc-authority-migration-"));
	try {
		run(root, join(root, "authority.json"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function legacyDocument(): { mappings: Array<Record<string, unknown>> } {
	return {
		mappings: [
			{
				chatId: "chat-1",
				projectId: "project-1",
				sessionId: "session-1",
				rawFrameCursor: 4,
				eventCursor: 7,
				operationId: "mapping-op",
				assistantText: "transcript reply",
				events: [{ type: "assistant", text: "transcript reply", payload: { nested: { preserved: true } } }],
				journal: [],
			},
		],
	};
}
function orphanedProvisionalOperation(): Record<string, unknown> {
	return {
		id: "orphaned-op",
		kind: "create",
		state: "uncertain",
		ingressId: "orphaned-op",
		startedAt: NOW(),
		chatId: "missing-chat",
		projectId: "project-1",
	};
}
function validRawProvisionalOperation(): Record<string, unknown> {
	return {
		...orphanedProvisionalOperation(),
		id: "raw-op",
		ingressId: "raw-op",
		chatId: "chat-1",
	};
}

function scopedV2Document(): Record<string, unknown> {
	const chatId = JSON.stringify(["admin-1", "chat-1"]);
	return {
		kind: "openwebui-gjc-session-authority",
		version: 2,
		mappings: [
			{
				version: 2,
				chatId,
				projectId: "project-1",
				sessionId: "session-1",
				createdAt: NOW(),
				header: { chatId, projectId: "project-1", sessionId: "session-1" },
				rawFrameCursor: 4,
				eventCursor: 7,
				operationId: "mapping-op",
				journal: [],
				observations: {
					__gjcSessionMappingScope: { principalId: "admin-1", chatId: "chat-1" },
				},
			},
		],
		provisionalOperations: [],
	};
}
function mixedV2DuplicateDocument(sessionId = "session-1"): Record<string, unknown> {
	const scoped = scopedV2Document();
	const canonical = scoped.mappings as Array<Record<string, unknown>>;
	const raw = {
		...canonical[0],
		chatId: "chat-1",
		sessionId,
		createdAt: "2026-01-02T00:00:00.000Z",
		header: { chatId: "chat-1", projectId: "project-1", sessionId },
		observations: {},
	};
	return { ...scoped, mappings: [canonical[0], raw] };
}

describe("session authority pre-store migration", () => {
	test("converts legacy mappings to the configured admin principal", () => {
		withRoot((root, sourcePath) => {
			writeFileSync(sourcePath, JSON.stringify(legacyDocument()));
			const result = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});
			expect(result.status).toBe("committed");
			expect(result.counts).toEqual({ total: 1, migrated: 1, quarantined: 0, skipped: 0 });
			const destination = JSON.parse(readFileSync(sourcePath, "utf8"));
			expect(destination.mappings[0]).toMatchObject({
				chatId: JSON.stringify(["admin-1", "chat-1"]),
				projectId: "project-1",
				sessionId: "session-1",
				assistantText: "transcript reply",
				observations: {
					__gjcSessionMappingScope: { principalId: "admin-1", chatId: "chat-1" },
				},
			});
		});
	});
	test("migrates the prior cwd-default authority into the new state session root without clearing the source", () => {
		withRoot((root, _sourcePath) => {
			const previousRoot = join(root, "previous-cwd");
			const previousPath = join(previousRoot, "openwebui-session-mappings.json");
			const destinationPath = join(root, "state", "sessions", "openwebui-session-mappings.json");
			const original = Buffer.from(JSON.stringify(legacyDocument()));
			mkdirSync(previousRoot, { recursive: true });
			writeFileSync(previousPath, original);

			const result = preflightSessionAuthorityMigrationCandidates({
				candidateSourcePaths: [previousPath],
				destinationPath,
				stateRoot: join(root, "state"),
				adminPrincipalId: "admin-1",
				now: NOW,
			});

			expect(result.status).toBe("committed");
			expect(result.sourcePath).toBe(resolve(previousPath));
			expect(result.destinationPath).toBe(resolve(destinationPath));
			expect(readFileSync(previousPath)).toEqual(original);
			expect(JSON.parse(readFileSync(destinationPath, "utf8")).mappings[0].chatId).toBe(
				JSON.stringify(["admin-1", "chat-1"]),
			);

			const rerun = preflightSessionAuthorityMigrationCandidates({
				candidateSourcePaths: [previousPath],
				destinationPath,
				stateRoot: join(root, "state"),
				adminPrincipalId: "admin-1",
				now: NOW,
			});
			expect(rerun.status).toBe("not_needed");
			expect(readFileSync(previousPath)).toEqual(original);
		});
	});
	test("does not ignore a surviving legacy candidate when a scoped destination already exists", () => {
		withRoot((root, _sourcePath) => {
			const candidatePath = join(root, "previous-cwd", "openwebui-session-mappings.json");
			const destinationPath = join(root, "state", "sessions", "openwebui-session-mappings.json");
			const candidateBytes = Buffer.from(JSON.stringify(legacyDocument()));
			const destinationBytes = Buffer.from(JSON.stringify(scopedV2Document()));
			mkdirSync(join(root, "previous-cwd"), { recursive: true });
			mkdirSync(join(root, "state", "sessions"), { recursive: true });
			writeFileSync(candidatePath, candidateBytes);
			writeFileSync(destinationPath, destinationBytes);

			const result = preflightSessionAuthorityMigrationCandidates({
				candidateSourcePaths: [candidatePath],
				destinationPath,
				stateRoot: join(root, "state"),
				adminPrincipalId: "admin-1",
				now: NOW,
			});

			expect(result.status).toBe("degraded");
			expect(result.reason).toContain("existing authority destination does not match the migration output");
			expect(readFileSync(candidatePath)).toEqual(candidateBytes);
			expect(readFileSync(destinationPath)).toEqual(destinationBytes);
			expect(readFileSync(result.sourceRecoveryPath!)).toEqual(candidateBytes);
			expect(JSON.parse(readFileSync(result.auditPath!, "utf8"))).toMatchObject({
				sourcePath: resolve(candidatePath),
				status: "source-retained",
			});

			const rerun = preflightSessionAuthorityMigrationCandidates({
				candidateSourcePaths: [candidatePath],
				destinationPath,
				stateRoot: join(root, "state"),
				adminPrincipalId: "admin-1",
				now: NOW,
			});

			expect(rerun.status).toBe("degraded");
			expect(rerun.sourceSha256).toBe(result.sourceSha256);
			expect(readFileSync(candidatePath)).toEqual(candidateBytes);
			expect(readFileSync(destinationPath)).toEqual(destinationBytes);
		});
	});

	test("migrates the explicitly managed previous root after absent candidates", () => {
		withRoot((root, _sourcePath) => {
			const previousPath = join(root, "run", "gjc-session", "openwebui-session-mappings.json");
			const destinationPath = join(root, "var", "lib", "gjc", "sessions", "openwebui-session-mappings.json");
			const original = Buffer.from(JSON.stringify(legacyDocument()));
			mkdirSync(join(root, "run", "gjc-session"), { recursive: true });
			writeFileSync(previousPath, original);

			const result = preflightSessionAuthorityMigrationCandidates({
				candidateSourcePaths: [join(root, "missing", "openwebui-session-mappings.json"), previousPath],
				destinationPath,
				stateRoot: join(root, "var", "lib", "gjc"),
				adminPrincipalId: "admin-1",
				now: NOW,
			});

			expect(result.status).toBe("committed");
			expect(result.sourcePath).toBe(resolve(previousPath));
			expect(result.destinationPath).toBe(resolve(destinationPath));
			expect(readFileSync(previousPath)).toEqual(original);
			expect(JSON.parse(readFileSync(destinationPath, "utf8")).mappings[0].chatId).toBe(
				JSON.stringify(["admin-1", "chat-1"]),
			);
		});
	});
	test("migrates a read-only managed candidate using only state-root locks", () => {
		withRoot((root, _sourcePath) => {
			const sourceDirectory = join(root, "run", "gjc-session");
			const sourcePath = join(sourceDirectory, "openwebui-session-mappings.json");
			const destinationPath = join(root, "state", "sessions", "openwebui-session-mappings.json");
			const stateRoot = join(root, "state");
			const original = Buffer.from(JSON.stringify(legacyDocument()));
			const sourceLockMarker = Buffer.from("legacy source lock marker\n");
			mkdirSync(sourceDirectory, { recursive: true });
			writeFileSync(sourcePath, original);
			writeFileSync(`${sourcePath}.lock`, sourceLockMarker);
			chmodSync(sourceDirectory, 0o555);
			try {
				const result = preflightSessionAuthorityMigrationCandidates({
					candidateSourcePaths: [sourcePath],
					destinationPath,
					stateRoot,
					adminPrincipalId: "admin-1",
					now: NOW,
				});
				expect(result.status).toBe("committed");
				expect(readFileSync(sourcePath)).toEqual(original);
				expect(readFileSync(`${sourcePath}.lock`)).toEqual(sourceLockMarker);
				expect(existsSync(join(sourceDirectory, "openwebui-session-mappings.json.lock"))).toBe(true);
				expect(JSON.parse(readFileSync(destinationPath, "utf8")).mappings[0].chatId).toBe(
					JSON.stringify(["admin-1", "chat-1"]),
				);
			} finally {
				chmodSync(sourceDirectory, 0o755);
			}
		});
	});
	test("serializes candidate migration on the state-root source lock", () => {
		withRoot((root, _sourcePath) => {
			const sourcePath = join(root, "candidate", "openwebui-session-mappings.json");
			const destinationPath = join(root, "state", "sessions", "openwebui-session-mappings.json");
			const stateRoot = join(root, "state");
			const original = Buffer.from(JSON.stringify(legacyDocument()));
			mkdirSync(join(root, "candidate"), { recursive: true });
			writeFileSync(sourcePath, original);
			const sourceDigest = createHash("sha256").update(sourcePath).digest("hex");
			const heldLock = AuthorityMutationLock.acquire(
				join(stateRoot, "session-authority-migration", "locks", `path-${sourceDigest}`),
			);
			try {
				const result = preflightSessionAuthorityMigrationCandidates({
					candidateSourcePaths: [sourcePath],
					destinationPath,
					stateRoot,
					adminPrincipalId: "admin-1",
					now: NOW,
				});
				expect(result.status).toBe("degraded");
				expect(result.reason).toContain("migration preflight persistence failed");
				expect(readFileSync(sourcePath)).toEqual(original);
				expect(existsSync(destinationPath)).toBe(false);
			} finally {
				heldLock.release();
			}
		});
	});
	test("assigns an orphaned legacy provisional operation to the configured admin namespace", () => {
		withRoot((root, sourcePath) => {
			const legacy = {
				...legacyDocument(),
				provisionalOperations: [orphanedProvisionalOperation()],
			};
			writeFileSync(sourcePath, JSON.stringify(legacy));

			const result = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});
			const destination = JSON.parse(readFileSync(sourcePath, "utf8"));

			expect(result.status).toBe("committed");
			expect(result.counts).toEqual({ total: 2, migrated: 2, quarantined: 0, skipped: 0 });
			expect(destination.mappings).toHaveLength(1);
			expect(destination.provisionalOperations).toEqual([
				expect.objectContaining({
					chatId: JSON.stringify(["admin-1", "missing-chat"]),
					state: "uncertain",
				}),
			]);
			expect(result.checkpoint?.items).toContainEqual(
				expect.objectContaining({
					identity: `provisional:0:${JSON.stringify(["admin-1", "missing-chat"])}`,
					status: "migrated",
					legacyChatId: "missing-chat",
					destinationChatId: JSON.stringify(["admin-1", "missing-chat"]),
				}),
			);
			expect(readFileSync(result.sourceRecoveryPath!)).toEqual(Buffer.from(JSON.stringify(legacy)));
		});
	});
	test("retries a preserved orphaned provisional checkpoint by assigning it to the configured admin namespace", () => {
		withRoot((root, sourcePath) => {
			const legacy = {
				...legacyDocument(),
				provisionalOperations: [orphanedProvisionalOperation()],
			};
			const sourceBytes = Buffer.from(JSON.stringify(legacy));
			const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
			const sourceIdentity = createHash("sha256").update(sourcePath).digest("hex").slice(0, 24);
			const recoveryPath = join(root, "session-authority-migration", `${basename(sourcePath)}-${sourceIdentity}`);
			const sourceRecoveryPath = join(recoveryPath, `source-${sourceSha256}.json`);
			const checkpointPath = join(recoveryPath, "checkpoint.json");
			const auditPath = join(recoveryPath, "audit.json");
			const reason =
				"legacy provisional operation 0 is malformed or ambiguous: operation references unknown chat ID missing-chat";

			writeFileSync(sourcePath, sourceBytes);
			mkdirSync(recoveryPath, { recursive: true });
			writeFileSync(sourceRecoveryPath, sourceBytes);
			writeFileSync(
				checkpointPath,
				JSON.stringify({
					kind: "openwebui-gjc-session-authority-migration",
					version: 1,
					sourcePath,
					sourceSha256,
					adminPrincipalId: "admin-1",
					sourceRecoveryPath,
					destinationPath: sourcePath,
					status: "degraded",
					items: [{ identity: "provisional:0:missing-chat", sourceIndex: 0, status: "quarantined", reason }],
					counts: { total: 1, migrated: 0, quarantined: 1, skipped: 0 },
					updatedAt: NOW(),
					completedAt: NOW(),
					reason,
				}),
			);
			writeFileSync(
				auditPath,
				JSON.stringify({
					kind: "openwebui-gjc-session-authority-migration-recovery",
					version: 1,
					sourcePath,
					sourceSha256,
					adminPrincipalId: "admin-1",
					sourceRecoveryPath,
					destinationPath: sourcePath,
					status: "degraded",
					updatedAt: NOW(),
				}),
			);

			const result = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});

			expect(result.status).toBe("committed");
			expect(result.counts).toEqual({ total: 2, migrated: 2, quarantined: 0, skipped: 0 });
			expect(JSON.parse(readFileSync(sourcePath, "utf8")).mappings).toHaveLength(1);
			expect(resolve(result.sourceRecoveryPath!)).toBe(resolve(sourceRecoveryPath));
			const rerun = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});
			expect(rerun.status).toBe("committed");
			expect(rerun.counts).toEqual(result.counts);
		});
	});
	test("converts an unscoped v2 authority document before opening the file store", () => {
		withRoot((root, sourcePath) => {
			writeFileSync(
				sourcePath,
				JSON.stringify({
					kind: "openwebui-gjc-session-authority",
					version: 2,
					mappings: legacyDocument().mappings,
					provisionalOperations: [],
				}),
			);
			const result = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});
			expect(result.status).toBe("committed");
			expect(JSON.parse(readFileSync(sourcePath, "utf8")).mappings[0].chatId).toBe(
				JSON.stringify(["admin-1", "chat-1"]),
			);
		});
	});
	test("rejects a scoped journal result with a foreign project identity", () => {
		withRoot((root, sourcePath) => {
			const source = scopedV2Document();
			const mapping = (source.mappings as Array<Record<string, unknown>>)[0];
			mapping.journal = [
				{
					id: "journal-op",
					ingressId: "journal-op",
					kind: "prompt",
					state: "complete",
					startedAt: NOW(),
					completedAt: NOW(),
					result: {
						kind: "turn",
						assistantText: "",
						events: [],
						mapping: {
							chatId: mapping.chatId,
							projectId: "foreign-project",
							sessionId: "foreign-session",
							rawFrameCursor: 0,
							eventCursor: 0,
							operationId: "journal-op",
						},
					},
				},
			];
			const sourceBytes = Buffer.from(JSON.stringify(source));
			writeFileSync(sourcePath, sourceBytes);

			const result = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});

			expect(result.status).toBe("degraded");
			expect(readFileSync(sourcePath)).toEqual(sourceBytes);
		});
	});
	test("rejects a scoped provisional result with a foreign project identity", () => {
		withRoot((root, sourcePath) => {
			const source = scopedV2Document();
			const chatId = (source.mappings as Array<Record<string, unknown>>)[0].chatId;
			source.provisionalOperations = [
				{
					...validRawProvisionalOperation(),
					chatId,
					state: "complete",
					completedAt: NOW(),
					result: {
						kind: "turn",
						assistantText: "",
						events: [],
						mapping: {
							chatId,
							projectId: "foreign-project",
							sessionId: "foreign-session",
							rawFrameCursor: 0,
							eventCursor: 0,
							operationId: "raw-op",
						},
					},
				},
			];
			const sourceBytes = Buffer.from(JSON.stringify(source));
			writeFileSync(sourcePath, sourceBytes);

			const result = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});

			expect(result.status).toBe("degraded");
			expect(readFileSync(sourcePath)).toEqual(sourceBytes);
		});
	});
	test("rejects a scoped provisional result with a foreign session identity", () => {
		withRoot((root, sourcePath) => {
			const source = scopedV2Document();
			const chatId = (source.mappings as Array<Record<string, unknown>>)[0].chatId;
			source.provisionalOperations = [
				{
					...validRawProvisionalOperation(),
					chatId,
					state: "complete",
					completedAt: NOW(),
					result: {
						kind: "turn",
						assistantText: "",
						events: [],
						mapping: {
							chatId,
							projectId: "project-1",
							sessionId: "foreign-session",
							rawFrameCursor: 0,
							eventCursor: 0,
							operationId: "raw-op",
						},
					},
				},
			];
			const sourceBytes = Buffer.from(JSON.stringify(source));
			writeFileSync(sourcePath, sourceBytes);

			const result = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});

			expect(result.status).toBe("degraded");
			expect(readFileSync(sourcePath)).toEqual(sourceBytes);
		});
	});
	test("allows an unresolved uncertain provisional operation without an authority mapping", () => {
		withRoot((root, sourcePath) => {
			const source = scopedV2Document();
			source.provisionalOperations = [orphanedProvisionalOperation()];
			const sourceBytes = Buffer.from(JSON.stringify(source));
			writeFileSync(sourcePath, sourceBytes);

			const result = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});

			expect(result.status).toBe("not_needed");
			expect(readFileSync(sourcePath)).toEqual(sourceBytes);
		});
	});
	test("rejects an empty scoped chat identity", () => {
		withRoot((root, sourcePath) => {
			const source = scopedV2Document();
			const mapping = (source.mappings as Array<Record<string, unknown>>)[0];
			const emptyChatId = JSON.stringify(["admin-1", ""]);
			mapping.chatId = emptyChatId;
			mapping.header = { chatId: emptyChatId, projectId: "project-1", sessionId: "session-1" };
			mapping.observations = {
				__gjcSessionMappingScope: { principalId: "admin-1", chatId: "" },
			};
			const sourceBytes = Buffer.from(JSON.stringify(source));
			writeFileSync(sourcePath, sourceBytes);

			const result = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});

			expect(result.status).toBe("degraded");
			expect(readFileSync(sourcePath)).toEqual(sourceBytes);
		});
	});
	test("repairs mixed v2 mappings with an exact raw duplicate without double-scoping", () => {
		withRoot((root, sourcePath) => {
			const source = mixedV2DuplicateDocument();
			const sourceBytes = Buffer.from(JSON.stringify(source));
			writeFileSync(sourcePath, sourceBytes);

			const result = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});
			const destination = JSON.parse(readFileSync(sourcePath, "utf8"));

			expect(result.status).toBe("committed");
			expect(result.counts).toEqual({ total: 2, migrated: 1, quarantined: 1, skipped: 0 });
			expect(destination.mappings).toHaveLength(1);
			expect(destination.mappings[0].chatId).toBe(JSON.stringify(["admin-1", "chat-1"]));
			expect(destination.mappings[0].sessionId).toBe("session-1");
			expect(readFileSync(result.sourceRecoveryPath!)).toEqual(sourceBytes);
			expect(result.checkpoint?.items).toContainEqual(
				expect.objectContaining({
					status: "quarantined",
					reason: expect.stringContaining("deduplicated"),
				}),
			);
			const rerun = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});
			expect(rerun.status).toBe("committed");
			expect(rerun.counts).toEqual(result.counts);
		});
	});
	test("degrades mixed v2 mappings with divergent journal history without replacing source", () => {
		withRoot((root, sourcePath) => {
			const source = mixedV2DuplicateDocument();
			const mappings = source.mappings as Array<Record<string, unknown>>;
			mappings[0].journal = [
				{ id: "journal-a", kind: "create", state: "uncertain", ingressId: "journal-a", startedAt: NOW() },
			];
			mappings[1].journal = [
				{ id: "journal-b", kind: "create", state: "uncertain", ingressId: "journal-b", startedAt: NOW() },
			];
			const sourceBytes = Buffer.from(JSON.stringify(source));
			writeFileSync(sourcePath, sourceBytes);

			const result = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});

			expect(result.status).toBe("degraded");
			expect(readFileSync(sourcePath)).toEqual(sourceBytes);
			expect(readFileSync(result.sourceRecoveryPath!)).toEqual(sourceBytes);
		});
	});
	test("reconciles only migration-owned historical duplicate operations", () => {
		withRoot((root, sourcePath) => {
			const source = mixedV2DuplicateDocument();
			const mappings = source.mappings as Array<Record<string, unknown>>;
			mappings[0].journal = [
				{
					id: "historical-import",
					kind: "prompt",
					state: "complete",
					ingressId: "historical-import",
					startedAt: NOW(),
					completedAt: NOW(),
				},
				{
					id: "historical-import:migration-0123456789abcdef",
					kind: "prompt",
					state: "complete",
					ingressId: "historical-import:migration-0123456789abcdef",
					startedAt: NOW(),
					completedAt: NOW(),
				},
			];
			mappings[1].journal = [
				{
					id: "historical-import",
					kind: "prompt",
					state: "complete",
					ingressId: "historical-import",
					startedAt: NOW(),
					completedAt: NOW(),
				},
			];
			writeFileSync(sourcePath, JSON.stringify(source));

			const result = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});
			const destination = JSON.parse(readFileSync(sourcePath, "utf8"));

			expect(result.status).toBe("committed");
			expect(destination.mappings[0].journal.map((operation: { id: string }) => operation.id)).toEqual([
				"historical-import",
				"historical-import:migration-0123456789abcdef",
			]);
		});
	});

	test("degrades mixed v2 collisions with incompatible session identity without replacing source", () => {
		withRoot((root, sourcePath) => {
			const sourceBytes = Buffer.from(JSON.stringify(mixedV2DuplicateDocument("session-other")));
			writeFileSync(sourcePath, sourceBytes);

			const result = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});

			expect(result.status).toBe("degraded");
			expect(readFileSync(sourcePath)).toEqual(sourceBytes);
			expect(readFileSync(result.sourceRecoveryPath!)).toEqual(sourceBytes);
		});
	});
	test("normalizes a raw mixed-v2 provisional operation to its canonical mapping", () => {
		withRoot((root, sourcePath) => {
			const source = mixedV2DuplicateDocument();
			source.provisionalOperations = [validRawProvisionalOperation()];
			writeFileSync(sourcePath, JSON.stringify(source));

			const result = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});
			const destination = JSON.parse(readFileSync(sourcePath, "utf8"));

			expect(result.status).toBe("committed");
			expect(destination.provisionalOperations).toHaveLength(1);
			expect(destination.provisionalOperations[0].chatId).toBe(JSON.stringify(["admin-1", "chat-1"]));
		});
	});
	test("normalizes a canonical provisional operation for a raw-only mixed-v2 mapping", () => {
		withRoot((root, sourcePath) => {
			const source = mixedV2DuplicateDocument();
			const mappings = source.mappings as Array<Record<string, unknown>>;
			source.mappings = [mappings[1]];
			const canonicalChatId = JSON.stringify(["admin-1", "chat-1"]);
			source.provisionalOperations = [{ ...validRawProvisionalOperation(), chatId: canonicalChatId }];
			writeFileSync(sourcePath, JSON.stringify(source));

			const result = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});
			const destination = JSON.parse(readFileSync(sourcePath, "utf8"));

			expect(result.status).toBe("committed");
			expect(destination.provisionalOperations).toHaveLength(1);
			expect(destination.provisionalOperations[0].chatId).toBe(canonicalChatId);
		});
	});
	test("quarantines a provisional result that conflicts with its operation identity", () => {
		withRoot((root, sourcePath) => {
			const source = mixedV2DuplicateDocument();
			source.provisionalOperations = [
				{
					...validRawProvisionalOperation(),
					state: "complete",
					completedAt: NOW(),
					result: {
						kind: "turn",
						assistantText: "",
						events: [],
						mapping: {
							chatId: "chat-1",
							projectId: "foreign-project",
							sessionId: "foreign-session",
							rawFrameCursor: 0,
							eventCursor: 0,
							operationId: "foreign-operation",
						},
					},
				},
			];
			writeFileSync(sourcePath, JSON.stringify(source));

			const result = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});
			const destination = JSON.parse(readFileSync(sourcePath, "utf8"));

			expect(result.status).toBe("committed");
			expect(destination.provisionalOperations).toEqual([]);
			expect(result.checkpoint?.items).toContainEqual(
				expect.objectContaining({
					identity: "provisional:0:chat-1",
					status: "quarantined",
					reason: expect.stringContaining("operation result mapping does not match"),
				}),
			);
		});
	});
	test("quarantines a mixed-v2 provisional result with a foreign owner session", () => {
		withRoot((root, sourcePath) => {
			const source = mixedV2DuplicateDocument();
			source.provisionalOperations = [
				{
					...validRawProvisionalOperation(),
					state: "complete",
					completedAt: NOW(),
					result: {
						kind: "turn",
						assistantText: "",
						events: [],
						mapping: {
							chatId: "chat-1",
							projectId: "project-1",
							sessionId: "foreign-session",
							rawFrameCursor: 0,
							eventCursor: 0,
							operationId: "raw-op",
						},
						correlation: {
							chatId: "chat-1",
							projectId: "project-1",
							sessionId: "foreign-session",
							operationId: "raw-op",
						},
					},
				},
			];
			writeFileSync(sourcePath, JSON.stringify(source));

			const result = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});

			expect(result.status).toBe("committed");
			expect(JSON.parse(readFileSync(sourcePath, "utf8")).provisionalOperations).toEqual([]);
			expect(result.checkpoint?.items).toContainEqual(
				expect.objectContaining({
					identity: "provisional:0:chat-1",
					status: "quarantined",
					reason: expect.stringContaining("operation result mapping does not match"),
				}),
			);
		});
	});
	test("quarantines a legacy provisional result with a foreign owner session", () => {
		withRoot((root, sourcePath) => {
			const source = {
				...legacyDocument(),
				provisionalOperations: [
					{
						...validRawProvisionalOperation(),
						state: "complete",
						completedAt: NOW(),
						result: {
							kind: "turn",
							assistantText: "",
							events: [],
							mapping: {
								chatId: "chat-1",
								projectId: "project-1",
								sessionId: "foreign-session",
								rawFrameCursor: 0,
								eventCursor: 0,
								operationId: "raw-op",
							},
							correlation: {
								chatId: "chat-1",
								projectId: "project-1",
								sessionId: "foreign-session",
								operationId: "raw-op",
							},
						},
					},
				],
			};
			writeFileSync(sourcePath, JSON.stringify(source));

			const result = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});

			expect(result.status).toBe("committed");
			expect(JSON.parse(readFileSync(sourcePath, "utf8")).provisionalOperations).toEqual([]);
			expect(result.checkpoint?.items).toContainEqual(
				expect.objectContaining({
					identity: "provisional:0:chat-1",
					status: "quarantined",
					reason: expect.stringContaining("operation result mapping does not match"),
				}),
			);
		});
	});

	test("preserves a valid runtime destination when its recovery source is invalid", () => {
		withRoot((root, sourcePath) => {
			writeFileSync(sourcePath, JSON.stringify(legacyDocument()));
			const old = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});
			const current = scopedV2Document();
			const currentBytes = Buffer.from(JSON.stringify(current));
			writeFileSync(sourcePath, currentBytes);
			const invalidRecovery = scopedV2Document();
			const chatId = (invalidRecovery.mappings as Array<Record<string, unknown>>)[0].chatId;
			invalidRecovery.provisionalOperations = [
				{
					...validRawProvisionalOperation(),
					chatId,
					state: "complete",
					completedAt: NOW(),
					result: {
						kind: "turn",
						assistantText: "",
						events: [],
						mapping: {
							chatId,
							projectId: "project-1",
							sessionId: "foreign-session",
							rawFrameCursor: 0,
							eventCursor: 0,
							operationId: "raw-op",
						},
					},
				},
			];
			const recoveryBytes = Buffer.from(JSON.stringify(invalidRecovery));
			const recoverySha256 = createHash("sha256").update(recoveryBytes).digest("hex");
			const sourceIdentity = createHash("sha256").update(sourcePath).digest("hex").slice(0, 24);
			const recoveryPath = join(root, "session-authority-migration", `${basename(sourcePath)}-${sourceIdentity}`);
			const recoverySourcePath = join(recoveryPath, `source-${recoverySha256}.json`);
			mkdirSync(recoveryPath, { recursive: true });
			writeFileSync(recoverySourcePath, recoveryBytes);
			writeFileSync(
				old.auditPath!,
				JSON.stringify({
					kind: "openwebui-gjc-session-authority-migration-recovery",
					version: 1,
					sourcePath,
					sourceSha256: recoverySha256,
					adminPrincipalId: "admin-1",
					sourceRecoveryPath: recoverySourcePath,
					destinationPath: sourcePath,
					expectedDestinationSha256: createHash("sha256").update(currentBytes).digest("hex"),
					status: "destination-written",
					updatedAt: NOW(),
				}),
			);

			const result = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});

			expect(result.status).toBe("degraded");
			expect(result.reason).toContain("unbound operation identity");
			expect(readFileSync(sourcePath)).toEqual(currentBytes);
		});
	});
	test("rebuilds mixed-v2 output when the destination is missing", () => {
		withRoot((root, sourcePath) => {
			writeFileSync(sourcePath, JSON.stringify(mixedV2DuplicateDocument()));
			const first = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});
			unlinkSync(sourcePath);

			const restored = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});

			expect(restored.status).toBe("committed");
			expect(restored.checkpoint?.destinationSha256).toBe(first.checkpoint?.destinationSha256);
			expect(JSON.parse(readFileSync(sourcePath, "utf8")).mappings).toHaveLength(1);
		});
	});
	test("restores a committed destination despite a malformed audit manifest", () => {
		withRoot((root, sourcePath) => {
			writeFileSync(sourcePath, JSON.stringify(mixedV2DuplicateDocument()));
			const first = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});
			unlinkSync(sourcePath);
			writeFileSync(first.auditPath!, "{");

			const restored = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});

			expect(restored.status).toBe("committed");
			expect(restored.checkpoint?.status).toBe("committed");
			expect(JSON.parse(readFileSync(sourcePath, "utf8")).mappings).toHaveLength(1);
		});
	});
	test("rejects a valid-shaped foreign manifest before missing-destination recovery", () => {
		withRoot((root, sourcePath) => {
			writeFileSync(sourcePath, JSON.stringify(mixedV2DuplicateDocument()));
			const first = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});
			const manifest = JSON.parse(readFileSync(first.auditPath!, "utf8"));
			manifest.adminPrincipalId = "foreign-admin";
			writeFileSync(first.auditPath!, JSON.stringify(manifest));
			unlinkSync(sourcePath);

			const result = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});

			expect(result.status).toBe("degraded");
			expect(result.reason).toContain("belongs to a different source or principal");
			expect(() => readFileSync(sourcePath)).toThrow();
		});
	});
	test("prefers a newer committed checkpoint over a stale checkpointed manifest", () => {
		withRoot((root, sourcePath) => {
			writeFileSync(sourcePath, JSON.stringify(legacyDocument()));
			const first = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});
			const staleAudit = readFileSync(first.auditPath!);

			const newerDestination = scopedV2Document();
			const newerBytes = Buffer.from(JSON.stringify(newerDestination));
			writeFileSync(sourcePath, newerBytes);
			const newer = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});
			writeFileSync(first.auditPath!, staleAudit);
			unlinkSync(sourcePath);

			const restored = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});

			expect(restored.status).toBe("committed");
			expect(restored.checkpoint?.sourceSha256).toBe(newer.checkpoint?.sourceSha256);
			expect(readFileSync(sourcePath)).toEqual(newerBytes);
		});
	});

	test("rebuilds a mixed-v2 checkpoint after destination replacement", () => {
		withRoot((root, sourcePath) => {
			writeFileSync(sourcePath, JSON.stringify(mixedV2DuplicateDocument()));
			const first = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});
			unlinkSync(first.checkpointPath!);

			const restored = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});

			expect(restored.status).toBe("committed");
			expect(restored.checkpoint?.destinationSha256).toBe(first.checkpoint?.destinationSha256);
			expect(restored.checkpoint?.status).toBe("committed");
		});
	});
	test("rebuilds an older committed checkpoint from an in-flight destination manifest", () => {
		withRoot((root, sourcePath) => {
			writeFileSync(sourcePath, JSON.stringify(legacyDocument()));
			const old = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});

			writeFileSync(sourcePath, JSON.stringify(mixedV2DuplicateDocument()));
			const stagingRoot = join(root, "staging");
			const staged = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: stagingRoot,
				adminPrincipalId: "admin-1",
				now: NOW,
			});
			const stagedDestination = readFileSync(sourcePath);
			const stagedManifest = JSON.parse(readFileSync(staged.auditPath!, "utf8"));
			const sourceBytes = readFileSync(staged.sourceRecoveryPath!);
			const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
			const sourceIdentity = createHash("sha256").update(sourcePath).digest("hex").slice(0, 24);
			const recoveryPath = join(root, "session-authority-migration", `${basename(sourcePath)}-${sourceIdentity}`);
			const sourceRecoveryPath = join(recoveryPath, `source-${sourceSha256}.json`);
			mkdirSync(recoveryPath, { recursive: true });
			writeFileSync(sourceRecoveryPath, sourceBytes);
			stagedManifest.sourceRecoveryPath = sourceRecoveryPath;
			stagedManifest.status = "destination-written";
			stagedManifest.expectedDestinationSha256 = old.checkpoint?.destinationSha256;
			writeFileSync(old.auditPath!, JSON.stringify(stagedManifest));
			writeFileSync(sourcePath, stagedDestination);

			const restored = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});

			expect(restored.status).toBe("committed");
			expect(restored.checkpoint?.sourceSha256).toBe(sourceSha256);
			expect(restored.checkpoint?.destinationSha256).toBe(
				createHash("sha256").update(stagedDestination).digest("hex"),
			);
		});
	});
	test("restores a newer destination-written manifest before an older committed checkpoint", () => {
		withRoot((root, sourcePath) => {
			writeFileSync(sourcePath, JSON.stringify(legacyDocument()));
			const old = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});

			writeFileSync(sourcePath, JSON.stringify(mixedV2DuplicateDocument()));
			const stagingRoot = join(root, "staging-missing-destination");
			const staged = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: stagingRoot,
				adminPrincipalId: "admin-1",
				now: NOW,
			});
			const sourceBytes = readFileSync(staged.sourceRecoveryPath!);
			const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
			const sourceIdentity = createHash("sha256").update(sourcePath).digest("hex").slice(0, 24);
			const recoveryPath = join(root, "session-authority-migration", `${basename(sourcePath)}-${sourceIdentity}`);
			const sourceRecoveryPath = join(recoveryPath, `source-${sourceSha256}.json`);
			const manifest = JSON.parse(readFileSync(staged.auditPath!, "utf8"));
			mkdirSync(recoveryPath, { recursive: true });
			writeFileSync(sourceRecoveryPath, sourceBytes);
			manifest.sourceRecoveryPath = sourceRecoveryPath;
			manifest.status = "destination-written";
			writeFileSync(old.auditPath!, JSON.stringify(manifest));
			unlinkSync(sourcePath);

			const restored = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});

			expect(restored.status).toBe("committed");
			expect(restored.checkpoint?.sourceSha256).toBe(sourceSha256);
			expect(JSON.parse(readFileSync(sourcePath, "utf8")).mappings).toHaveLength(1);
		});
	});
	test("rebuilds a missing destination and checkpoint from a destination-written manifest", () => {
		withRoot((root, sourcePath) => {
			writeFileSync(sourcePath, JSON.stringify(mixedV2DuplicateDocument()));
			const stagingRoot = join(root, "staging-without-checkpoint");
			const staged = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: stagingRoot,
				adminPrincipalId: "admin-1",
				now: NOW,
			});
			const sourceBytes = readFileSync(staged.sourceRecoveryPath!);
			const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
			const sourceIdentity = createHash("sha256").update(sourcePath).digest("hex").slice(0, 24);
			const recoveryPath = join(root, "session-authority-migration", `${basename(sourcePath)}-${sourceIdentity}`);
			const sourceRecoveryPath = join(recoveryPath, `source-${sourceSha256}.json`);
			const auditPath = join(recoveryPath, "audit.json");
			const manifest = JSON.parse(readFileSync(staged.auditPath!, "utf8"));
			mkdirSync(recoveryPath, { recursive: true });
			writeFileSync(sourceRecoveryPath, sourceBytes);
			manifest.sourceRecoveryPath = sourceRecoveryPath;
			manifest.status = "destination-written";
			writeFileSync(auditPath, JSON.stringify(manifest));
			unlinkSync(sourcePath);

			const restored = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});

			expect(restored.status).toBe("committed");
			expect(restored.checkpoint?.sourceSha256).toBe(sourceSha256);
			expect(JSON.parse(readFileSync(sourcePath, "utf8")).mappings).toHaveLength(1);
		});
	});
	test("refuses to restore an invalid scoped authority from manifest recovery bytes", () => {
		withRoot((root, sourcePath) => {
			const source = scopedV2Document();
			const chatId = (source.mappings as Array<Record<string, unknown>>)[0].chatId;
			source.provisionalOperations = [
				{
					...validRawProvisionalOperation(),
					chatId,
					state: "complete",
					completedAt: NOW(),
					result: {
						kind: "turn",
						assistantText: "",
						events: [],
						mapping: {
							chatId,
							projectId: "project-1",
							sessionId: "foreign-session",
							rawFrameCursor: 0,
							eventCursor: 0,
							operationId: "raw-op",
						},
					},
				},
			];
			const sourceBytes = Buffer.from(JSON.stringify(source));
			const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
			const sourceIdentity = createHash("sha256").update(sourcePath).digest("hex").slice(0, 24);
			const recoveryPath = join(root, "session-authority-migration", `${basename(sourcePath)}-${sourceIdentity}`);
			const sourceRecoveryPath = join(recoveryPath, `source-${sourceSha256}.json`);
			mkdirSync(recoveryPath, { recursive: true });
			writeFileSync(sourceRecoveryPath, sourceBytes);
			writeFileSync(
				join(recoveryPath, "audit.json"),
				JSON.stringify({
					kind: "openwebui-gjc-session-authority-migration-recovery",
					version: 1,
					sourcePath,
					sourceSha256,
					adminPrincipalId: "admin-1",
					sourceRecoveryPath,
					destinationPath: sourcePath,
					expectedDestinationSha256: sourceSha256,
					status: "destination-written",
					updatedAt: NOW(),
				}),
			);

			const result = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});

			expect(result.status).toBe("degraded");
			expect(result.reason).toContain("unbound operation identity");
			expect(() => readFileSync(sourcePath)).toThrow();
		});
	});
	test("does not restore a stale manifest after a newer scoped source is degraded", () => {
		withRoot((root, sourcePath) => {
			writeFileSync(sourcePath, JSON.stringify(legacyDocument()));
			preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});
			const source = scopedV2Document();
			const chatId = (source.mappings as Array<Record<string, unknown>>)[0].chatId;
			source.provisionalOperations = [
				{
					...validRawProvisionalOperation(),
					chatId,
					state: "complete",
					completedAt: NOW(),
					result: {
						kind: "turn",
						assistantText: "",
						events: [],
						mapping: {
							chatId,
							projectId: "project-1",
							sessionId: "foreign-session",
							rawFrameCursor: 0,
							eventCursor: 0,
							operationId: "raw-op",
						},
					},
				},
			];
			writeFileSync(sourcePath, JSON.stringify(source));

			const degraded = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});
			expect(degraded.status).toBe("degraded");
			unlinkSync(sourcePath);

			const retried = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});

			expect(retried.status).toBe("degraded");
			expect(retried.checkpoint?.sourceSha256).toBe(degraded.sourceSha256);
			expect(() => readFileSync(sourcePath)).toThrow();
		});
	});
	test("refreshes a valid scoped destination checkpoint after runtime mutation", () => {
		withRoot((root, sourcePath) => {
			writeFileSync(sourcePath, JSON.stringify(mixedV2DuplicateDocument()));
			preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});
			const destination = JSON.parse(readFileSync(sourcePath, "utf8"));
			destination.mappings[0].sessionId = "replacement-session";
			destination.mappings[0].header.sessionId = "replacement-session";
			writeFileSync(sourcePath, JSON.stringify(destination));

			const result = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});

			expect(result.status).toBe("committed");
			expect(result.checkpoint?.destinationSha256).toBe(result.sourceSha256);
		});
	});
	test("preserves principal-scoped normal-user mappings after admin legacy migration", () => {
		withRoot((root, sourcePath) => {
			writeFileSync(sourcePath, JSON.stringify(mixedV2DuplicateDocument()));
			preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});
			const destination = JSON.parse(readFileSync(sourcePath, "utf8"));
			const normalChatId = JSON.stringify(["normal-1", "chat-2"]);
			destination.mappings.push({
				...destination.mappings[0],
				chatId: normalChatId,
				sessionId: "normal-session-2",
				header: {
					chatId: normalChatId,
					projectId: "project-1",
					sessionId: "normal-session-2",
				},
				observations: {
					__gjcSessionMappingScope: { principalId: "normal-1", chatId: "chat-2" },
				},
			});
			const runtimeBytes = Buffer.from(JSON.stringify(destination));
			writeFileSync(sourcePath, runtimeBytes);

			const result = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});

			expect(result.status).toBe("committed");
			expect(readFileSync(sourcePath)).toEqual(runtimeBytes);
			expect(result.checkpoint?.destinationSha256).toBe(result.sourceSha256);
		});
	});
	test("restores exact scoped runtime bytes and unresolved provisional evidence", () => {
		withRoot((root, sourcePath) => {
			writeFileSync(sourcePath, JSON.stringify(mixedV2DuplicateDocument()));
			preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});
			const destination = JSON.parse(readFileSync(sourcePath, "utf8"));
			destination.provisionalOperations = [orphanedProvisionalOperation()];
			const runtimeBytes = Buffer.from(JSON.stringify(destination));
			writeFileSync(sourcePath, runtimeBytes);
			const committed = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});
			expect(committed.status).toBe("committed");
			unlinkSync(sourcePath);

			const restored = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});

			expect(restored.status).toBe("committed");
			expect(readFileSync(sourcePath)).toEqual(runtimeBytes);
			expect(JSON.parse(readFileSync(sourcePath, "utf8")).provisionalOperations).toHaveLength(1);
		});
	});
	test("restores exact mixed-principal scoped runtime bytes", () => {
		withRoot((root, sourcePath) => {
			writeFileSync(sourcePath, JSON.stringify(mixedV2DuplicateDocument()));
			preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});
			const destination = JSON.parse(readFileSync(sourcePath, "utf8"));
			const normalChatId = JSON.stringify(["normal-1", "chat-2"]);
			destination.mappings.push({
				...destination.mappings[0],
				chatId: normalChatId,
				sessionId: "normal-session-2",
				header: {
					chatId: normalChatId,
					projectId: "project-1",
					sessionId: "normal-session-2",
				},
				observations: {
					__gjcSessionMappingScope: { principalId: "normal-1", chatId: "chat-2" },
				},
			});
			const runtimeBytes = Buffer.from(JSON.stringify(destination));
			writeFileSync(sourcePath, runtimeBytes);
			const committed = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});
			expect(committed.status).toBe("committed");
			unlinkSync(sourcePath);

			const restored = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});

			expect(restored.status).toBe("committed");
			expect(readFileSync(sourcePath)).toEqual(runtimeBytes);
		});
	});
	test("rejects a malformed fully scoped destination instead of normalizing it", () => {
		withRoot((root, sourcePath) => {
			writeFileSync(sourcePath, JSON.stringify(mixedV2DuplicateDocument()));
			preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});
			const destination = JSON.parse(readFileSync(sourcePath, "utf8"));
			destination.provisionalOperations = { malformed: true };
			writeFileSync(sourcePath, JSON.stringify(destination));

			const result = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});

			expect(result.status).toBe("degraded");
			expect(result.reason).toContain("fully scoped v2 authority destination has unbound operation identity");
		});
	});
	test("quarantines malformed mixed-v2 provisional input without stranding valid mappings", () => {
		withRoot((root, sourcePath) => {
			const source = mixedV2DuplicateDocument();
			source.provisionalOperations = [{ id: "broken" }];
			writeFileSync(sourcePath, JSON.stringify(source));

			const result = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});
			const destination = JSON.parse(readFileSync(sourcePath, "utf8"));

			expect(result.status).toBe("committed");
			expect(destination.mappings).toHaveLength(1);
			expect(destination.provisionalOperations).toEqual([]);
			expect(result.counts).toEqual({ total: 3, migrated: 1, quarantined: 2, skipped: 0 });
		});
	});
	test("quarantines a non-array mixed-v2 provisional collection without stranding valid mappings", () => {
		withRoot((root, sourcePath) => {
			const source = mixedV2DuplicateDocument();
			source.provisionalOperations = validRawProvisionalOperation();
			writeFileSync(sourcePath, JSON.stringify(source));

			const result = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});
			const destination = JSON.parse(readFileSync(sourcePath, "utf8"));

			expect(result.status).toBe("committed");
			expect(destination.mappings).toHaveLength(1);
			expect(destination.provisionalOperations).toEqual([]);
			expect(result.checkpoint?.items).toContainEqual(
				expect.objectContaining({ identity: "provisional:collection", status: "quarantined" }),
			);
		});
	});
	test("quarantines malformed v2 mappings without re-entering legacy canonicalization", () => {
		withRoot((root, sourcePath) => {
			const source = scopedV2Document();
			const mappings = source.mappings as Array<Record<string, unknown>>;
			mappings.push({ chatId: JSON.stringify(["admin-1", "malformed"]) });
			writeFileSync(sourcePath, JSON.stringify(source));

			const result = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});
			const destination = JSON.parse(readFileSync(sourcePath, "utf8"));

			expect(result.status).toBe("committed");
			expect(destination.mappings).toHaveLength(1);
			expect(result.checkpoint?.items).toContainEqual(
				expect.objectContaining({
					identity: `mapping:1:${JSON.stringify(["admin-1", "malformed"])}`,
					status: "quarantined",
				}),
			);
		});
	});
	test("rejects an otherwise scoped record carrying a foreign principal identity", () => {
		withRoot((root, sourcePath) => {
			const source = scopedV2Document();
			(source.mappings as Array<Record<string, unknown>>)[0].principalId = "foreign-principal";
			writeFileSync(sourcePath, JSON.stringify(source));

			const result = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});

			expect(result.status).toBe("degraded");
			expect(result.reason).toContain("v2 mapping principal does not match configured admin");
		});
	});
	test("renormalizes an evolved unscoped v2 authority document after a committed checkpoint", () => {
		withRoot((root, sourcePath) => {
			writeFileSync(sourcePath, JSON.stringify(mixedV2DuplicateDocument()));
			preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});
			const destination = JSON.parse(readFileSync(sourcePath, "utf8"));
			delete destination.mappings[0].observations.__gjcSessionMappingScope;
			destination.mappings[0].sessionId = "replacement-session";
			destination.mappings[0].header.sessionId = "replacement-session";
			writeFileSync(sourcePath, JSON.stringify(destination));

			const result = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});

			expect(result.status).toBe("committed");
			expect(JSON.parse(readFileSync(sourcePath, "utf8")).mappings[0].chatId).toBe(
				JSON.stringify(["admin-1", "chat-1"]),
			);
		});
	});
	test("retries a retained degraded mixed v2 authority checkpoint", () => {
		withRoot((root, sourcePath) => {
			const sourceBytes = Buffer.from(JSON.stringify(mixedV2DuplicateDocument()));
			const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
			const sourceIdentity = createHash("sha256").update(sourcePath).digest("hex").slice(0, 24);
			const recoveryPath = join(root, "session-authority-migration", `${basename(sourcePath)}-${sourceIdentity}`);
			const sourceRecoveryPath = join(recoveryPath, `source-${sourceSha256}.json`);
			writeFileSync(sourcePath, sourceBytes);
			mkdirSync(recoveryPath, { recursive: true });
			writeFileSync(sourceRecoveryPath, sourceBytes);
			writeFileSync(
				join(recoveryPath, "checkpoint.json"),
				JSON.stringify({
					kind: "openwebui-gjc-session-authority-migration",
					version: 1,
					sourcePath,
					sourceSha256,
					adminPrincipalId: "admin-1",
					sourceRecoveryPath,
					destinationPath: sourcePath,
					status: "degraded",
					items: [
						{
							identity: "document",
							sourceIndex: 0,
							status: "quarantined",
							reason: "old migration rejected mixed v2",
						},
					],
					counts: { total: 1, migrated: 0, quarantined: 1, skipped: 0 },
					updatedAt: NOW(),
					completedAt: NOW(),
					reason: "old migration rejected mixed v2",
				}),
			);

			const result = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});

			expect(result.status).toBe("committed");
			expect(result.counts).toEqual({ total: 2, migrated: 1, quarantined: 1, skipped: 0 });
			expect(JSON.parse(readFileSync(sourcePath, "utf8")).mappings).toHaveLength(1);
		});
	});

	test("retains exact source bytes and source digest in migration recovery", () => {
		withRoot((root, sourcePath) => {
			const original = Buffer.from(JSON.stringify(legacyDocument()));
			writeFileSync(sourcePath, original);
			const result = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});
			expect(readFileSync(result.sourceRecoveryPath!)).toEqual(original);
			expect(result.checkpoint?.sourceSha256).toBe(result.sourceSha256);
			expect(result.auditPath).toBeDefined();
			expect(JSON.parse(readFileSync(result.auditPath!, "utf8")).sourceSha256).toBe(result.sourceSha256);
		});
	});

	test("rebuilds a missing checkpoint after destination replacement", () => {
		withRoot((root, sourcePath) => {
			writeFileSync(sourcePath, JSON.stringify(legacyDocument()));
			const first = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});
			const destinationBytes = readFileSync(sourcePath);
			unlinkSync(first.checkpointPath!);
			const rerun = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});
			expect(rerun.status).toBe("committed");
			expect(rerun.checkpoint?.status).toBe("committed");
			expect(readFileSync(sourcePath)).toEqual(destinationBytes);
		});
	});

	test("preserves nested journal operation results and transcript events", () => {
		withRoot((root, sourcePath) => {
			const legacy = legacyDocument();
			legacy.mappings[0]!.journal = [
				{
					id: "prompt-op",
					kind: "prompt",
					state: "complete",
					startedAt: NOW(),
					completedAt: "2026-01-01T00:00:01.000Z",
					result: {
						kind: "turn",
						assistantText: "nested reply",
						events: [{ type: "assistant", text: "nested reply", payload: { keep: [1, 2, 3] } }],
						mapping: {
							chatId: "chat-1",
							projectId: "project-1",
							sessionId: "session-1",
							rawFrameCursor: 5,
							eventCursor: 8,
							operationId: "prompt-op",
						},
					},
				},
			];
			writeFileSync(sourcePath, JSON.stringify(legacy));
			const result = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});
			expect(result.status).toBe("committed");
			const operation = JSON.parse(readFileSync(sourcePath, "utf8")).mappings[0].journal[0];
			expect(operation.result.mapping.chatId).toBe(JSON.stringify(["admin-1", "chat-1"]));
			expect(operation.result.events[0].payload.keep).toEqual([1, 2, 3]);
		});
	});

	test("quarantines malformed source and fails closed without clearing it", () => {
		withRoot((root, sourcePath) => {
			const original = Buffer.from(JSON.stringify({ mappings: [{ chatId: "chat-1" }] }));
			writeFileSync(sourcePath, original);
			const result = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});
			expect(result.status).toBe("degraded");
			expect(result.counts.quarantined).toBe(1);
			expect(readFileSync(sourcePath)).toEqual(original);
			expect(readFileSync(result.quarantinePath!)).toEqual(original);
			expect(
				preflightSessionAuthorityMigration({ sourcePath, stateRoot: root, adminPrincipalId: "admin-1", now: NOW })
					.status,
			).toBe("degraded");
		});
	});
	test("degrades on a malformed manifest without changing legacy source bytes", () => {
		withRoot((root, sourcePath) => {
			const initial = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});
			mkdirSync(initial.migrationRecoveryPath, { recursive: true });
			const malformedManifest = Buffer.from('{"kind":"tampered"}\n');
			const auditPath = join(initial.migrationRecoveryPath, "audit.json");
			writeFileSync(auditPath, malformedManifest);
			const original = Buffer.from(JSON.stringify(legacyDocument()));
			writeFileSync(sourcePath, original);

			const result = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});

			expect(result.status).toBe("degraded");
			expect(result.checkpoint?.status).toBe("degraded");
			expect(readFileSync(sourcePath)).toEqual(original);
			expect(readFileSync(auditPath)).toEqual(malformedManifest);
			expect(readFileSync(result.quarantinePath!)).toEqual(original);
		});
	});

	test("degrades on a malformed manifest without changing current scoped v2 bytes", () => {
		withRoot((root, sourcePath) => {
			const initial = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});
			mkdirSync(initial.migrationRecoveryPath, { recursive: true });
			const malformedManifest = Buffer.from('{"kind":"tampered"}\n');
			const auditPath = join(initial.migrationRecoveryPath, "audit.json");
			writeFileSync(auditPath, malformedManifest);
			const original = Buffer.from(JSON.stringify(scopedV2Document()));
			writeFileSync(sourcePath, original);

			const result = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});

			expect(result.status).toBe("degraded");
			expect(result.checkpoint?.status).toBe("degraded");
			expect(readFileSync(sourcePath)).toEqual(original);
			expect(readFileSync(auditPath)).toEqual(malformedManifest);
			expect(readFileSync(result.quarantinePath!)).toEqual(original);
		});
	});
	test("accepts a scoped v2 document carrying the WAL base generation", () => {
		withRoot((root, sourcePath) => {
			const document = scopedV2Document();
			document.generation = "base-generation-uuid";
			writeFileSync(sourcePath, `${JSON.stringify(document)}\n`);

			const result = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});

			expect(result.status).toBe("not_needed");
		});
	});
	test("degrades a scoped v2 document with an invalid generation value during preflight", () => {
		withRoot((root, sourcePath) => {
			const document = scopedV2Document();
			document.generation = 42;
			writeFileSync(sourcePath, `${JSON.stringify(document)}\n`);

			const result = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});

			expect(result.status).toBe("degraded");
		});
	});
	test("relocates a v2 authority including its WAL-committed mutations", () => {
		withRoot((root, sourcePath) => {
			const source = new FileSessionAuthority(sourcePath);
			source.set({
				chatId: "chat-1",
				projectId: "project-1",
				sessionId: "session-1",
				rawFrameCursor: 0,
				eventCursor: 0,
				operationId: "user-1",
			});
			source.set({
				chatId: "chat-2",
				projectId: "project-1",
				sessionId: "session-2",
				rawFrameCursor: 0,
				eventCursor: 0,
				operationId: "user-2",
			});
			expect(existsSync(`${sourcePath}.wal`)).toBe(true);

			const destinationPath = join(root, "relocated", "authority.json");
			const result = preflightSessionAuthorityMigrationCandidates({
				candidateSourcePaths: [sourcePath],
				destinationPath,
				stateRoot: join(root, "state"),
				adminPrincipalId: "admin-1",
				now: NOW,
			});

			expect(result.status).toBe("committed");
			// The relocated document carries the WAL-committed chat-2 mutation.
			const relocated = readFileSync(destinationPath, "utf8");
			expect(relocated).toContain("chat-2");
			expect(new FileSessionAuthority(destinationPath).entries()).toHaveLength(2);
		});
	});
	test("preserves source evidence when the checkpoint path is unreadable", () => {
		withRoot((root, sourcePath) => {
			const sourceBytes = Buffer.from(JSON.stringify(legacyDocument()));
			const sourceIdentity = createHash("sha256").update(sourcePath).digest("hex").slice(0, 24);
			const recoveryPath = join(root, "session-authority-migration", `${basename(sourcePath)}-${sourceIdentity}`);
			writeFileSync(sourcePath, sourceBytes);
			mkdirSync(join(recoveryPath, "checkpoint.json"), { recursive: true });

			const result = preflightSessionAuthorityMigration({
				sourcePath,
				stateRoot: root,
				adminPrincipalId: "admin-1",
				now: NOW,
			});

			expect(result.status).toBe("degraded");
			expect(result.reason).toContain("cannot read checkpoint");
			expect(readFileSync(result.sourceRecoveryPath!)).toEqual(sourceBytes);
			expect(readFileSync(result.quarantinePath!)).toEqual(sourceBytes);
		});
	});
});
