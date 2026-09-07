import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { lifecycle, router } from "@gajae-code/coding-agent/sdk";
import {
	type ManagedBootstrapAdmission,
	type ManagedBootstrapCandidate,
	startAdapterSessionAuthorityV3Activation,
} from "../src/adapter-managed-bootstrap";
import { ManagedBootstrapAdmissionOwner } from "../src/adapter-managed-bootstrap-admission";
import { createManagedLifecycleEvidence } from "../src/gjc/managed-lifecycle-evidence";
import { ManagedSdkRuntime } from "../src/gjc/managed-sdk-runtime";
import { parseSessionAuthorityV3Document, SESSION_AUTHORITY_V3_EPOCH } from "../src/gjc/session-authority-v3";
import { SqliteProjectRegistrationStore } from "../src/projects/registration-store";
import { RuntimeSingletonLock } from "../src/runtime-singleton-lock";
import { UserWorkspaceRegistry } from "../src/security/user-workspace";
import {
	parseWorkspaceLeaseId,
	type WorkspaceLease,
	type WorkspaceLeaseAcquireOptions,
	WorkspaceLeaseManager,
	workspaceLeaseId,
} from "../src/security/workspace-lease";

type AdmissionRequest = Parameters<ManagedBootstrapAdmission["admit"]>[0];
const manifestDigest = "a".repeat(64);

function candidate(projectId = "project", principalId = "owner", chatId = "chat"): ManagedBootstrapCandidate {
	return {
		principalId,
		projectId,
		chatId,
		source: {
			kind: "unbound-history",
			chatId: JSON.stringify([principalId, chatId]),
			principalId,
			projectId,
			sessionId: `session-${chatId}`,
			reason: "ownership-unresolved",
			provenance: { source: "v2", documentHash: "b".repeat(64), nodeHash: "c".repeat(64), nodeRef: "/mappings/0" },
		},
	};
}

function request(
	candidates: readonly ManagedBootstrapCandidate[],
	controller = new AbortController(),
): AdmissionRequest {
	return {
		manifestDigest,
		candidates,
		signal: controller.signal,
		remaining: () => 10_000,
		assertCurrent: async () => {},
	};
}

async function fixture(
	options: {
		beforeAcquire?: (
			input: WorkspaceLeaseAcquireOptions,
		) => Promise<WorkspaceLease | undefined> | WorkspaceLease | undefined;
		afterAcquire?: (lease: WorkspaceLease) => Promise<void> | void;
		leaseMs?: number;
	} = {},
) {
	const root = await mkdtemp(join(tmpdir(), "bootstrap-admission-"));
	const registry = new UserWorkspaceRegistry({ stateRoot: root });
	const workspace = await registry.open("owner");
	const store = new SqliteProjectRegistrationStore(join(root, "projects.sqlite"));
	const sourceRoot = join(root, "source-project");
	await mkdir(sourceRoot);
	const project = store.linkProject(
		{
			id: "project",
			name: "Source",
			cwd: sourceRoot,
			sessionRoot: join(sourceRoot, "sessions"),
			allowedRoot: root,
			createdAt: new Date(0),
		},
		"admin",
	);
	let now = 1_000;
	const manager = new WorkspaceLeaseManager({
		stateRoot: root,
		now: () => now,
		monotonicNow: () => now,
		bootId: () => "admission-test",
	});
	const acquire = manager.acquire.bind(manager);
	const acquisitions: WorkspaceLeaseAcquireOptions[] = [];
	const handles: WorkspaceLease[] = [];
	const acquireSpy = spyOn(manager, "acquire").mockImplementation((async (input: WorkspaceLeaseAcquireOptions) => {
		acquisitions.push({ ...input });
		const returned = await options.beforeAcquire?.(input);
		if (returned !== undefined) return returned;
		const lease = await acquire(input);
		handles.push(lease);
		await options.afterAcquire?.(lease);
		return lease;
	}) as WorkspaceLeaseManager["acquire"]);
	const owners: ManagedBootstrapAdmissionOwner[] = [];
	const makeOwner = () => {
		const owner = new ManagedBootstrapAdmissionOwner({
			projectStore: store,
			registry,
			leaseManager: manager,
			leaseMs: options.leaseMs ?? 10_000,
		});
		owners.push(owner);
		return owner;
	};
	const owner = makeOwner();
	return {
		root,
		registry,
		workspace,
		store,
		project,
		manager,
		acquisitions,
		handles,
		owner,
		makeOwner,
		setNow: (value: number) => {
			now = value;
		},
		cleanup: async () => {
			// Cases asserting cleanup failure retain that rejection; do not turn it into success.
			await Promise.allSettled(owners.map(item => item.release()));
			acquireSpy.mockRestore();
			store.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}

function savedSession(workspace: string, id: string) {
	return {
		id,
		path: join(workspace, "saved.jsonl"),
		identity: {
			dev: "1",
			ino: "2",
			size: 3,
			mtimeMs: 4,
			mtimeNs: "4000000",
			sha256: "a".repeat(64),
			nlink: "1",
			ctimeNs: "4000000",
		},
	};
}

function retainedCandidate(
	source: ManagedBootstrapCandidate,
	workspace: string,
	lease: WorkspaceLease,
): ManagedBootstrapCandidate {
	const saved = savedSession(workspace, source.source.sessionId!);
	const { dev, ino, size, mtimeMs, mtimeNs, sha256 } = saved.identity;
	const lifecycle = createManagedLifecycleEvidence({
		operation: "session.resume",
		preparedAuthority: {
			principalId: source.principalId,
			projectId: source.projectId,
			chatId: source.chatId,
			canonicalWorkspace: workspace,
			leaseId: workspaceLeaseId(lease.reference),
			epoch: SESSION_AUTHORITY_V3_EPOCH,
			requestKey: "retained-original-request",
		},
		historicalSource: {
			kind: "bootstrap-history",
			manifestDigest,
			historicalBinding: source.source,
			savedSession: saved,
		},
		payloadHash: "d".repeat(64),
		target: {
			sessionId: saved.id,
			cwd: workspace,
			sessionPath: saved.path,
			sessionIdentity: { dev, ino, size, mtimeMs, mtimeNs, sha256 },
		},
	});
	return {
		...source,
		retainedIntent: {
			id: "retained-original-request",
			kind: "resume",
			state: "pending",
			startedAt: "2026-01-01T00:00:00.000Z",
			lifecycle,
		},
	};
}

describe("ManagedBootstrapAdmissionOwner", () => {
	test("projects execution into the existing principal workspace without changing source registration or history", async () => {
		const f = await fixture();
		try {
			const source = candidate();
			const original = structuredClone(source);
			const registration = f.store.getProject("project");
			const registry = await readFile(f.registry.registryPath);
			expect(await f.owner.resolve("owner", "project")).toBeUndefined();
			await f.owner.admit(request([source]));
			const authority = (await f.owner.resolve("owner", "project"))!;
			expect(authority.project).toMatchObject({
				id: "project",
				cwd: f.workspace.root,
				sessionRoot: f.workspace.sessionRoot,
			});
			expect(authority.project.cwd).not.toBe(f.project.cwd);
			expect(authority.epoch).toBe(SESSION_AUTHORITY_V3_EPOCH);
			expect(Object.isFrozen(authority)).toBe(true);
			expect(Object.isFrozen(authority.project)).toBe(true);
			await authority.assertFence();
			authority.assertCurrent();
			expect(f.store.getProject("project")).toEqual(registration);
			expect(source).toEqual(original);
			expect(await readFile(f.registry.registryPath)).toEqual(registry);
			expect(await f.owner.resolve("unknown", "project")).toBeUndefined();
			expect(await f.owner.resolve("owner", "unknown")).toBeUndefined();
			expect(f.acquisitions).toHaveLength(1);
			expect(parseWorkspaceLeaseId(authority.leaseId)).toEqual(f.handles[0]!.reference);
			await expect(f.owner.admit(request([source]))).rejects.toThrow("already used");
			await f.owner.release();
			expect(f.handles[0]!.released).toBe(true);
			expect(await f.owner.resolve("owner", "project")).toBeUndefined();
			expect(() => authority.assertCurrent()).toThrow("closed");
		} finally {
			await f.cleanup();
		}
	});

	test("two chats and distinct logical projects share one actual migration lease; owners have unique holders", async () => {
		const f = await fixture();
		try {
			const second = f.store.linkProject(
				{ ...f.project, id: "second", cwd: join(f.root, "source-second") },
				"admin",
			);
			await f.owner.admit(
				request([candidate(), candidate("project", "owner", "chat-2"), candidate(second.id, "owner", "chat-3")]),
			);
			const firstAuthority = (await f.owner.resolve("owner", "project"))!;
			const secondAuthority = (await f.owner.resolve("owner", second.id))!;
			expect(secondAuthority.leaseId).toBe(firstAuthority.leaseId);
			expect(f.acquisitions).toHaveLength(1);
			expect(f.acquisitions[0]!.operation).toBe("migration");
			const competing = f.makeOwner();
			await expect(competing.admit(request([candidate()]))).rejects.toThrow("already held");
			await competing.release();
			firstAuthority.assertCurrent();
			await f.owner.release();
			const successor = f.makeOwner();
			await successor.admit(request([candidate()]));
			expect(f.acquisitions[2]!.holderId).not.toBe(f.acquisitions[0]!.holderId);
			expect((await successor.resolve("owner", "project"))!.leaseId).not.toBe(firstAuthority.leaseId);
		} finally {
			await f.cleanup();
		}
	});

	for (const invalid of [
		"missing-project",
		"unlinked-project",
		"cwd-alias",
		"wrong-project",
		"wrong-principal",
		"wrong-chat",
		"malformed-tuple",
		"missing-registry",
		"missing-root",
		"foreign-registry",
		"historical-workspace",
		"unsafe-session",
	] as const) {
		test(`an invalid later candidate (${invalid}) prevents every acquisition`, async () => {
			const f = await fixture();
			try {
				let later = candidate("project", "owner", "later");
				if (invalid === "missing-project") later = candidate("missing", "owner", "later");
				if (invalid === "unlinked-project") f.store.unlinkProject("project");
				if (invalid === "cwd-alias") later = candidate(f.project.cwd, "owner", "later");
				if (invalid === "wrong-project") later = { ...later, projectId: "different" };
				if (invalid === "wrong-principal") later = { ...later, principalId: "foreign" };
				if (invalid === "wrong-chat") later = { ...later, chatId: "different" };
				if (invalid === "malformed-tuple")
					later = { ...later, source: { ...later.source, chatId: '[ "owner", "later" ]' } };
				if (invalid === "missing-registry") later = candidate("project", "not-registered", "later");
				if (invalid === "missing-root") await rm(f.workspace.root, { recursive: true });
				if (invalid === "foreign-registry")
					await writeFile(
						f.registry.registryPath,
						JSON.stringify({ [f.workspace.safeKey]: { userId: "foreign", workspaceRoot: f.workspace.root } }),
					);
				if (invalid === "historical-workspace")
					later = {
						...later,
						source: { ...later.source, canonicalWorkspace: f.project.cwd, reason: "generation-unproven" },
					};
				if (invalid === "unsafe-session") {
					await rm(f.workspace.sessionRoot, { recursive: true });
					await symlink(f.project.cwd, f.workspace.sessionRoot);
				}
				await expect(f.owner.admit(request([candidate(), later]))).rejects.toThrow();
				expect(f.acquisitions).toHaveLength(0);
				expect(await f.owner.resolve("owner", "project")).toBeUndefined();
			} finally {
				await f.cleanup();
			}
		});
	}

	test("plain legacy chat uses the candidate principal but explicit foreign history never does", async () => {
		const f = await fixture();
		try {
			const { principalId: _principal, ...source } = candidate().source;
			await f.owner.admit(request([{ ...candidate(), source: { ...source, chatId: "chat" } }]));
			(await f.owner.resolve("owner", "project"))!.assertCurrent();
		} finally {
			await f.cleanup();
		}
	});

	test("an explicit matching historical workspace is retained unchanged", async () => {
		const f = await fixture();
		try {
			const source = candidate();
			const admitted: ManagedBootstrapCandidate = {
				...source,
				source: { ...source.source, canonicalWorkspace: f.workspace.root, reason: "generation-unproven" },
			};
			const original = structuredClone(admitted);
			await f.owner.admit(request([admitted]));
			(await f.owner.resolve("owner", "project"))!.assertCurrent();
			expect(admitted).toEqual(original);
		} finally {
			await f.cleanup();
		}
	});

	test("a fresh owner rejects a real retained prepared intent before acquisitions or renewal", async () => {
		const f = await fixture();
		try {
			await f.owner.admit(request([candidate()]));
			const retained = retainedCandidate(candidate(), f.workspace.root, f.handles[0]!);
			const before = await readFile(f.handles[0]!.lockPath);
			const other = f.makeOwner();
			const renewal = spyOn(f.manager, "renew");
			try {
				await expect(other.admit(request([candidate("project", "owner", "fresh"), retained]))).rejects.toThrow(
					"original in-process",
				);
				expect(f.acquisitions).toHaveLength(1);
				expect(renewal).not.toHaveBeenCalled();
				expect(await readFile(f.handles[0]!.lockPath)).toEqual(before);
				(await f.owner.resolve("owner", "project"))!.assertCurrent();
			} finally {
				renewal.mockRestore();
			}
		} finally {
			await f.cleanup();
		}
	});

	for (const mutation of [
		"project",
		"unlink",
		"workspace",
		"registry-replace",
		"registry-content",
		"registry-unrelated",
		"registry-symlink",
		"session-symlink",
	] as const) {
		for (const mode of ["sync", "async"] as const) {
			test(`${mode} authority rejects ${mutation} replacement without refreshing its retained binding`, async () => {
				const f = await fixture();
				try {
					await f.owner.admit(request([candidate()]));
					const authority = (await f.owner.resolve("owner", "project"))!;
					if (mutation === "project") f.store.linkProject({ ...f.project, name: "replacement" }, "admin");
					if (mutation === "unlink") f.store.unlinkProject("project");
					if (mutation === "workspace") {
						await rename(f.workspace.root, `${f.workspace.root}-original`);
						await mkdir(f.workspace.root);
					}
					if (mutation === "registry-replace" || mutation === "registry-symlink") {
						const original = await readFile(f.registry.registryPath);
						await rename(f.registry.registryPath, `${f.registry.registryPath}-original`);
						if (mutation === "registry-replace") await writeFile(f.registry.registryPath, original);
						else await symlink(`${f.registry.registryPath}-original`, f.registry.registryPath);
					}
					if (mutation === "registry-content") await writeFile(f.registry.registryPath, "{}");
					if (mutation === "registry-unrelated") await f.registry.open("another-principal");
					if (mutation === "session-symlink") {
						await rm(f.workspace.sessionRoot, { recursive: true });
						await symlink(f.project.cwd, f.workspace.sessionRoot);
					}
					if (mode === "sync") expect(() => authority.assertCurrent()).toThrow();
					else await expect(Promise.resolve().then(() => authority.assertFence())).rejects.toThrow();
					expect(await f.owner.resolve("owner", "project")).toBeUndefined();
					await f.owner.release();
					expect(f.handles[0]!.released).toBe(true);
				} finally {
					await f.cleanup();
				}
			});
		}
	}

	for (const invalidation of ["cleanup", "expiry", "released", "lease-replaced"] as const) {
		for (const mode of ["sync", "async"] as const) {
			test(`${mode} authority checks the actual lease for ${invalidation}`, async () => {
				const f = await fixture({ leaseMs: 100 });
				try {
					await f.owner.admit(request([candidate()]));
					const authority = (await f.owner.resolve("owner", "project"))!;
					const lease = f.handles[0]!;
					if (invalidation === "cleanup") await lease.setCleanupPending();
					if (invalidation === "expiry") f.setNow(1_100);
					if (invalidation === "released" || invalidation === "lease-replaced") await lease.release();
					let replacement: WorkspaceLease | undefined;
					if (invalidation === "lease-replaced")
						replacement = await f.manager.acquire({
							safeKey: f.workspace.safeKey,
							holderId: "foreign-holder",
							operation: "migration",
							leaseMs: 100,
						});
					if (mode === "sync") expect(() => authority.assertCurrent()).toThrow();
					else await expect(Promise.resolve().then(() => authority.assertFence())).rejects.toThrow();
					if (invalidation === "expiry") await expect(f.owner.release()).rejects.toThrow("release failed");
					else await f.owner.release();
					if (replacement !== undefined) {
						replacement.assertFenceSync();
						await replacement.release();
					}
				} finally {
					await f.cleanup();
				}
			});
		}
	}

	test("snapshots candidates, callbacks, dependency methods and original receivers before any yield", async () => {
		const f = await fixture();
		const originalGet = f.store.getProject;
		const originalResolve = f.registry.resolve;
		const originalAcquire = f.manager.acquire;
		try {
			const source = candidate();
			const candidates = [source];
			let checks = 0;
			const input = {
				...request(candidates),
				marker: "original",
				remaining() {
					expect(this.marker).toBe("original");
					return 75;
				},
				async assertCurrent() {
					expect(this.marker).toBe("original");
					checks += 1;
				},
			};
			const work = f.owner.admit(input);
			input.remaining = () => {
				throw new Error("foreign remaining");
			};
			input.assertCurrent = async () => {
				throw new Error("foreign callback");
			};
			Object.assign(source.source, { principalId: "foreign" });
			Object.assign(source.source.provenance, { nodeHash: "mutated" });
			candidates.push(candidate("missing"));
			f.store.getProject = () => {
				throw new Error("foreign project method");
			};
			f.registry.resolve = async () => {
				throw new Error("foreign registry method");
			};
			f.manager.acquire = (() => {
				throw new Error("foreign acquisition method");
			}) as WorkspaceLeaseManager["acquire"];
			await work;
			const authority = (await f.owner.resolve("owner", "project"))!;
			await authority.assertFence();
			authority.assertCurrent();
			expect(checks).toBeGreaterThan(0);
			expect(f.acquisitions).toHaveLength(1);
			expect(f.acquisitions[0]!.leaseMs).toBe(75);
			await f.owner.release();
		} finally {
			f.store.getProject = originalGet;
			f.registry.resolve = originalResolve;
			f.manager.acquire = originalAcquire;
			await f.cleanup();
		}
	});

	test("owned handle method replacements cannot redirect original fencing or release", async () => {
		let originalReleaseCalls = 0;
		const f = await fixture({
			afterAcquire: lease => {
				const release = lease.release;
				lease.release = async function () {
					originalReleaseCalls += 1;
					return release.call(this);
				};
			},
		});
		try {
			await f.owner.admit(request([candidate()]));
			const authority = (await f.owner.resolve("owner", "project"))!;
			const lease = f.handles[0]!;
			lease.assertFence = async () => {
				throw new Error("foreign fence");
			};
			lease.assertFenceSync = () => {
				throw new Error("foreign sync fence");
			};
			lease.release = async () => {
				throw new Error("foreign release");
			};
			await authority.assertFence();
			authority.assertCurrent();
			await f.owner.release();
			expect(originalReleaseCalls).toBe(1);
			expect(lease.released).toBe(true);
		} finally {
			await f.cleanup();
		}
	});

	for (const method of ["assertFence", "assertFenceSync", "release"] as const) {
		test(`replaced manager ${method} revokes authority and preserves cleanup failure instead of calling the replacement`, async () => {
			const f = await fixture();
			const original = f.manager[method];
			let foreignCalls = 0;
			try {
				await f.owner.admit(request([candidate()]));
				const authority = (await f.owner.resolve("owner", "project"))!;
				Reflect.set(f.manager, method, () => {
					foreignCalls += 1;
					throw new Error("foreign manager");
				});
				expect(() => authority.assertCurrent()).toThrow("dependency changed");
				const release = f.owner.release();
				expect(f.owner.release()).toBe(release);
				await expect(release).rejects.toThrow("release failed");
				expect(foreignCalls).toBe(0);
				expect(f.handles[0]!.released).toBe(false);
				Reflect.set(f.manager, method, original);
				await expect(f.owner.release()).rejects.toThrow("release failed");
				await expect(
					f.manager.acquire({
						safeKey: f.workspace.safeKey,
						holderId: "competitor",
						operation: "migration",
						leaseMs: 100,
					}),
				).rejects.toThrow("already held");
			} finally {
				Reflect.set(f.manager, method, original);
				await f.cleanup();
			}
		});
	}

	test("revalidates all entries after acquisition before publishing any resolver entry", async () => {
		let replace = () => {};
		const f = await fixture({ afterAcquire: () => replace() });
		try {
			replace = () => {
				f.store.linkProject({ ...f.project, name: "replacement during acquire" }, "admin");
			};
			await expect(f.owner.admit(request([candidate()]))).rejects.toThrow("registration changed");
			expect(await f.owner.resolve("owner", "project")).toBeUndefined();
			await f.owner.release();
			expect(f.handles[0]!.released).toBe(true);
		} finally {
			await f.cleanup();
		}
	});

	for (const invalidation of ["cleanup", "project", "dependency"] as const) {
		test(`async fencing rejects ${invalidation} changed inside the original lease fence`, async () => {
			let afterFence = async (_lease: WorkspaceLease) => {};
			const f = await fixture({
				afterAcquire: lease => {
					const original = lease.assertFence;
					lease.assertFence = async function () {
						const result = await original.call(this);
						await afterFence(this);
						return result;
					};
				},
			});
			const originalSync = f.manager.assertFenceSync;
			let foreignCalls = 0;
			try {
				await f.owner.admit(request([candidate()]));
				const authority = (await f.owner.resolve("owner", "project"))!;
				afterFence = async lease => {
					if (invalidation === "cleanup") await lease.setCleanupPending();
					if (invalidation === "project")
						f.store.linkProject({ ...f.project, name: "changed during fence" }, "admin");
					if (invalidation === "dependency")
						f.manager.assertFenceSync = () => {
							foreignCalls += 1;
							throw new Error("foreign synchronous fence");
						};
				};
				await expect(Promise.resolve().then(() => authority.assertFence())).rejects.toThrow();
				expect(await f.owner.resolve("owner", "project")).toBeUndefined();
				expect(foreignCalls).toBe(0);
			} finally {
				f.manager.assertFenceSync = originalSync;
				await f.cleanup();
			}
		});
	}

	test("registry dependency path replacement revokes retained authority without using the foreign path", async () => {
		const f = await fixture();
		const original = f.registry.registryPath;
		try {
			await f.owner.admit(request([candidate()]));
			const authority = (await f.owner.resolve("owner", "project"))!;
			Reflect.set(f.registry, "registryPath", join(f.root, "foreign-registry.json"));
			await expect(Promise.resolve().then(() => authority.assertFence())).rejects.toThrow(
				"registry dependency changed",
			);
			expect(await f.owner.resolve("owner", "project")).toBeUndefined();
			await f.owner.release();
			expect(f.handles[0]!.released).toBe(true);
		} finally {
			Reflect.set(f.registry, "registryPath", original);
			await f.cleanup();
		}
	});

	test("registry replacement during initial lookup cannot become the retained authority", async () => {
		const f = await fixture();
		const original = f.registry.resolve.bind(f.registry);
		const lookup = spyOn(f.registry, "resolve").mockImplementation(async principalId => {
			const workspace = await original(principalId);
			const bytes = await readFile(f.registry.registryPath);
			await rename(f.registry.registryPath, `${f.registry.registryPath}-original`);
			await writeFile(f.registry.registryPath, bytes);
			return workspace;
		});
		try {
			const owner = f.makeOwner();
			await expect(owner.admit(request([candidate()]))).rejects.toThrow("registry changed");
			expect(f.acquisitions).toHaveLength(0);
			expect(await owner.resolve("owner", "project")).toBeUndefined();
		} finally {
			lookup.mockRestore();
			await f.cleanup();
		}
	});

	for (const phase of ["before", "validation", "acquisition", "fence"] as const) {
		test(`abort during ${phase} closes authority and tracks all actual work until release`, async () => {
			const controller = new AbortController();
			let abortFence = false;
			const f = await fixture({
				beforeAcquire: () => {
					if (phase === "acquisition") controller.abort();
				},
				afterAcquire: lease => {
					const fence = lease.assertFence;
					lease.assertFence = async function () {
						const result = await fence.call(this);
						if (abortFence) controller.abort();
						return result;
					};
				},
			});
			try {
				if (phase === "before") controller.abort();
				const input = {
					...request([candidate()], controller),
					assertCurrent: async () => {
						if (phase === "validation") controller.abort();
					},
				};
				if (phase === "fence") {
					await f.owner.admit(input);
					const authority = (await f.owner.resolve("owner", "project"))!;
					abortFence = true;
					await expect(Promise.resolve().then(() => authority.assertFence())).rejects.toThrow("cancelled");
					expect(() => authority.assertCurrent()).toThrow("closed");
				} else await expect(f.owner.admit(input)).rejects.toThrow("cancelled");
				expect(await f.owner.resolve("owner", "project")).toBeUndefined();
				await f.owner.release();
				expect(f.acquisitions).toHaveLength(phase === "before" || phase === "validation" ? 0 : 1);
				for (const handle of f.handles) expect(handle.released).toBe(true);
			} finally {
				await f.cleanup();
			}
		});
	}

	test("release waits validation that the bounded caller has abandoned and cannot restart admission", async () => {
		const f = await fixture();
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		try {
			const work = f.owner.admit({
				...request([candidate()]),
				assertCurrent: async () => {
					entered.resolve();
					await gate.promise;
				},
			});
			await entered.promise;
			const release = f.owner.release();
			let released = false;
			void release.then(() => {
				released = true;
			});
			await Promise.resolve();
			expect(released).toBe(false);
			expect(await f.owner.resolve("owner", "project")).toBeUndefined();
			gate.resolve();
			await expect(work).rejects.toThrow("closed");
			await release;
			expect(f.acquisitions).toHaveLength(0);
			await expect(f.owner.admit(request([candidate()]))).rejects.toThrow("closed");
		} finally {
			gate.resolve();
			await f.cleanup();
		}
	});

	test("remaining expiry queued by the original callback prevents acquisition without an abort", async () => {
		const f = await fixture();
		let expired = false;
		try {
			await expect(
				f.owner.admit({
					...request([candidate()]),
					remaining: () => {
						if (expired) return 0;
						queueMicrotask(() => {
							expired = true;
						});
						return 100;
					},
				}),
			).rejects.toThrow("deadline expired");
			expect(expired).toBe(true);
			expect(f.acquisitions).toHaveLength(0);
			expect(await f.owner.resolve("owner", "project")).toBeUndefined();
			await f.owner.release();
		} finally {
			await f.cleanup();
		}
	});

	for (const invocationBudget of [0, 25]) {
		test(`queued acquisition uses the original deadline at invocation, not the earlier sample (${invocationBudget}ms)`, async () => {
			const f = await fixture();
			let budget = 100;
			let checkpoints = 0;
			try {
				const work = f.owner.admit({
					...request([candidate()]),
					remaining: () => budget,
					assertCurrent: async () => {
						if (++checkpoints !== 2) return;
						// Cross the checkpoint's own continuation, then admission's
						// continuation; change budget before the queued acquire starts.
						queueMicrotask(() =>
							queueMicrotask(() =>
								queueMicrotask(() => {
									budget = invocationBudget;
								}),
							),
						);
					},
				});
				if (invocationBudget === 0) {
					await expect(work).rejects.toThrow("deadline expired");
					expect(f.acquisitions).toHaveLength(0);
					expect(await f.owner.resolve("owner", "project")).toBeUndefined();
				} else {
					await work;
					expect(f.acquisitions).toHaveLength(1);
					expect(f.acquisitions[0]!.leaseMs).toBe(invocationBudget);
					(await f.owner.resolve("owner", "project"))!.assertCurrent();
				}
				await f.owner.release();
			} finally {
				await f.cleanup();
			}
		});
	}

	for (const phase of ["lookup", "checkpoint", "post-acquire-lookup", "final-checkpoint"] as const) {
		test(`expiry of original deadline during ${phase} never publishes authority`, async () => {
			const f = await fixture();
			const gate = Promise.withResolvers<void>();
			const entered = Promise.withResolvers<void>();
			let expired = false;
			let remainingCalls = 0;
			let lookups = 0;
			let checkpoints = 0;
			const original = f.registry.resolve.bind(f.registry);
			const lookup = spyOn(f.registry, "resolve").mockImplementation(async principalId => {
				const workspace = await original(principalId);
				lookups += 1;
				if ((phase === "lookup" && lookups === 1) || (phase === "post-acquire-lookup" && lookups === 2)) {
					entered.resolve();
					await gate.promise;
				}
				return workspace;
			});
			try {
				const owner = f.makeOwner();
				const work = owner.admit({
					...request([candidate()]),
					remaining: () => {
						remainingCalls += 1;
						return expired ? 0 : 100;
					},
					assertCurrent: async () => {
						checkpoints += 1;
						if (
							(phase === "checkpoint" && checkpoints === 1) ||
							(phase === "final-checkpoint" && checkpoints === 3)
						) {
							entered.resolve();
							await gate.promise;
						}
					},
				});
				await entered.promise;
				expired = true;
				gate.resolve();
				await expect(work).rejects.toThrow("deadline expired");
				expect(await owner.resolve("owner", "project")).toBeUndefined();
				expect(f.acquisitions).toHaveLength(phase === "lookup" || phase === "checkpoint" ? 0 : 1);
				const beforeCleanup = remainingCalls;
				await owner.release();
				expect(remainingCalls).toBe(beforeCleanup);
				for (const lease of f.handles) expect(lease.released).toBe(true);
			} finally {
				gate.resolve();
				lookup.mockRestore();
				await f.cleanup();
			}
		});
	}

	for (const releaseBeforeReturn of [false, true]) {
		test(`late genuine acquisition after deadline is cleanup-only (release before return: ${releaseBeforeReturn})`, async () => {
			const gate = Promise.withResolvers<void>();
			const entered = Promise.withResolvers<void>();
			let expired = false;
			let remainingCalls = 0;
			let releases = 0;
			let acquiredExpiresAt = 0;
			const f = await fixture({
				beforeAcquire: async () => {
					entered.resolve();
					await gate.promise;
				},
				afterAcquire: lease => {
					lease.assertFenceSync();
					acquiredExpiresAt = lease.leaseExpiresAt;
					const original = lease.release;
					lease.release = async function () {
						releases += 1;
						return original.call(this);
					};
				},
			});
			try {
				const work = f.owner.admit({
					...request([candidate()]),
					remaining: () => {
						remainingCalls += 1;
						return expired ? 0 : 100;
					},
				});
				await entered.promise;
				expired = true;
				f.setNow(2_000);
				let cleanup: Promise<void> | undefined;
				let cleaned = false;
				if (releaseBeforeReturn) {
					cleanup = f.owner.release();
					void cleanup.then(() => {
						cleaned = true;
					});
					await Promise.resolve();
					expect(cleaned).toBe(false);
					expect(releases).toBe(0);
				}
				gate.resolve();
				await expect(work).rejects.toThrow(releaseBeforeReturn ? "closed" : "deadline expired");
				expect(f.handles).toHaveLength(1);
				expect(acquiredExpiresAt).toBe(2_100);
				if (!releaseBeforeReturn) f.handles[0]!.assertFenceSync();
				expect(await f.owner.resolve("owner", "project")).toBeUndefined();
				const beforeCleanup = remainingCalls;
				await (cleanup ?? f.owner.release());
				expect(remainingCalls).toBe(beforeCleanup);
				expect(releases).toBe(1);
				expect(f.handles[0]!.released).toBe(true);
				await f.owner.release();
				expect(releases).toBe(1);
			} finally {
				gate.resolve();
				await f.cleanup();
			}
		});
	}

	for (const boundary of ["resolve", "sync", "async"] as const) {
		test(`${boundary} currentness rejects expired original deadline despite a live lease`, async () => {
			const f = await fixture();
			let expired = false;
			let remainingCalls = 0;
			try {
				const input = {
					...request([candidate()]),
					remaining: () => {
						remainingCalls += 1;
						if (expired) throw new Error("original deadline expired");
						return 1_000;
					},
				};
				await f.owner.admit(input);
				const authority = (await f.owner.resolve("owner", "project"))!;
				input.remaining = () => 1_000;
				expired = true;
				f.handles[0]!.assertFenceSync();
				if (boundary === "resolve") expect(await f.owner.resolve("owner", "project")).toBeUndefined();
				if (boundary === "sync") expect(() => authority.assertCurrent()).toThrow("original deadline expired");
				if (boundary === "async")
					await expect(Promise.resolve().then(() => authority.assertFence())).rejects.toThrow(
						"original deadline expired",
					);
				expect(await f.owner.resolve("owner", "project")).toBeUndefined();
				const beforeCleanup = remainingCalls;
				await f.owner.release();
				expect(remainingCalls).toBe(beforeCleanup);
				expect(f.handles[0]!.released).toBe(true);
			} finally {
				await f.cleanup();
			}
		});
	}

	test("remaining callback can release reentrantly without recursion or granting authority", async () => {
		const f = await fixture();
		let releaseInCallback = false;
		let cleanup: Promise<void> | undefined;
		let callbackCalls = 0;
		try {
			await f.owner.admit({
				...request([candidate()]),
				remaining: () => {
					callbackCalls += 1;
					if (releaseInCallback) cleanup = f.owner.release();
					return 1_000;
				},
			});
			const authority = (await f.owner.resolve("owner", "project"))!;
			releaseInCallback = true;
			const before = callbackCalls;
			expect(() => authority.assertCurrent()).toThrow("closed");
			expect(callbackCalls).toBe(before + 1);
			expect(await f.owner.resolve("owner", "project")).toBeUndefined();
			expect(f.owner.release()).toBe(cleanup!);
			await cleanup;
			expect(callbackCalls).toBe(before + 1);
			expect(f.handles[0]!.released).toBe(true);
		} finally {
			await f.cleanup();
		}
	});

	test("late acquisition after reentrant abort/release remains owned until it really returns and releases exactly once", async () => {
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const controller = new AbortController();
		let beginRelease = () => {};
		let releaseCalls = 0;
		const f = await fixture({
			afterAcquire: async lease => {
				const original = lease.release;
				lease.release = async function () {
					releaseCalls += 1;
					return original.call(this);
				};
				controller.abort();
				beginRelease();
				entered.resolve();
				await gate.promise;
			},
		});
		try {
			let release: Promise<void> | undefined;
			beginRelease = () => {
				release = f.owner.release();
			};
			const work = f.owner.admit(request([candidate()], controller));
			await entered.promise;
			const bounded = await Promise.race([work.then(() => "admitted"), Promise.resolve("caller-timeout")]);
			expect(bounded).toBe("caller-timeout");
			expect(f.owner.release()).toBe(release!);
			let finished = false;
			void release!.then(() => {
				finished = true;
			});
			await Promise.resolve();
			expect(finished).toBe(false);
			expect(f.handles[0]!.released).toBe(false);
			expect(releaseCalls).toBe(0);
			expect(await f.owner.resolve("owner", "project")).toBeUndefined();
			gate.resolve();
			await expect(work).rejects.toThrow("closed");
			await release;
			expect(releaseCalls).toBe(1);
			expect(f.handles[0]!.released).toBe(true);
			await f.owner.release();
			expect(releaseCalls).toBe(1);
		} finally {
			gate.resolve();
			await f.cleanup();
		}
	});

	test("an acquisition rejection does not lose earlier handles or fabricate a new handle", async () => {
		let fail = false;
		const f = await fixture({
			beforeAcquire: () => {
				if (fail) throw "acquisition-denied";
				fail = true;
			},
		});
		try {
			await f.registry.open("second-owner");
			await expect(
				f.owner.admit(request([candidate(), candidate("project", "second-owner", "second-chat")])),
			).rejects.toBe("acquisition-denied");
			expect(f.handles).toHaveLength(1);
			expect(await f.owner.resolve("owner", "project")).toBeUndefined();
			await f.owner.release();
			expect(f.handles[0]!.released).toBe(true);
		} finally {
			await f.cleanup();
		}
	});

	test("a returned handle with an invalid public reference remains owned for cleanup", async () => {
		let releases = 0;
		const f = await fixture({
			afterAcquire: lease => {
				const original = lease.release;
				lease.release = async function () {
					releases += 1;
					return original.call(this);
				};
				Object.defineProperty(lease, "reference", {
					configurable: true,
					value: { ...lease.reference, generation: 0 },
				});
			},
		});
		try {
			await expect(f.owner.admit(request([candidate()]))).rejects.toThrow();
			await f.owner.release();
			expect(releases).toBe(1);
			expect(f.handles[0]!.released).toBe(true);
			expect(await f.owner.resolve("owner", "project")).toBeUndefined();
		} finally {
			await f.cleanup();
		}
	});

	for (const mismatch of ["holder", "safeKey", "operation"] as const) {
		test(`a returned pre-existing lease with wrong ${mismatch} stays current while earlier genuine handles clean`, async () => {
			let intercept: (input: WorkspaceLeaseAcquireOptions) => Promise<WorkspaceLease | undefined> = async () => {};
			const f = await fixture({ beforeAcquire: input => intercept(input) });
			const second = await f.registry.open("second-owner");
			const foreignWorkspace = await f.registry.open("foreign-owner");
			const foreignManager = new WorkspaceLeaseManager({
				stateRoot: f.root,
				now: () => 1_000,
				monotonicNow: () => 1_000,
				bootId: () => "admission-test",
			});
			let foreign: WorkspaceLease | undefined;
			let foreignBytes: Buffer | undefined;
			let foreignReleaseCalls = 0;
			let originalForeignRelease: (() => Promise<void>) | undefined;
			let attempts = 0;
			try {
				intercept = async input => {
					expect(Object.isFrozen(input)).toBe(true);
					expect(Reflect.set(input, "holderId", "mutated-acquisition-holder")).toBe(false);
					if (++attempts === 1) {
						// Construct a real pre-existing fence before the owner's later
						// acquisition. Match every identity field except the tested one.
						foreign = await foreignManager.acquire({
							safeKey: mismatch === "safeKey" ? foreignWorkspace.safeKey : second.safeKey,
							holderId: mismatch === "holder" ? "pre-existing-holder" : input.holderId,
							operation: mismatch === "operation" ? "turn" : "migration",
							leaseMs: 10_000,
						});
						foreignBytes = await readFile(foreign.lockPath);
						originalForeignRelease = foreign.release.bind(foreign);
						foreign.release = async () => {
							foreignReleaseCalls += 1;
							await originalForeignRelease!();
						};
						return;
					}
					return foreign!;
				};
				await expect(
					f.owner.admit(request([candidate(), candidate("project", "second-owner", "second-chat")])),
				).rejects.toThrow("foreign lease");
				const cleanup = f.owner.release();
				expect(f.owner.release()).toBe(cleanup);
				await expect(cleanup).rejects.toThrow("release failed");
				await expect(f.owner.release()).rejects.toThrow("release failed");
				expect(f.handles).toHaveLength(1);
				expect(f.handles[0]!.released).toBe(true);
				expect(foreignReleaseCalls).toBe(0);
				expect(foreign!.released).toBe(false);
				foreign!.assertFenceSync();
				if (foreignBytes === undefined) throw new Error("Foreign lease snapshot was not captured.");
				expect((await readFile(foreign!.lockPath)).equals(foreignBytes)).toBe(true);
				expect(await f.owner.resolve("owner", "project")).toBeUndefined();
			} finally {
				await originalForeignRelease?.();
				await f.cleanup();
			}
		});
	}

	test("an invalid primitive generation never grants cleanup authority even with matching requested fields", async () => {
		let restore = () => {};
		let releases = 0;
		const f = await fixture({
			afterAcquire: lease => {
				const record = lease.record;
				restore = () => lease.updateFromManager(record);
				lease.updateFromManager({ ...record, generation: 0 });
				const original = lease.release;
				lease.release = async function () {
					releases += 1;
					return original.call(this);
				};
			},
		});
		try {
			await expect(f.owner.admit(request([candidate()]))).rejects.toThrow();
			const before = await readFile(f.handles[0]!.lockPath);
			const cleanup = f.owner.release();
			await expect(cleanup).rejects.toThrow("release failed");
			expect(releases).toBe(0);
			restore();
			f.handles[0]!.assertFenceSync();
			expect(await readFile(f.handles[0]!.lockPath)).toEqual(before);
			await expect(f.owner.release()).rejects.toThrow("release failed");
			expect(releases).toBe(0);
		} finally {
			restore();
			await f.handles[0]?.release();
			await f.cleanup();
		}
	});

	for (const publicReference of ["updated", "original"] as const) {
		test(`cleanup cannot release a replacement after unreleased handle primitive identity changes (${publicReference} public reference)`, async () => {
			let originalReleaseCalls = 0;
			const f = await fixture({
				afterAcquire: lease => {
					const original = lease.release;
					lease.release = async function () {
						originalReleaseCalls += 1;
						await original.call(this);
					};
				},
			});
			let replacement: WorkspaceLease | undefined;
			try {
				await f.owner.admit(request([candidate()]));
				const original = f.handles[0]!;
				const reference = original.reference;
				f.setNow(11_001);
				replacement = await f.manager.acquire({
					safeKey: f.workspace.safeKey,
					holderId: publicReference === "original" ? reference.holderId : "replacement-owner",
					operation: "migration",
					leaseMs: 10_000,
				});
				original.updateFromManager(replacement.record);
				if (publicReference === "original") Object.defineProperty(original, "reference", { value: reference });
				expect(original.released).toBe(false);
				const before = await readFile(replacement.lockPath);
				const cleanup = f.owner.release();
				await expect(cleanup).rejects.toThrow("release failed");
				expect(f.owner.release()).toBe(cleanup);
				expect(originalReleaseCalls).toBe(0);
				replacement.assertFenceSync();
				expect(await readFile(replacement.lockPath)).toEqual(before);
			} finally {
				await replacement?.release();
				await f.cleanup();
			}
		});
	}

	test("release aggregates arbitrary thrown values across handles and keeps one shared failure with exclusion", async () => {
		const failures = [undefined, "release-denied"];
		const releases: string[] = [];
		let acquired = 0;
		const f = await fixture({
			afterAcquire: lease => {
				const index = acquired++;
				const original = lease.release;
				lease.release = async function () {
					releases.push(this.safeKey);
					if (index < failures.length) throw failures[index];
					return original.call(this);
				};
			},
		});
		try {
			await f.registry.open("second-owner");
			await f.registry.open("third-owner");
			await f.owner.admit(
				request([
					candidate(),
					candidate("project", "second-owner", "second-chat"),
					candidate("project", "third-owner", "third-chat"),
				]),
			);
			const release = f.owner.release();
			expect(f.owner.release()).toBe(release);
			let rejection: unknown;
			try {
				await release;
			} catch (error) {
				rejection = error;
			}
			expect(rejection).toBeInstanceOf(AggregateError);
			expect((rejection as AggregateError).errors).toEqual(failures);
			expect(releases).toHaveLength(3);
			await expect(f.owner.release()).rejects.toBe(rejection);
			expect(releases).toHaveLength(3);
			expect(f.handles[2]!.released).toBe(true);
			for (const lease of f.handles.slice(0, 2)) {
				expect(lease.released).toBe(false);
				await expect(
					f.manager.acquire({
						safeKey: lease.safeKey,
						holderId: "competitor",
						operation: "migration",
						leaseMs: 100,
					}),
				).rejects.toThrow("already held");
			}
		} finally {
			await f.cleanup();
		}
	});

	test("constructor and unknown lookup create no project or workspace, and release-before-admit is terminal", async () => {
		const root = await mkdtemp(join(tmpdir(), "bootstrap-admission-empty-"));
		const store = new SqliteProjectRegistrationStore(join(root, "projects.sqlite"));
		const registry = new UserWorkspaceRegistry({ stateRoot: join(root, "absent-state") });
		const manager = new WorkspaceLeaseManager({ stateRoot: registry.stateRoot });
		try {
			for (const leaseMs of [0, -1, Infinity, NaN, 0.5])
				expect(
					() =>
						new ManagedBootstrapAdmissionOwner({ projectStore: store, registry, leaseManager: manager, leaseMs }),
				).toThrow();
			const owner = new ManagedBootstrapAdmissionOwner({
				projectStore: store,
				registry,
				leaseManager: manager,
				leaseMs: 100,
			});
			expect(await owner.resolve("unknown", "unknown")).toBeUndefined();
			expect(store.listProjects()).toEqual([]);
			await expect(readFile(registry.registryPath)).rejects.toMatchObject({ code: "ENOENT" });
			const release = owner.release();
			expect(owner.release()).toBe(release);
			await release;
			await expect(owner.admit(request([candidate()]))).rejects.toThrow("closed");
			await expect(readFile(manager.lockPath("a".repeat(64)))).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			store.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	test("mismatched state roots cannot create registrations, workspaces or lease authority", async () => {
		const root = await mkdtemp(join(tmpdir(), "bootstrap-admission-mismatch-"));
		const store = new SqliteProjectRegistrationStore(join(root, "projects.sqlite"));
		const registry = new UserWorkspaceRegistry({ stateRoot: join(root, "registry-state") });
		const manager = new WorkspaceLeaseManager({ stateRoot: join(root, "lease-state") });
		const acquire = spyOn(manager, "acquire");
		try {
			expect(
				() =>
					new ManagedBootstrapAdmissionOwner({
						projectStore: store,
						registry,
						leaseManager: manager,
						leaseMs: 100,
					}),
			).toThrow("same canonical state root");
			expect(acquire).not.toHaveBeenCalled();
			expect(store.listProjects()).toEqual([]);
			await expect(readFile(registry.registryPath)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(readFile(manager.lockPath("a".repeat(64)))).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			acquire.mockRestore();
			store.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("real admission owner with the actual V3 bootstrap coordinator", () => {
	test("projects source cwd, activates using exact SDK transport proof and releases its real migration handle", async () => {
		const f = await fixture();
		const sourcePath = join(f.root, "authority.json");
		const chatId = JSON.stringify(["owner", "chat"]);
		const stamp = "2026-01-01T00:00:00.000Z";
		const original = JSON.stringify({
			kind: "openwebui-gjc-session-authority",
			version: 2,
			mappings: [
				{
					version: 2,
					chatId,
					projectId: "project",
					sessionId: "session",
					createdAt: stamp,
					header: { chatId, projectId: "project", sessionId: "session" },
					rawFrameCursor: 1,
					eventCursor: 2,
					operationId: "turn",
					sessionFile: "/inert/history.jsonl",
					assistantText: "retained answer",
					journal: [
						{
							id: "turn",
							kind: "prompt",
							state: "complete",
							startedAt: stamp,
							completedAt: stamp,
							result: {
								kind: "turn",
								assistantText: "retained answer",
								mapping: {
									chatId,
									projectId: "project",
									sessionId: "session",
									operationId: "turn",
									rawFrameCursor: 1,
									eventCursor: 2,
								},
							},
						},
					],
				},
			],
			provisionalOperations: [],
		});
		await writeFile(sourcePath, original);
		const runtimeLock = await RuntimeSingletonLock.acquire(f.root);
		const calls: string[] = [];
		let runtime: ManagedSdkRuntime | undefined;
		try {
			const attempt = startAdapterSessionAuthorityV3Activation({
				locations: { agentDir: f.root, stateRoot: f.root },
				configuredOwnerUserId: "owner",
				sourcePath,
				runtimeLock,
				authority: f.owner,
				admission: f.owner,
				timeoutMs: 10_000,
				createRuntime: (agentDir, owned) => {
					const attachment = { sessionId: "session", generation: 7, isCurrent: () => true };
					const sdkRouter = {
						start: async () => {
							calls.push("start");
						},
						stop: async () => {
							calls.push("stop");
							expect(f.handles[0]!.released).toBe(false);
						},
						reconcile: async () => {
							calls.push("reconcile");
						},
						attachment: (id: string, generation: number) =>
							id === "session" && generation === 7 ? attachment : undefined,
						generationStatus: async () => ({ status: "current" }),
					} as unknown as router.SessionRouter;
					const service = {
						list: async (input: Parameters<lifecycle.AgentDirSessionLifecycleService["list"]>[0]) => {
							calls.push("list");
							expect(input.target).toEqual({ cwd: f.workspace.root, resolveSessionId: "session" });
							expect(readFileSync(sourcePath, "utf8")).toBe(original);
							return {
								ok: true,
								operation: "session.list",
								result: { savedSession: savedSession(f.workspace.root, "session") },
							};
						},
						resume: async (input: Parameters<lifecycle.AgentDirSessionLifecycleService["resume"]>[0]) => {
							calls.push("resume");
							expect(input.target).toMatchObject({ cwd: f.workspace.root });
							expect(readFileSync(sourcePath, "utf8")).toBe(original);
							expect(input.requestKey).toStartWith("migration:resume:");
							return {
								ok: true,
								operation: "session.resume",
								result: { sessionId: "session", endpointGeneration: 7 },
							};
						},
					} as unknown as lifecycle.AgentDirSessionLifecycleService;
					runtime = new ManagedSdkRuntime({
						agentDir,
						deps: { ...owned, createRouter: () => sdkRouter, createLifecycleService: () => service },
					});
					return runtime;
				},
			});
			const result = await attempt.result;
			await attempt.settled;
			expect(result.status).toBe("activated");
			if (result.status !== "activated") throw new Error("Expected actual historical bootstrap activation.");
			result.store.close();
			const graph = parseSessionAuthorityV3Document(await readFile(sourcePath))!;
			const mapping = graph.mappings[0]!;
			expect(mapping.managedAuthority).toMatchObject({
				principalId: "owner",
				projectId: "project",
				canonicalWorkspace: f.workspace.root,
				generation: 7,
				epoch: SESSION_AUTHORITY_V3_EPOCH,
				leaseId: workspaceLeaseId(f.handles[0]!.reference),
			});
			expect(mapping.journal.at(-1)?.lifecycle?.historicalSource?.historicalBinding).toMatchObject({
				projectId: "project",
				sessionId: "session",
			});
			expect(f.store.getProject("project")).toEqual(f.project);
			expect(f.acquisitions).toHaveLength(1);
			expect(f.handles[0]!.released).toBe(true);
			expect(calls.filter(call => call === "resume")).toHaveLength(1);
			expect(calls.at(-1)).toBe("stop");
			expect(await f.owner.resolve("owner", "project")).toBeUndefined();
		} finally {
			await runtime?.dispose();
			await runtimeLock.release();
			await f.cleanup();
		}
	});
});
