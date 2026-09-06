import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type {
	ManagedAuthorityActivationJournal,
	ManagedAuthorityPreparedRebindIntent,
} from "../src/gjc/managed-authority-activation";
import { type ManagedBootstrapOptions, ManagedBootstrapService } from "../src/gjc/managed-bootstrap";
import type { ManagedSdkAttachment, TenantSessionKey } from "../src/gjc/managed-sdk-runtime";
import {
	type LegacyManagedSessionAuthorityEvidence,
	MANAGED_SESSION_AUTHORITY_EPOCH,
} from "../src/gjc/managed-session-authority";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const digests = {
	sourceDigest: hash("source"),
	backupDigest: hash("source"),
	walDigest: hash("wal"),
	targetManifestDigest: hash("manifest"),
};
const preparedIntent = (): ManagedAuthorityPreparedRebindIntent => ({
	principalId: "principal",
	projectId: "project",
	canonicalWorkspace: "/workspace/project",
	chatId: "chat",
	sessionId: "session",
	actorDigest: hash("actor"),
	actorRef: "actor",
	stableKey: "stable-key",
	operationHash: hash("operation"),
	requestHash: hash("request"),
	payloadHash: hash("payload"),
	leaseId: "lease",
	epoch: "epoch",
	preparedAt: "2026-01-01T00:00:00.000Z",
	observedAt: "2026-01-01T00:00:00.000Z",
	rawFrameCursor: 0,
	eventCursor: 0,
});

class FakeStorage {
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
	readonly #tenants = new Map<string, TenantSessionKey>();
	readonly #attachments = new Map<string, ManagedSdkAttachment>();
	async start() {
		this.starts += 1;
		if (this.failStart) throw new Error("router start failed");
		this.state = "running";
	}
	registerTenant(key: TenantSessionKey) {
		this.registered.push(key);
		const prior = this.#tenants.get(`${key.sessionId}:${key.generation}`);
		if (prior !== undefined && tenantIdentity(prior) !== tenantIdentity(key))
			this.#attachments.delete(tenantIdentity(prior));
		this.#tenants.set(`${key.sessionId}:${key.generation}`, Object.freeze({ ...key }));
	}
	async reconcile() {
		this.reconciles += 1;
	}
	async acquireAttachment(key: TenantSessionKey): Promise<ManagedSdkAttachment> {
		const identity = tenantIdentity(key);
		const tenant = Object.freeze({ ...key });
		const current = () =>
			this.state === "running" &&
			tenantIdentity(this.#tenants.get(`${tenant.sessionId}:${tenant.generation}`)) === identity;
		if (!current()) throw new Error("Bootstrap fixture tenant is not current.");
		let token = this.#attachments.get(identity);
		if (token === undefined) {
			const issued: ManagedSdkAttachment = Object.freeze({
				tenant,
				generation: tenant.generation,
				isCurrent: () => this.#attachments.get(identity) === issued && current(),
			});
			token = issued;
			this.#attachments.set(identity, token);
		}
		return token;
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
	options: {
		readonly blocked?: boolean;
		readonly failRuntime?: boolean;
		readonly releaseFails?: boolean;
		readonly storage?: FakeStorage;
	} = {},
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
			return checkpoint.records.some(record => record.status !== "intent_prepared")
				? []
				: [{ intent: preparedIntent() }];
		},
		lifecycle: {
			resume: async intent => {
				resumes += 1;
				return {
					ok: true,
					sessionId: intent.sessionId,
					endpointGeneration: 5,
					acknowledgedAt: "2026-01-01T00:00:01.000Z",
				};
			},
			recover: async intent => ({
				ok: true,
				sessionId: intent.sessionId,
				endpointGeneration: 5,
				acknowledgedAt: "2026-01-01T00:00:01.000Z",
			}),
		},
		preparedIntentFence: async intent => intent.leaseId === "lease" && intent.epoch === "epoch",
		tenantFence: async key => key.leaseId === "lease" && key.epoch === "epoch" && key.generation === 5,
		acquireRuntimeLock: async () => ({
			release: async () => {
				releases += 1;
				if (options.releaseFails) throw new Error("release failed");
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
	test("activates only after generation-free binding resumes to an exact positive generation", async () => {
		const active = fixture();
		expect(active.service.runnerDependencies).toBeUndefined();
		const started = await active.service.start();
		expect(started.result).toEqual({
			phase: "active",
			ready: true,
			routerAvailable: true,
			epoch: MANAGED_SESSION_AUTHORITY_EPOCH,
		});
		expect(started.dependencies).toBe(active.service.runnerDependencies);
		expect(active.storage.journal?.items).toEqual([
			expect.objectContaining({
				state: "active_generation_proven",
				record: expect.objectContaining({ generation: 5 }),
			}),
		]);
		expect(active.runtime.registered).toEqual(
			expect.arrayContaining([expect.objectContaining({ generation: 5, leaseId: "lease", epoch: "epoch" })]),
		);
		expect(active.resumes()).toBe(1);
	});
	test("keeps public admission separate from the external tenant fence", async () => {
		const active = fixture();
		const started = await active.service.start();
		expect(
			await started.dependencies?.tenantFence({
				principalId: "principal",
				projectId: "project",
				canonicalWorkspace: "/workspace/project",
				chatId: "chat",
				sessionId: "session",
				generation: 5,
				leaseId: "lease",
				epoch: "epoch",
			}),
		).toBe(true);
		await active.service.dispose();
		expect(
			await started.dependencies?.tenantFence({
				principalId: "principal",
				projectId: "project",
				canonicalWorkspace: "/workspace/project",
				chatId: "chat",
				sessionId: "session",
				generation: 5,
				leaseId: "lease",
				epoch: "epoch",
			}),
		).toBe(false);
	});
	test("replays durable active items on restart without resuming a generation", async () => {
		const storage = new FakeStorage();
		await fixture({ storage }).service.start();
		const restarted = fixture({ storage });
		expect((await restarted.service.start()).result.phase).toBe("active");
		expect(restarted.resumes()).toBe(0);
		expect(restarted.runtime.registered).toEqual([expect.objectContaining({ generation: 5 })]);
	});
	test("blocks ambiguous evidence and releases the runtime lock after bootstrap or cleanup failure", async () => {
		const blocked = fixture({ blocked: true });
		expect((await blocked.service.start()).result).toMatchObject({ phase: "blocked", ready: false });
		expect(blocked.resumes()).toBe(0);
		expect(blocked.releases()).toBe(1);
		const failed = fixture({ failRuntime: true });
		expect((await failed.service.start()).result).toMatchObject({
			phase: "failed",
			ready: false,
			reason: "router start failed",
		});
		expect(failed.runtime.disposes).toBe(1);
		expect(failed.releases()).toBe(1);
		const release = fixture({ releaseFails: true });
		await release.service.start();
		await expect(release.service.dispose()).rejects.toThrow("Managed bootstrap cleanup failed");
		expect(release.service.health).toMatchObject({
			phase: "failed",
			ready: false,
			reason: "Managed bootstrap cleanup failed.",
		});
	});
	test("keeps start and disposal idempotent and user artifact capabilities absent", async () => {
		const active = fixture();
		const [first, second] = await Promise.all([active.service.start(), active.service.start()]);
		expect(second).toBe(first);
		await Promise.all([active.service.dispose(), active.service.dispose()]);
		expect(active.runtime.disposes).toBe(1);
		expect(active.releases()).toBe(1);
		expect(Object.keys(active.storage)).not.toContain("userArtifacts");
	});
	test("keeps bootstrap fixture tokens stable and invalidates changed leases and disposed sessions", async () => {
		const active = fixture();
		await active.service.start();
		const tenant = active.runtime.registered[0] as TenantSessionKey;
		const token = await active.runtime.acquireAttachment(tenant);
		expect(await active.runtime.acquireAttachment({ ...tenant })).toBe(token);
		expect(token).not.toHaveProperty("attachment");
		expect(token).not.toHaveProperty("send");
		active.runtime.registerTenant({ ...tenant, leaseId: "changed" });
		expect(token.isCurrent()).toBe(false);
		await expect(active.runtime.acquireAttachment(tenant)).rejects.toThrow("not current");
		const replacement = await active.runtime.acquireAttachment({ ...tenant, leaseId: "changed" });
		await active.service.dispose();
		expect(replacement.isCurrent()).toBe(false);
	});
});

function tenantIdentity(key: TenantSessionKey | undefined): string {
	return JSON.stringify(
		key === undefined
			? null
			: [
					key.principalId,
					key.projectId,
					key.canonicalWorkspace,
					key.chatId,
					key.sessionId,
					key.generation,
					key.leaseId,
					key.epoch,
				],
	);
}
