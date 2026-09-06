import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	ManagedAuthorityActivationCoordinator,
	type ManagedAuthorityActivationJournal,
	type ManagedAuthorityActivationOptions,
	type ManagedAuthorityPreparedRebindIntent,
	managedAuthorityManifestDigest,
} from "../src/gjc/managed-authority-activation";
import type { ManagedSdkAttachment, TenantSessionKey } from "../src/gjc/managed-sdk-runtime";
import { MANAGED_SESSION_AUTHORITY_EPOCH } from "../src/gjc/managed-session-authority";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const intent = (): ManagedAuthorityPreparedRebindIntent => ({
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
	rawFrameCursor: 1,
	eventCursor: 2,
});

function fixture(
	options: {
		fail?: string;
		releaseFails?: boolean;
		status?: "intent_prepared" | "quarantined" | "retired";
		replacement?: "replaced" | "not_replaced" | "uncertain";
	} = {},
) {
	const calls: string[] = [];
	const tenants = new Map<string, TenantSessionKey>();
	const attachments = new Map<string, ManagedSdkAttachment>();
	let running = false;
	let journal: ManagedAuthorityActivationJournal | undefined;
	const checkpoint = {
		authorityEpoch: MANAGED_SESSION_AUTHORITY_EPOCH,
		digests: {
			sourceDigest: hash("source"),
			backupDigest: hash("backup"),
			walDigest: hash("wal"),
			targetManifestDigest: hash("manifest"),
		},
		records: [{ identity: "tenant", status: options.status ?? "intent_prepared" }],
		canonicalReplaced: false,
		activeMarkerReady: false,
	} as const;
	const manifestInput = { authorityEpoch: MANAGED_SESSION_AUTHORITY_EPOCH, checkpoint, records: checkpoint.records };
	const manifest = { ...manifestInput, digest: managedAuthorityManifestDigest(manifestInput) };
	const effect = async (name: string) => {
		calls.push(name);
		if (options.fail === name) throw new Error(name);
	};
	const activation: ManagedAuthorityActivationOptions = {
		manifest,
		bindings: options.status === "intent_prepared" || options.status === undefined ? [{ intent: intent() }] : [],
		owner: {
			acquire: async () => ({
				assertHeld: async () => await effect("lock"),
				release: async () => {
					calls.push("release");
					if (options.releaseFails) throw new Error("release");
				},
			}),
		},
		storage: {
			load: async () => journal,
			save: async value => {
				await effect(`save:${value.phase}`);
				calls.push(`item:${value.items[0]?.state ?? "none"}`);
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
			state: "new",
			start: async () => {
				await effect("router");
				running = true;
			},
			reconcile: async () => await effect("reconcile"),
			registerTenant: (key: TenantSessionKey) => {
				calls.push(`register:${key.generation}`);
				const prior = tenants.get(`${key.sessionId}:${key.generation}`);
				if (prior !== undefined && tenantIdentity(prior) !== tenantIdentity(key))
					attachments.delete(tenantIdentity(prior));
				tenants.set(`${key.sessionId}:${key.generation}`, Object.freeze({ ...key }));
			},
			acquireAttachment: async (key: TenantSessionKey) => {
				const identity = tenantIdentity(key);
				const tenant = Object.freeze({ ...key });
				const current = () =>
					running && tenantIdentity(tenants.get(`${tenant.sessionId}:${tenant.generation}`)) === identity;
				if (!current()) throw new Error("Activation fixture tenant is not current.");
				let token = attachments.get(identity);
				if (token === undefined) {
					const issued: ManagedSdkAttachment = Object.freeze({
						tenant,
						generation: tenant.generation,
						isCurrent: () => attachments.get(identity) === issued && current(),
					});
					token = issued;
					attachments.set(identity, token);
				}
				return token;
			},
		} as never,
		lifecycle: {
			resume: async value => {
				await effect("resume");
				return {
					ok: true,
					sessionId: value.sessionId,
					endpointGeneration: 7,
					acknowledgedAt: "2026-01-01T00:00:01.000Z",
				};
			},
			recover: async value => {
				await effect("recover");
				return {
					ok: true,
					sessionId: value.sessionId,
					endpointGeneration: 7,
					acknowledgedAt: "2026-01-01T00:00:01.000Z",
				};
			},
		},
		admission: { open: async () => await effect("admission"), close: async () => await effect("close") },
		preparedIntentFence: async value => {
			calls.push(`prepared-fence:${value.sessionId}`);
			return true;
		},
		tenantFence: async key => {
			calls.push(`fence:${key.generation}`);
			return key.leaseId === "lease" && key.epoch === "epoch" && key.generation === 7;
		},
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
	test("creates a generation-free prepared intent, journals every proof state, and constructs the exact returned generation", async () => {
		const active = fixture();
		const result = await new ManagedAuthorityActivationCoordinator(active.activation).activate();
		expect(result).toMatchObject({ phase: "active", ready: true, routerAvailable: true });
		expect(active.journal()?.items).toEqual([
			expect.objectContaining({
				state: "active_generation_proven",
				record: expect.objectContaining({
					generation: 7,
					lifecycle: { state: "active_generation_proven", recordedAt: "2026-01-01T00:00:01.000Z" },
				}),
			}),
		]);
		expect(active.calls).toEqual(
			expect.arrayContaining([
				"item:intent_prepared",
				"item:invoking",
				"item:acknowledged_unproven",
				"item:active_generation_proven",
			]),
		);
		expect(active.calls).toEqual(
			expect.arrayContaining([
				"save:preparing",
				"save:router_bootstrap",
				"save:rebinding",
				"register:7",
				"fence:7",
				"stage",
				"replace",
				"marker",
				"admission",
			]),
		);
		expect(active.calls.indexOf("admission")).toBeGreaterThan(active.calls.indexOf("marker"));
	});

	test("re-checks the tenant fence at each Router boundary and keeps public admission separate", async () => {
		const active = fixture();
		const result = await new ManagedAuthorityActivationCoordinator(active.activation).activate();
		expect(result).toMatchObject({ phase: "active", ready: true, routerAvailable: true });
		expect(active.calls.filter(call => call === "fence:7").length).toBeGreaterThanOrEqual(5);
		expect(active.calls.indexOf("admission")).toBeGreaterThan(active.calls.lastIndexOf("fence:7"));
	});

	test("recovers a durable active item, fails closed for uncertain replacement and lock-release failure", async () => {
		const durable = fixture();
		await new ManagedAuthorityActivationCoordinator(durable.activation).activate();
		const replay = await new ManagedAuthorityActivationCoordinator(durable.activation).activate();
		expect(replay).toMatchObject({ phase: "active", ready: true });
		const uncertain = fixture({ replacement: "uncertain" });
		uncertain.setJournal({
			manifest: uncertain.activation.manifest,
			phase: "committing",
			staged: [],
			items: [{ intent: intent(), state: "intent_prepared" }],
			canonicalReplaced: false,
			activeMarker: false,
		});
		await expect(new ManagedAuthorityActivationCoordinator(uncertain.activation).activate()).resolves.toMatchObject({
			phase: "blocked",
			ready: false,
		});
		const release = fixture({ releaseFails: true });
		await expect(new ManagedAuthorityActivationCoordinator(release.activation).activate()).resolves.toMatchObject({
			phase: "blocked",
			ready: false,
			reason: expect.stringContaining("lock release failed"),
		});
	});

	test("blocks quarantined and unproven retired migration evidence", async () => {
		await expect(
			new ManagedAuthorityActivationCoordinator(fixture({ status: "quarantined" }).activation).activate(),
		).resolves.toMatchObject({ phase: "blocked", ready: false });
		const retired = fixture({ status: "retired" });
		await expect(new ManagedAuthorityActivationCoordinator(retired.activation).activate()).resolves.toMatchObject({
			phase: "blocked",
			ready: false,
		});
		expect(retired.calls).not.toContain("resume");
	});
	test("keeps activation fixture tokens stable and invalidates replaced lease authority", async () => {
		const active = fixture();
		await new ManagedAuthorityActivationCoordinator(active.activation).activate();
		const prepared = intent();
		const key: TenantSessionKey = {
			principalId: prepared.principalId,
			projectId: prepared.projectId,
			canonicalWorkspace: prepared.canonicalWorkspace,
			chatId: prepared.chatId,
			sessionId: prepared.sessionId,
			generation: 7,
			leaseId: prepared.leaseId,
			epoch: prepared.epoch,
		};
		const token = await active.activation.runtime.acquireAttachment(key);
		expect(await active.activation.runtime.acquireAttachment({ ...key })).toBe(token);
		expect(token).not.toHaveProperty("attachment");
		expect(token).not.toHaveProperty("send");
		active.activation.runtime.registerTenant({ ...key, leaseId: "changed" });
		expect(token.isCurrent()).toBe(false);
		await expect(active.activation.runtime.acquireAttachment(key)).rejects.toThrow("not current");
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
