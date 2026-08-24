import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
	ManagedAuthorityActivationJournal,
	ManagedAuthorityActivationManifest,
	ManagedAuthorityPreparedRebindIntent,
} from "../src/gjc/managed-authority-activation";
import { managedAuthorityManifestDigest } from "../src/gjc/managed-authority-activation";
import { ManagedAuthorityFileOwner, ManagedAuthorityFileStorage } from "../src/gjc/managed-authority-file-storage";
import {
	MANAGED_SESSION_AUTHORITY_EPOCH,
	type ManagedSessionAuthorityRecord,
	managedSessionAuthorityHash,
} from "../src/gjc/managed-session-authority";

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function preparedIntent(): ManagedAuthorityPreparedRebindIntent {
	return {
		principalId: "principal",
		projectId: "project",
		canonicalWorkspace: "/workspace/project",
		chatId: "chat",
		sessionId: "session",
		actorDigest: sha256("actor"),
		actorRef: "actor",
		stableKey: "stable-key",
		operationHash: sha256("record"),
		requestHash: sha256("record"),
		payloadHash: sha256("record"),
		leaseId: "lease",
		epoch: "epoch",
		preparedAt: "2026-01-01T00:00:00.000Z",
		observedAt: "2026-01-01T00:00:00.000Z",
		rawFrameCursor: 0,
		eventCursor: 0,
	};
}

async function fixture() {
	const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-authority-storage-"));
	const sourcePath = path.join(stateRoot, "sessions", "authority.json");
	const source = Buffer.from('{"kind":"openwebui-gjc-session-authority","version":2,"records":[]}\n');
	const wal = Buffer.from("v2 wal exact bytes\n");
	await fs.mkdir(path.dirname(sourcePath), { recursive: true });
	await fs.writeFile(sourcePath, source);
	await fs.writeFile(`${sourcePath}.wal`, wal);
	const storage = new ManagedAuthorityFileStorage({ stateRoot, sourcePath });
	const owner = new ManagedAuthorityFileOwner({ stateRoot, sourcePath });
	const record = authorityRecord();
	const manifestInput = {
		authorityEpoch: MANAGED_SESSION_AUTHORITY_EPOCH,
		checkpoint: {
			authorityEpoch: MANAGED_SESSION_AUTHORITY_EPOCH,
			digests: {
				sourceDigest: sha256(source),
				backupDigest: sha256(source),
				walDigest: sha256(wal),
				targetManifestDigest: sha256("manifest"),
			},
			records: [{ identity: "record", status: "active_generation_proven" }],
			canonicalReplaced: false,
			activeMarkerReady: false,
		},
		records: [{ identity: "record", status: "intent_prepared" }],
	} as const;
	const manifest: ManagedAuthorityActivationManifest = {
		...manifestInput,
		digest: managedAuthorityManifestDigest(manifestInput),
	};
	const journal = (
		phase: ManagedAuthorityActivationJournal["phase"],
		canonicalReplaced = false,
	): ManagedAuthorityActivationJournal => ({
		manifest,
		phase,
		staged: [managedSessionAuthorityHash(record)],
		items: [{ intent: preparedIntent(), state: "active_generation_proven", record }],
		canonicalReplaced,
		activeMarker: false,
	});
	return { stateRoot, sourcePath, source, wal, storage, owner, record, manifest, journal };
}

function authorityRecord(): ManagedSessionAuthorityRecord {
	const hash = sha256("record");
	return {
		authorityEpoch: MANAGED_SESSION_AUTHORITY_EPOCH,
		principalId: "principal",
		projectId: "project",
		canonicalWorkspace: "/workspace/project",
		chatId: "chat",
		sessionId: "session",
		generation: 1,
		operationHash: hash,
		requestHash: hash,
		payloadHash: hash,
		session: { sessionId: "session", observedAt: "2026-01-01T00:00:00.000Z" },
		projection: { rawFrameCursor: 0, eventCursor: 0 },
		lifecycle: { state: "active_generation_proven", recordedAt: "2026-01-01T00:00:00.000Z" },
	};
}

async function prepare(f: Awaited<ReturnType<typeof fixture>>) {
	await f.storage.save(f.journal("preparing"));
	await f.storage.backupSource();
	await f.storage.fsyncBackup();
	await f.storage.fsyncSource();
	await f.storage.fsyncWal();
	await f.storage.writeManifest(f.manifest);
	await f.storage.fsyncManifest();
	await f.storage.stageRecord(f.record);
	await f.storage.fsyncStagedRecord(managedSessionAuthorityHash(f.record));
}

describe("managed authority file storage", () => {
	test("backs up exact v2/WAL bytes, stages v3 state, atomically replaces canonical state, and marks active", async () => {
		const f = await fixture();
		try {
			await prepare(f);
			const activationRoot = path.join(
				f.stateRoot,
				"managed-authority-activation",
				sha256(f.sourcePath).slice(0, 32),
			);
			expect(await fs.readFile(path.join(activationRoot, "source.v2.json"))).toEqual(f.source);
			expect(await fs.readFile(path.join(activationRoot, "source.v2.wal"))).toEqual(f.wal);
			await f.storage.save(f.journal("committing"));
			await f.storage.fsyncCheckpoint();
			await f.storage.replaceCanonical();
			expect(await f.storage.canonicalReplacementState()).toBe("replaced");
			expect(JSON.parse(await fs.readFile(f.sourcePath, "utf8"))).toEqual({
				kind: "openwebui-gjc-session-authority",
				version: 3,
				authorityEpoch: MANAGED_SESSION_AUTHORITY_EPOCH,
				digest: f.manifest.digest,
				records: [f.record],
			});
			await f.storage.save(f.journal("committing", true));
			await f.storage.writeActiveMarker(MANAGED_SESSION_AUTHORITY_EPOCH, f.manifest.digest);
			await f.storage.fsyncActiveMarker();
			expect(JSON.parse(await fs.readFile(path.join(activationRoot, "active.v3.json"), "utf8"))).toEqual({
				authorityEpoch: MANAGED_SESSION_AUTHORITY_EPOCH,
				manifestDigest: f.manifest.digest,
			});
		} finally {
			await fs.rm(f.stateRoot, { recursive: true, force: true });
		}
	});

	test("restart recovery distinguishes every pre-replacement boundary from a completed replacement", async () => {
		const f = await fixture();
		try {
			for (const boundary of ["journal", "backup", "manifest", "stage", "checkpoint"]) {
				await f.storage.rollbackPreReplacement();
				if (boundary !== "journal") await f.storage.save(f.journal("preparing"));
				if (boundary !== "backup") await f.storage.backupSource();
				if (boundary !== "manifest") await f.storage.writeManifest(f.manifest);
				if (boundary !== "stage") await f.storage.stageRecord(f.record);
				if (boundary !== "checkpoint") await f.storage.save(f.journal("committing"));
				const restarted = new ManagedAuthorityFileStorage({ stateRoot: f.stateRoot, sourcePath: f.sourcePath });
				expect(await restarted.canonicalReplacementState()).toBe("not_replaced");
				await restarted.rollbackPreReplacement();
			}
			await prepare(f);
			await f.storage.save(f.journal("committing"));
			await f.storage.replaceCanonical();
			const restarted = new ManagedAuthorityFileStorage({ stateRoot: f.stateRoot, sourcePath: f.sourcePath });
			expect(await restarted.canonicalReplacementState()).toBe("replaced");
		} finally {
			await fs.rm(f.stateRoot, { recursive: true, force: true });
		}
	});

	test("fails closed on source replacement, digest mismatch, symlinks, and non-regular state entries", async () => {
		const f = await fixture();
		try {
			await f.storage.save(f.journal("preparing"));
			await fs.writeFile(f.sourcePath, '{"kind":"openwebui-gjc-session-authority","version":2}\n');
			await expect(f.storage.backupSource()).rejects.toThrow("digest");
			await fs.unlink(f.sourcePath);
			await fs.symlink("/dev/null", f.sourcePath);
			await expect(f.storage.backupSource()).rejects.toThrow();
			await fs.unlink(f.sourcePath);
			await fs.mkdir(f.sourcePath);
			await expect(f.storage.fsyncSource()).rejects.toThrow("regular file");
		} finally {
			await fs.rm(f.stateRoot, { recursive: true, force: true });
		}
	});

	test("detects lock loss at the exact authority mutation lock seam", async () => {
		const f = await fixture();
		try {
			const lock = await f.owner.acquire();
			await lock.assertHeld();
			await fs.rename(`${f.sourcePath}.lock`, `${f.sourcePath}.lock.replaced`);
			await fs.writeFile(`${f.sourcePath}.lock`, "replacement\n");
			await expect(lock.assertHeld()).rejects.toThrow("lost");
			await expect(lock.release()).rejects.toThrow();
		} finally {
			await fs.rm(f.stateRoot, { recursive: true, force: true });
		}
	});

	test("rollback only removes adapter-owned staged/canonical activation files and leaves protected paths untouched", async () => {
		const f = await fixture();
		try {
			const transcript = path.join(f.stateRoot, "transcripts", "session.jsonl");
			const artifact = path.join(f.stateRoot, "artifacts", "user-output.txt");
			await fs.mkdir(path.dirname(transcript), { recursive: true });
			await fs.mkdir(path.dirname(artifact), { recursive: true });
			await fs.writeFile(transcript, "private transcript");
			await fs.writeFile(artifact, "user artifact");
			await prepare(f);
			await f.storage.save(f.journal("committing"));
			await f.storage.replaceCanonical();
			await f.storage.rollbackPreReplacement();
			expect(await fs.readFile(transcript, "utf8")).toBe("private transcript");
			expect(await fs.readFile(artifact, "utf8")).toBe("user artifact");
			expect(await f.storage.canonicalReplacementState()).toBe("not_replaced");
		} finally {
			await fs.rm(f.stateRoot, { recursive: true, force: true });
		}
	});
});
