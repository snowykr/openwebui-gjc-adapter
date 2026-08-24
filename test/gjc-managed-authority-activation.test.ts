import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	ManagedAuthorityActivationCoordinator,
	type ManagedAuthorityActivationJournal,
	type ManagedAuthorityActivationManifest,
	type ManagedAuthorityActivationOptions,
} from "../src/gjc/managed-authority-activation";
import {
	MANAGED_SESSION_AUTHORITY_EPOCH,
	type ManagedSessionAuthorityRecord,
} from "../src/gjc/managed-session-authority";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const digest = hash("migration");

function record(): ManagedSessionAuthorityRecord {
	return {
		authorityEpoch: MANAGED_SESSION_AUTHORITY_EPOCH,
		principalId: "principal",
		projectId: "project",
		canonicalWorkspace: "/workspace/project",
		chatId: "chat",
		sessionId: "session",
		generation: 3,
		operationHash: hash("operation"),
		requestHash: hash("request"),
		payloadHash: hash("payload"),
		session: { sessionId: "session", observedAt: "2026-01-01T00:00:00.000Z" },
		projection: { rawFrameCursor: 1, eventCursor: 2 },
		lifecycle: { state: "active_generation_proven", recordedAt: "2026-01-01T00:00:00.000Z" },
	};
}

function fixture(
	options: { fail?: string; blocked?: boolean; replacement?: "replaced" | "not_replaced" | "uncertain" } = {},
) {
	const calls: string[] = [];
	let journal: ManagedAuthorityActivationJournal | undefined;
	const current = { isCurrent: () => true };
	const authority = record();
	const tenant = {
		principalId: authority.principalId,
		projectId: authority.projectId,
		canonicalWorkspace: authority.canonicalWorkspace,
		chatId: authority.chatId,
		sessionId: authority.sessionId,
		generation: authority.generation,
		leaseId: "lease",
		epoch: "epoch",
	};
	const manifest: ManagedAuthorityActivationManifest = {
		authorityEpoch: MANAGED_SESSION_AUTHORITY_EPOCH,
		digest,
		checkpoint: {
			authorityEpoch: MANAGED_SESSION_AUTHORITY_EPOCH,
			digests: {
				sourceDigest: hash("source"),
				backupDigest: hash("backup"),
				walDigest: hash("wal"),
				targetManifestDigest: digest,
			},
			records: [{ identity: "tenant", status: options.blocked ? "migration_blocked" : "active_generation_proven" }],
			canonicalReplaced: false,
			activeMarkerReady: false,
		},
		records: [{ identity: "tenant", status: options.blocked ? "migration_blocked" : "active_generation_proven" }],
	};
	const effect = async (name: string) => {
		calls.push(name);
		if (options.fail === name) throw new Error(name);
	};
	const activation: ManagedAuthorityActivationOptions = {
		manifest,
		bindings: options.blocked ? [] : [{ record: authority, tenant }],
		owner: {
			acquire: async () => ({
				assertHeld: async () => await effect("lock"),
				release: async () => {
					calls.push("release");
				},
			}),
		},
		storage: {
			load: async () => journal,
			save: async value => {
				await effect(`save:${value.phase}`);
				journal = value;
			},
			backupSource: async () => await effect("backup"),
			fsyncBackup: async () => await effect("fsync-backup"),
			fsyncSource: async () => await effect("fsync-source"),
			fsyncWal: async () => await effect("fsync-wal"),
			writeManifest: async () => await effect("manifest"),
			fsyncManifest: async () => await effect("fsync-manifest"),
			stageRecord: async () => await effect("stage"),
			fsyncStagedRecord: async () => await effect("fsync-stage"),
			fsyncCheckpoint: async () => await effect("fsync-checkpoint"),
			replaceCanonical: async () => await effect("replace"),
			canonicalReplacementState: async () => options.replacement ?? "not_replaced",
			writeActiveMarker: async () => await effect("marker"),
			fsyncActiveMarker: async () => await effect("fsync-marker"),
			rollbackPreReplacement: async () => await effect("rollback"),
		},
		runtime: {
			start: async () => await effect("router"),
			reconcile: async () => await effect("reconcile"),
			registerTenant: () => calls.push("register"),
			acquireAttachment: async () => ({ tenant, generation: 3, attachment: current }),
		} as never,
		lifecycle: { resume: async () => await effect("resume") },
		admission: { open: async () => await effect("admission") },
	};
	return {
		calls,
		activation,
		journal: () => journal,
		setJournal: (value: ManagedAuthorityActivationJournal) => {
			journal = value;
		},
	};
}

describe("managed authority activation", () => {
	test("performs the approved durable order and opens admission only after the marker", async () => {
		const active = fixture();
		const result = await new ManagedAuthorityActivationCoordinator(active.activation).activate();
		expect(result).toMatchObject({ phase: "active", ready: true, routerAvailable: true });
		const milestones = active.calls.filter(
			call => !call.startsWith("lock") && !call.startsWith("save:") && call !== "release",
		);
		expect(milestones).toEqual([
			"backup",
			"fsync-backup",
			"fsync-source",
			"fsync-wal",
			"manifest",
			"fsync-manifest",
			"router",
			"resume",
			"register",
			"reconcile",
			"stage",
			"fsync-stage",
			"fsync-checkpoint",
			"replace",
			"marker",
			"fsync-marker",
			"admission",
		]);
	});

	test("makes Router bootstrap observable while readiness remains closed on a later failure", async () => {
		const active = fixture({ fail: "resume" });
		const result = await new ManagedAuthorityActivationCoordinator(active.activation).activate();
		expect(result).toMatchObject({ phase: "failed", ready: false, routerAvailable: true });
		expect(active.calls).toContain("router");
		expect(active.calls).not.toContain("admission");
	});

	test("rolls back all pre-replacement crash boundaries and is restart-idempotent", async () => {
		for (const boundary of [
			"backup",
			"fsync-backup",
			"fsync-source",
			"fsync-wal",
			"manifest",
			"fsync-manifest",
			"router",
			"resume",
			"reconcile",
			"stage",
			"fsync-stage",
			"fsync-checkpoint",
		]) {
			const interrupted = fixture({ fail: boundary });
			await new ManagedAuthorityActivationCoordinator(interrupted.activation).activate();
			const restart = await new ManagedAuthorityActivationCoordinator(interrupted.activation).activate();
			expect(restart.ready).toBe(false);
			expect(interrupted.calls).toContain("rollback");
		}
	});

	test("blocks migration-blocked authority and forward-recovers a committing replacement", async () => {
		const blocked = fixture({ blocked: true });
		await expect(new ManagedAuthorityActivationCoordinator(blocked.activation).activate()).resolves.toMatchObject({
			phase: "blocked",
			ready: false,
		});
		const committing = fixture({ replacement: "replaced" });
		committing.setJournal({
			manifest: committing.activation.manifest,
			phase: "committing",
			staged: [],
			canonicalReplaced: false,
			activeMarker: false,
		});
		const initial = await new ManagedAuthorityActivationCoordinator(committing.activation).activate();
		expect(initial.phase).toBe("active");
		const replay = await new ManagedAuthorityActivationCoordinator(committing.activation).activate();
		expect(replay).toMatchObject({ phase: "active", ready: true });
	});

	test("fails closed for digest mismatch, lock loss, uncertain replacement, and never calls user-file capabilities", async () => {
		const mismatch = fixture();
		await new ManagedAuthorityActivationCoordinator(mismatch.activation).activate();
		const altered = {
			...mismatch.activation,
			manifest: { ...mismatch.activation.manifest, digest: hash("different") },
		};
		await expect(new ManagedAuthorityActivationCoordinator(altered).activate()).resolves.toMatchObject({
			phase: "failed",
			ready: false,
		});
		const uncertain = fixture({ replacement: "uncertain" });
		uncertain.setJournal({
			manifest: uncertain.activation.manifest,
			phase: "committing",
			staged: [],
			canonicalReplaced: false,
			activeMarker: false,
		});
		await expect(new ManagedAuthorityActivationCoordinator(uncertain.activation).activate()).resolves.toMatchObject({
			phase: "blocked",
			ready: false,
		});
		const lost = fixture({ fail: "lock" });
		await expect(new ManagedAuthorityActivationCoordinator(lost.activation).activate()).resolves.toMatchObject({
			phase: "failed",
			ready: false,
		});
		expect(Object.keys(uncertain.activation.storage)).not.toContain("userFiles");
	});
});
