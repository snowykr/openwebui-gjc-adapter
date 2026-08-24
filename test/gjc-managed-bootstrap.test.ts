import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type {
	ManagedAuthorityActivationJournal,
	ManagedAuthorityActivationStorage,
} from "../src/gjc/managed-authority-activation";
import { type ManagedBootstrapOptions, ManagedBootstrapService } from "../src/gjc/managed-bootstrap";
import {
	type LegacyManagedSessionAuthorityEvidence,
	MANAGED_SESSION_AUTHORITY_EPOCH,
	type ManagedSessionAuthorityRecord,
} from "../src/gjc/managed-session-authority";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const digests = {
	sourceDigest: hash("source"),
	backupDigest: hash("source"),
	walDigest: hash("wal"),
	targetManifestDigest: hash("manifest"),
};

function authority(): ManagedSessionAuthorityRecord {
	return {
		authorityEpoch: MANAGED_SESSION_AUTHORITY_EPOCH,
		principalId: "principal",
		projectId: "project",
		canonicalWorkspace: "/workspace/project",
		chatId: "chat",
		sessionId: "session",
		generation: 1,
		operationHash: hash("operation"),
		requestHash: hash("request"),
		payloadHash: hash("payload"),
		session: { sessionId: "session", observedAt: "2026-01-01T00:00:00.000Z" },
		projection: { rawFrameCursor: 0, eventCursor: 0 },
		lifecycle: { state: "active_generation_proven", recordedAt: "2026-01-01T00:00:00.000Z" },
	};
}

class FakeStorage implements ManagedAuthorityActivationStorage {
	journal: ManagedAuthorityActivationJournal | undefined;
	readonly calls: string[] = [];
	async load() {
		return this.journal;
	}
	async save(journal: ManagedAuthorityActivationJournal) {
		this.journal = journal;
		this.calls.push(`save:${journal.phase}`);
	}
	async backupSource() {
		this.calls.push("backup");
	}
	async fsyncBackup() {}
	async fsyncSource() {}
	async fsyncWal() {}
	async writeManifest() {}
	async fsyncManifest() {}
	async stageRecord() {
		this.calls.push("stage");
	}
	async fsyncStagedRecord() {}
	async fsyncCheckpoint() {}
	async replaceCanonical() {
		this.calls.push("replace");
	}
	async canonicalReplacementState() {
		return "replaced" as const;
	}
	async writeActiveMarker() {
		this.calls.push("marker");
	}
	async fsyncActiveMarker() {}
	async rollbackPreReplacement() {
		this.calls.push("rollback");
	}
}

class FakeRuntime {
	state: "new" | "running" | "stopped" = "new";
	starts = 0;
	disposes = 0;
	reconciles = 0;
	failStart = false;
	readonly registered: unknown[] = [];
	async start() {
		this.starts += 1;
		if (this.failStart) throw new Error("router start failed");
		this.state = "running";
	}
	registerTenant(key: unknown) {
		this.registered.push(key);
	}
	async reconcile() {
		this.reconciles += 1;
	}
	async acquireAttachment(tenant: { readonly generation: number }) {
		return { tenant, generation: tenant.generation, attachment: { isCurrent: () => true } };
	}
	async dispose() {
		this.disposes += 1;
		this.state = "stopped";
	}
}

function evidence(
	records: LegacyManagedSessionAuthorityEvidence["records"] = [
		{
			principalId: "principal",
			projectId: "project",
			canonicalWorkspace: "/workspace/project",
			chatId: "chat",
			sessionId: "session",
			status: "active_generation_proven",
		},
	],
): LegacyManagedSessionAuthorityEvidence {
	return { ...digests, records };
}

function fixture(
	options: { readonly blocked?: boolean; readonly failRuntime?: boolean; readonly storage?: FakeStorage } = {},
) {
	const storage = options.storage ?? new FakeStorage();
	const runtime = new FakeRuntime();
	runtime.failStart = options.failRuntime ?? false;
	let releases = 0;
	let bindCalls = 0;
	let resumes = 0;
	const service = new ManagedBootstrapService({
		agentDir: "/agent",
		stateRoot: "/state",
		sourcePath: "/state/authority.v2.json",
		legacyEvidence: async () => evidence(options.blocked ? [{ sessionId: "ambiguous" }] : undefined),
		bindings: async checkpoint => {
			bindCalls += 1;
			if (checkpoint.records.some(record => record.status === "migration_blocked")) return [];
			const record = authority();
			return [
				{
					record,
					tenant: {
						principalId: record.principalId,
						projectId: record.projectId,
						canonicalWorkspace: record.canonicalWorkspace,
						chatId: record.chatId,
						sessionId: record.sessionId,
						generation: record.generation,
						leaseId: "lease",
						epoch: "epoch",
					},
				},
			];
		},
		lifecycle: {
			resume: async () => {
				resumes += 1;
			},
		},
		tenantFence: async key => key.leaseId === "lease" && key.epoch === "epoch",
		acquireRuntimeLock: async () => ({
			release: async () => {
				releases += 1;
			},
		}),
		createRuntime: () => runtime as never,
		createRunner: () => ({}) as never,
		createStorage: () => storage,
		createOwner: () => ({ acquire: async () => ({ assertHeld: async () => {}, release: async () => {} }) }),
	} satisfies ManagedBootstrapOptions);
	return { service, storage, runtime, releases: () => releases, bindCalls: () => bindCalls, resumes: () => resumes };
}

describe("managed bootstrap", () => {
	test("activates a clean state, exposes exact active result, and admits managed dependencies only afterward", async () => {
		const active = fixture();
		expect(active.service.runnerDependencies).toBeUndefined();
		expect(active.service.readiness).toBe(false);
		const started = await active.service.start();
		expect(started.result).toEqual({
			phase: "active",
			ready: true,
			routerAvailable: true,
			epoch: MANAGED_SESSION_AUTHORITY_EPOCH,
		});
		expect(started.health).toEqual({
			phase: "active",
			ready: true,
			routerAvailable: true,
			epoch: MANAGED_SESSION_AUTHORITY_EPOCH,
		});
		expect(started.dependencies).toBe(active.service.runnerDependencies);
		expect(
			await started.dependencies?.tenantFence({
				principalId: "principal",
				projectId: "project",
				canonicalWorkspace: "/workspace/project",
				chatId: "chat",
				sessionId: "session",
				generation: 1,
				leaseId: "lease",
				epoch: "epoch",
			}),
		).toBe(true);
		expect(active.storage.calls).toEqual(expect.arrayContaining(["backup", "stage", "replace", "marker"]));
		expect(active.runtime.starts).toBe(1);
		expect(active.resumes()).toBe(1);
	});

	test("rebinds the staged v2 authority and restarts from the exact durable manifest", async () => {
		const storage = new FakeStorage();
		const first = fixture({ storage });
		await first.service.start();
		const second = fixture({ storage });
		const restarted = await second.service.start();
		expect(restarted.result.phase).toBe("active");
		expect(second.runtime.starts).toBe(1);
		expect(second.resumes()).toBe(1);
		expect(storage.journal?.manifest.digest).toBe(digests.targetManifestDigest);
		expect(storage.journal?.manifest.records).toEqual(storage.journal?.manifest.checkpoint.records);
	});

	test("blocks ambiguous legacy evidence without Router admission or managed dependencies", async () => {
		const blocked = fixture({ blocked: true });
		const result = await blocked.service.start();
		expect(result.result).toMatchObject({ phase: "blocked", ready: false, routerAvailable: false });
		expect(result.dependencies).toBeUndefined();
		expect(blocked.service.runnerDependencies).toBeUndefined();
		expect(blocked.runtime.starts).toBe(0);
		expect(blocked.resumes()).toBe(0);
		expect(blocked.releases()).toBe(1);
	});

	test("stops the Router and releases the runtime lock after runtime bootstrap failure", async () => {
		const failed = fixture({ failRuntime: true });
		const result = await failed.service.start();
		expect(result.result).toMatchObject({ phase: "failed", ready: false, reason: "router start failed" });
		expect(failed.runtime.disposes).toBe(1);
		expect(failed.releases()).toBe(1);
		expect(failed.service.health).toMatchObject({ phase: "failed", ready: false });
	});

	test("makes start and disposal idempotent and keeps user artifact capabilities out of bootstrap", async () => {
		const active = fixture();
		const [first, second] = await Promise.all([active.service.start(), active.service.start()]);
		expect(second).toBe(first);
		await Promise.all([active.service.dispose(), active.service.dispose()]);
		expect(active.runtime.disposes).toBe(1);
		expect(active.releases()).toBe(1);
		expect(active.service.readiness).toBe(false);
		expect(Object.keys(active.storage)).not.toContain("userArtifacts");
	});
});
