import { describe, expect, test } from "bun:test";
import type { lifecycle, router } from "@gajae-code/coding-agent/sdk";
import {
	type ManagedSdkAccess,
	type ManagedSdkLifecycleOperation,
	ManagedSdkRuntime,
	type ManagedSdkRuntimeDeps,
	type TenantSessionKey,
} from "../src/gjc/managed-sdk-runtime";
import type { ManagedPreparedTurnAuthority } from "../src/gjc/turn-runner";

type LifecycleService = ReturnType<typeof lifecycle.createSessionLifecycleService>;
type CloseRequest = Parameters<LifecycleService["close"]>[0];
type CreateRequest = Parameters<LifecycleService["createExternal"]>[0];
type ResumeRequest = Parameters<LifecycleService["resumeExternal"]>[0];
type ListRequest = Parameters<LifecycleService["list"]>[0];

const tenant: TenantSessionKey = {
	principalId: "principal-1",
	projectId: "project-1",
	canonicalWorkspace: "/workspace/project-1",
	chatId: "chat-1",
	sessionId: "session-1",
	generation: 7,
	leaseId: "lease-1",
	epoch: "epoch-1",
};

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function closeRequest(): CloseRequest {
	return {
		actor: { id: tenant.principalId, namespace: "openwebui-gjc-adapter" },
		capability: "session.close",
		requestKey: "close-1",
		target: {
			sessionId: tenant.sessionId,
			endpointGeneration: tenant.generation,
			// Synthetic authority for boundary tests, not obtainable from SDK 0.16.4 public results.
			endpointIncarnation: "0123456789abcdef".repeat(4),
		},
		timeoutMs: 500,
	};
}

function operationIdentity(): ManagedSdkLifecycleOperation {
	return { operationId: "operation-1", requestKey: "close-1", payloadHash: "a".repeat(64) };
}

function preparedAuthority(): ManagedPreparedTurnAuthority {
	return {
		principalId: tenant.principalId,
		projectId: tenant.projectId,
		canonicalWorkspace: tenant.canonicalWorkspace,
		chatId: tenant.chatId,
		leaseId: tenant.leaseId,
		epoch: tenant.epoch,
		requestKey: "create-1",
	};
}

function createRequest(): CreateRequest {
	return {
		actor: { id: tenant.principalId, namespace: "openwebui-gjc-adapter" },
		capability: "session.create",
		requestKey: "create-1",
		target: { kind: "existing_path", path: tenant.canonicalWorkspace },
		readinessTimeoutMs: 500,
	};
}

function listRequest(): ListRequest {
	return {
		actor: closeRequest().actor,
		capability: "session.list",
		target: { cwd: tenant.canonicalWorkspace, resolveSessionId: tenant.sessionId },
		timeoutMs: 500,
	};
}

function observedFrame(seq: number): router.SessionRouterFrame {
	return {
		body: {},
		name: "event",
		sessionId: tenant.sessionId,
		generation: tenant.generation,
		commandId: "queued-command",
		seq,
	};
}

function fixture(
	options: {
		start?: () => Promise<void>;
		stop?: () => Promise<void>;
		fence?: ManagedSdkRuntimeDeps["tenantFence"];
		preparedFence?: ManagedSdkRuntimeDeps["preparedTenantFence"];
		omitTenantFence?: boolean;
		omitPreparedFence?: boolean;
		request?: () => Promise<Record<string, unknown>>;
		close?: LifecycleService["close"];
		list?: LifecycleService["list"];
		reconcile?: () => Promise<void>;
		generationStatus?: router.SessionRouter["generationStatus"];
		maxFrames?: number;
		drainTimeoutMs?: number;
	} = {},
) {
	let onFrame:
		| ((attachment: router.SessionAttachment, frame: router.SessionRouterFrame) => Promise<void> | void)
		| undefined;
	const attachment = {
		sessionId: tenant.sessionId,
		generation: tenant.generation,
		isCurrent: () => true,
		send: () => undefined,
	} as router.SessionAttachment;
	const foreignAttachment = {
		sessionId: tenant.sessionId,
		generation: tenant.generation,
		isCurrent: () => true,
		send: () => undefined,
	} as router.SessionAttachment;
	const calls: string[] = [];
	const closeCalls: CloseRequest[] = [];
	const createCalls: CreateRequest[] = [];
	const resumeCalls: ResumeRequest[] = [];
	const listCalls: ListRequest[] = [];
	const statusCalls: Array<{ sessionId: string; generation: number }> = [];
	let currentAttachment = attachment;
	const lifecycleService: Pick<LifecycleService, "close" | "createExternal" | "resumeExternal" | "list" | "delete"> = {
		async close(request) {
			closeCalls.push(request);
			if (options.close !== undefined) return await options.close(request);
			return { ok: true, operation: "session.close", result: { sessionId: request.target.sessionId } };
		},
		async createExternal(request) {
			createCalls.push(request);
			return { ok: true, operation: "session.create", result: { sessionId: "created", endpointGeneration: 1 } };
		},
		async resumeExternal(request) {
			resumeCalls.push(request);
			return {
				kind: "result",
				outcome: {
					ok: true,
					operation: "session.resume",
					result: { sessionId: tenant.sessionId, endpointGeneration: tenant.generation },
				},
			};
		},
		async list(request) {
			listCalls.push(request);
			if (options.list !== undefined) return await options.list(request);
			return { ok: true, operation: "session.list", result: { indexSeq: 1, sessions: [], warnings: [] } };
		},
		async delete() {
			calls.push("delete");
			throw new Error("Delete must never dispatch.");
		},
	};
	const sessionRouter = {
		async start() {
			calls.push("start");
			await options.start?.();
		},
		async stop() {
			calls.push("stop");
			await options.stop?.();
		},
		async reconcile() {
			calls.push("reconcile");
			await options.reconcile?.();
		},
		attachment(sessionId: string, generation?: number) {
			return sessionId === tenant.sessionId && generation === tenant.generation ? currentAttachment : null;
		},
		async request(
			_sessionId: string,
			_frame: Record<string, unknown>,
			_generation: number,
			_expected: router.SessionAttachment,
			requestOptions?: { beforeDispatch?: (context: never) => void; onDispatch?: (context: never) => void },
		) {
			requestOptions?.beforeDispatch?.({} as never);
			calls.push("request");
			requestOptions?.onDispatch?.({} as never);
			if (options.request !== undefined) return await options.request();
			return { ok: true };
		},
		async generationStatus(sessionId: string, generation: number) {
			statusCalls.push({ sessionId, generation });
			if (options.generationStatus !== undefined) return options.generationStatus(sessionId, generation);
			return {
				status: "retired",
				evidence: { source: "session_index", observedIndexSeq: 1, evidenceIndexSeq: 1, event: "session_closed" },
			};
		},
	} as unknown as router.SessionRouter;
	const runtime = new ManagedSdkRuntime({
		agentDir: "/agent",
		deps: {
			createRouter: input => {
				onFrame = input.deps?.onFrame;
				return sessionRouter;
			},
			createLifecycleService: () => lifecycleService as ReturnType<typeof lifecycle.createSessionLifecycleService>,
			...(options.omitTenantFence
				? {}
				: {
						tenantFence: (key: TenantSessionKey, access: ManagedSdkAccess) =>
							options.fence?.(key, access) ?? true,
					}),
			...(options.omitPreparedFence ? {} : { preparedTenantFence: options.preparedFence ?? (() => true) }),
			...(options.drainTimeoutMs === undefined ? {} : { drainTimeoutMs: options.drainTimeoutMs }),
			...(options.maxFrames === undefined ? {} : { maxFramesPerSubscription: options.maxFrames }),
		},
	});
	return {
		runtime,
		attachment,
		foreignAttachment,
		calls,
		closeCalls,
		createCalls,
		resumeCalls,
		listCalls,
		statusCalls,
		replaceAttachment() {
			currentAttachment = foreignAttachment;
		},
		emit: async (frame: router.SessionRouterFrame, sourceAttachment = attachment) =>
			await onFrame?.(sourceAttachment, frame),
	};
}

describe("managed SDK runtime", () => {
	test("purpose-only grants prove identity and retirement but never authorize active traffic", async () => {
		const operation = operationIdentity();
		const accesses: ManagedSdkAccess[] = [];
		const f = fixture({
			fence: (key, access) => {
				accesses.push(access);
				return (
					JSON.stringify(key) === JSON.stringify(tenant) &&
					access.kind !== "active" &&
					access.operationId === operation.operationId &&
					access.requestKey === operation.requestKey &&
					access.payloadHash === operation.payloadHash
				);
			},
		});
		await f.runtime.start();
		const token = await f.runtime.proveLifecycleTenant(tenant, operation);
		expect(await f.runtime.proveLifecycleTenant(tenant, operation)).toBe(token);
		expect(Object.keys(token).sort()).toEqual(["generation", "isCurrent", "tenant"]);
		for (const frame of [
			{ type: "control_request", operation: "turn.prompt" },
			{ type: "query_request", query: "session.state" },
		])
			await expect(f.runtime.request(token, frame)).rejects.toThrow("fence was lost");
		await expect(f.runtime.acquireAttachment(tenant)).rejects.toThrow("fence was lost");
		await expect(f.runtime.closeLifecycleSession(tenant, closeRequest())).rejects.toThrow("fence was lost");
		await expect(f.runtime.generationStatus(tenant)).rejects.toThrow("fence was lost");
		expect(() => f.runtime.subscribeFrames(token, "turn", { commandId: "queued-command" }, () => {})).toThrow(
			"Active tenant acquisition",
		);
		expect(() => f.runtime.prepareFrameSubscription(token, "turn", () => {})).toThrow("Active tenant acquisition");
		const request = {
			...closeRequest(),
			target: { sessionId: tenant.sessionId, endpointGeneration: tenant.generation },
		};
		await expect(f.runtime.retireLifecycleSession(tenant, request, operation)).rejects.toMatchObject({
			code: "exact_close_authority_unavailable",
		});
		expect(f.closeCalls).toEqual([]);
		expect(f.statusCalls).toEqual([]);
		expect(f.calls).not.toContain("request");
		await expect(f.runtime.retirementGenerationStatus(tenant, operation)).resolves.toMatchObject({
			status: "retired",
		});
		expect(f.statusCalls).toEqual([{ sessionId: tenant.sessionId, generation: tenant.generation }]);
		expect(accesses).toContainEqual({ ...operation, kind: "adoption-proof" });
		expect(accesses).toContainEqual({ ...operation, kind: "retirement", action: "close" });
		expect(accesses).toContainEqual({ ...operation, kind: "retirement", action: "generation-status" });
		expect(accesses.every(Object.isFrozen)).toBe(true);
		await f.runtime.stop();
	});

	test("promotes the same proof token only after active acquisition and rechecks revocation before buffered delivery", async () => {
		let active = false;
		const accesses: ManagedSdkAccess[] = [];
		const f = fixture({
			fence: (_key, access) => {
				accesses.push(access);
				return access.kind === "active" ? active : true;
			},
		});
		await f.runtime.start();
		const token = await f.runtime.proveLifecycleTenant(tenant, operationIdentity());
		expect(() => f.runtime.prepareFrameSubscription(token, "turn", () => {})).toThrow();
		active = true;
		expect(await f.runtime.acquireAttachment(tenant)).toBe(token);
		await expect(f.runtime.request(token, { type: "query_request", query: "session.state" })).resolves.toEqual({
			ok: true,
		});
		const received: number[] = [];
		const subscription = f.runtime.prepareFrameSubscription(token, "turn", observed => {
			received.push(observed.frame.seq!);
		});
		active = false;
		accesses.length = 0;
		await f.emit(observedFrame(1));
		await expect(subscription.drain()).rejects.toThrow("fence was lost");
		subscription.bind({ commandId: "queued-command" });
		await expect(subscription.drain()).rejects.toThrow("fence was lost");
		expect(received).toEqual([]);
		expect(accesses).toEqual([{ kind: "active" }]);
		subscription();
		await f.runtime.stop();
	});

	test("flushes earlier authorized pre-ack frames before a later queued frame at binding", async () => {
		const f = fixture();
		f.runtime.registerTenant(tenant);
		await f.runtime.start();
		const received: number[] = [];
		const token = await f.runtime.acquireAttachment(tenant);
		const subscription = f.runtime.prepareFrameSubscription(token, "turn", observed => {
			received.push(observed.frame.seq!);
		});
		await f.emit(observedFrame(1));
		await subscription.drain();
		expect(received).toEqual([]);
		await f.emit(observedFrame(2));
		subscription.bind({ commandId: "queued-command" });
		await subscription.drain();
		expect(received).toEqual([1, 2]);
		subscription();
		await f.runtime.stop();
	});

	test("rechecks active authority between buffered listener deliveries", async () => {
		let allowed = true;
		const f = fixture({ fence: (_key, access) => access.kind === "active" && allowed });
		f.runtime.registerTenant(tenant);
		await f.runtime.start();
		const received: number[] = [];
		const subscription = f.runtime.prepareFrameSubscription(
			await f.runtime.acquireAttachment(tenant),
			"turn",
			observed => {
				received.push(observed.frame.seq!);
				allowed = false;
			},
		);
		await f.emit(observedFrame(1));
		await subscription.drain();
		await f.emit(observedFrame(2));
		await subscription.drain();
		subscription.bind({ commandId: "queued-command" });
		await expect(subscription.drain()).rejects.toThrow("fence was lost");
		expect(received).toEqual([1]);
		subscription();
		await f.runtime.stop();
	});

	test("validates durable operation identities and retirement request-key binding before effects", async () => {
		let authorized = 0;
		const f = fixture({
			fence: () => {
				authorized += 1;
				return true;
			},
		});
		await f.runtime.start();
		f.runtime.registerTenant(tenant);
		for (const change of [
			{ operationId: "" },
			{ operationId: " x" },
			{ requestKey: "" },
			{ requestKey: "bad\nkey" },
			{ payloadHash: "a".repeat(63) },
			{ payloadHash: "A".repeat(64) },
			{ payloadHash: `sha256:${"a".repeat(64)}` },
			{ payloadHash: `${"a".repeat(64)}\n` },
		]) {
			const operation = { ...operationIdentity(), ...change };
			await expect(f.runtime.proveLifecycleTenant(tenant, operation)).rejects.toBeInstanceOf(TypeError);
			await expect(f.runtime.retireLifecycleSession(tenant, closeRequest(), operation)).rejects.toBeInstanceOf(
				TypeError,
			);
			await expect(f.runtime.retirementGenerationStatus(tenant, operation)).rejects.toBeInstanceOf(TypeError);
		}
		await expect(
			f.runtime.retireLifecycleSession(tenant, closeRequest(), { ...operationIdentity(), requestKey: "other" }),
		).rejects.toThrow("request key");
		expect(authorized).toBe(0);
		expect(f.calls).toEqual(["start"]);
		expect(f.closeCalls).toEqual([]);
		expect(f.statusCalls).toEqual([]);
		await f.runtime.stop();
	});

	test.each(["adoption", "retirement", "status"] as const)(
		"rechecks %s purpose revocation after an awaited boundary",
		async mode => {
			let allowed = true;
			const revoke = async () => {
				allowed = false;
			};
			const f = fixture({
				fence: (_key, access) => access.kind !== "active" && allowed,
				reconcile: mode === "adoption" ? revoke : undefined,
				close: async request => {
					await revoke();
					return { ok: true, operation: "session.close", result: { sessionId: request.target.sessionId } };
				},
				generationStatus: async () => {
					await revoke();
					return { status: "unknown", reason: "session_not_observed" };
				},
			});
			await f.runtime.start();
			f.runtime.registerTenant(tenant);
			const result =
				mode === "adoption"
					? f.runtime.proveLifecycleTenant(tenant, operationIdentity())
					: mode === "retirement"
						? f.runtime.retireLifecycleSession(tenant, closeRequest(), operationIdentity())
						: f.runtime.retirementGenerationStatus(tenant, operationIdentity());
			await expect(result).rejects.toThrow("fence was lost");
			expect(f.closeCalls).toHaveLength(mode === "retirement" ? 1 : 0);
			await expect(f.runtime.acquireAttachment(tenant)).rejects.toThrow("fence was lost");
			await f.runtime.stop();
		},
	);

	test("rechecks adoption authorization before a serialized reconcile effect", async () => {
		const entered = deferred<void>();
		const release = deferred<void>();
		const admitted = deferred<void>();
		let allowed = true;
		const f = fixture({
			fence: (_key, access) => {
				admitted.resolve();
				return access.kind === "adoption-proof" && allowed;
			},
			reconcile: async () => {
				entered.resolve();
				await release.promise;
			},
		});
		await f.runtime.start();
		const prior = f.runtime.reconcile();
		await entered.promise;
		const proving = f.runtime.proveLifecycleTenant(tenant, operationIdentity()).catch(error => error);
		await admitted.promise;
		allowed = false;
		release.resolve();
		await prior;
		expect(await proving).toBeInstanceOf(Error);
		expect(f.calls.filter(call => call === "reconcile")).toHaveLength(1);
		await f.runtime.stop();
	});

	test.each(["adoption", "retirement", "status"] as const)(
		"rejects %s when registration is replaced during purpose authorization",
		async mode => {
			const entered = deferred<void>();
			const release = deferred<boolean>();
			const f = fixture({
				fence: () => {
					entered.resolve();
					return release.promise;
				},
			});
			await f.runtime.start();
			f.runtime.registerTenant(tenant);
			const pending = (
				mode === "adoption"
					? f.runtime.proveLifecycleTenant(tenant, operationIdentity())
					: mode === "retirement"
						? f.runtime.retireLifecycleSession(tenant, closeRequest(), operationIdentity())
						: f.runtime.retirementGenerationStatus(tenant, operationIdentity())
			).catch(error => error);
			await entered.promise;
			f.runtime.unregisterTenant(tenant);
			f.runtime.registerTenant({ ...tenant, leaseId: "replacement" });
			release.resolve(true);
			expect(await pending).toBeInstanceOf(Error);
			expect(f.closeCalls).toEqual([]);
			expect(f.statusCalls).toEqual([]);
			expect(f.calls).toEqual(["start"]);
			await f.runtime.stop();
		},
	);

	test("a close-only grant does not authorize generation status or caller-supplied active-purpose overrides", async () => {
		const seen: ManagedSdkAccess[] = [];
		const f = fixture({
			fence: (_key, access) => {
				seen.push(access);
				return access.kind === "retirement" && access.action === "close";
			},
		});
		await f.runtime.start();
		f.runtime.registerTenant(tenant);
		await expect(f.runtime.retirementGenerationStatus(tenant, operationIdentity())).rejects.toThrow("fence was lost");
		const attempted = { ...closeRequest(), access: { ...operationIdentity(), kind: "retirement", action: "close" } };
		await expect(f.runtime.closeLifecycleSession(tenant, attempted)).rejects.toThrow("fence was lost");
		expect(seen).toEqual([
			{ ...operationIdentity(), kind: "retirement", action: "generation-status" },
			{ kind: "active" },
		]);
		expect(f.closeCalls).toEqual([]);
		expect(f.statusCalls).toEqual([]);
		await f.runtime.stop();
	});

	test("adoption proof cannot retain active subscription eligibility across registration replacement", async () => {
		let active = true;
		const f = fixture({ fence: (_key, access) => (access.kind === "active" ? active : true) });
		await f.runtime.start();
		f.runtime.registerTenant(tenant);
		const original = await f.runtime.acquireAttachment(tenant);
		f.runtime.unregisterTenant(tenant);
		active = false;
		const proof = await f.runtime.proveLifecycleTenant(tenant, operationIdentity());
		expect(proof).not.toBe(original);
		expect(original.isCurrent()).toBe(false);
		expect(() => f.runtime.prepareFrameSubscription(proof, "turn", () => {})).toThrow("Active tenant acquisition");
		await f.runtime.stop();
	});

	test("bounded stop invalidates queued proof authorization before a late reconcile", async () => {
		const entered = deferred<void>();
		const release = deferred<boolean>();
		const f = fixture({
			drainTimeoutMs: 15,
			fence: () => {
				entered.resolve();
				return release.promise;
			},
		});
		await f.runtime.start();
		const proof = f.runtime.proveLifecycleTenant(tenant, operationIdentity()).catch(error => error);
		await entered.promise;
		await expect(f.runtime.stop()).rejects.toMatchObject({ code: "drain_timeout" });
		expect(await proof).toMatchObject({ code: "runtime_interrupted" });
		release.resolve(true);
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(f.calls).toEqual(["start", "stop"]);
	});
	test("issues stable manager-only capabilities and revokes tokens after replacement or registration loss", async () => {
		const f = fixture();
		f.runtime.registerTenant(tenant);
		await f.runtime.start();
		const token = await f.runtime.acquireAttachment(tenant);
		expect(Object.keys(token).sort()).toEqual(["generation", "isCurrent", "tenant"]);
		expect(token).not.toHaveProperty("attachment");
		expect(token).not.toHaveProperty("send");
		expect(await f.runtime.acquireAttachment(tenant)).toBe(token);
		const reordered = {
			generation: tenant.generation,
			sessionId: tenant.sessionId,
			epoch: tenant.epoch,
			leaseId: tenant.leaseId,
			chatId: tenant.chatId,
			canonicalWorkspace: tenant.canonicalWorkspace,
			projectId: tenant.projectId,
			principalId: tenant.principalId,
		};
		expect(await f.runtime.acquireAttachment(reordered)).toBe(token);
		await expect(f.runtime.request({ ...token }, {})).rejects.toThrow("Manager-issued");
		f.replaceAttachment();
		expect(token.isCurrent()).toBe(false);
		const replacement = await f.runtime.acquireAttachment(tenant);
		expect(replacement).not.toBe(token);
		f.runtime.unregisterTenant(tenant);
		f.runtime.registerTenant(tenant);
		expect(replacement.isCurrent()).toBe(false);
		await f.runtime.stop();
	});

	test.each(["missing", "denied"] as const)("fails closed with %s prepared and registered fences", async mode => {
		const f = fixture({
			omitTenantFence: mode === "missing",
			omitPreparedFence: mode === "missing",
			fence: () => false,
			preparedFence: () => false,
		});
		f.runtime.registerTenant(tenant);
		await f.runtime.start();
		await expect(f.runtime.acquireAttachment(tenant)).rejects.toThrow("fence was lost");
		await expect(f.runtime.closeLifecycleSession(tenant, closeRequest())).rejects.toThrow("fence was lost");
		await expect(f.runtime.listLifecycleSessions(tenant, listRequest())).rejects.toThrow("fence was lost");
		await expect(f.runtime.proveLifecycleTenant(tenant, operationIdentity())).rejects.toThrow("fence was lost");
		await expect(f.runtime.retireLifecycleSession(tenant, closeRequest(), operationIdentity())).rejects.toThrow(
			"fence was lost",
		);
		await expect(f.runtime.retirementGenerationStatus(tenant, operationIdentity())).rejects.toThrow("fence was lost");
		await expect(
			f.runtime.createPreparedExternalLifecycleSession(preparedAuthority(), createRequest()),
		).rejects.toThrow("fence was lost");
		expect(f.createCalls).toEqual([]);
		expect(f.closeCalls).toEqual([]);
		expect(f.listCalls).toEqual([]);
		await f.runtime.stop();
	});

	test("validates prepared actor, key and workspace without inventing a session identity", async () => {
		const seen: ManagedPreparedTurnAuthority[] = [];
		const f = fixture({
			preparedFence: authority => {
				seen.push(authority);
				return true;
			},
		});
		await f.runtime.start();
		for (const changed of [
			{ actor: { ...createRequest().actor, id: "foreign" } },
			{ actor: { ...createRequest().actor, namespace: "foreign" } },
			{ requestKey: "foreign" },
			{ target: { kind: "existing_path" as const, path: "/foreign" } },
		])
			await expect(
				f.runtime.createPreparedExternalLifecycleSession(preparedAuthority(), { ...createRequest(), ...changed }),
			).rejects.toThrow();
		await expect(
			f.runtime.createPreparedExternalLifecycleSession(
				{ ...preparedAuthority(), sessionId: "invented" } as never,
				createRequest(),
			),
		).rejects.toThrow();
		expect(f.createCalls).toEqual([]);
		await f.runtime.createPreparedExternalLifecycleSession(preparedAuthority(), createRequest());
		expect(seen).toEqual([preparedAuthority(), preparedAuthority()]);
		expect(f.createCalls[0]!.readinessTimeoutMs!).toBeLessThanOrEqual(500);
		await f.runtime.stop();
	});

	test.each(["prepared", "registered"] as const)(
		"never dispatches after a late %s authorization deadline",
		async kind => {
			const fence = deferred<boolean>();
			const entered = deferred<void>();
			const wait = () => {
				entered.resolve();
				return fence.promise;
			};
			const f = fixture({ fence: wait, preparedFence: wait });
			f.runtime.registerTenant(tenant);
			await f.runtime.start();
			const call =
				kind === "prepared"
					? f.runtime.createPreparedExternalLifecycleSession(preparedAuthority(), {
							...createRequest(),
							readinessTimeoutMs: 15,
						})
					: f.runtime.closeLifecycleSession(tenant, { ...closeRequest(), timeoutMs: 15 });
			await entered.promise;
			await expect(call).rejects.toMatchObject({ code: "timeout" });
			fence.resolve(true);
			await new Promise(resolve => setTimeout(resolve, 0));
			expect(f.createCalls).toEqual([]);
			expect(f.closeCalls).toEqual([]);
			await f.runtime.stop();
		},
	);

	test("rejects a prepared lease lost during asynchronous admission", async () => {
		const fence = deferred<boolean>();
		const f = fixture({ preparedFence: () => fence.promise });
		await f.runtime.start();
		const creating = f.runtime.createPreparedExternalLifecycleSession(preparedAuthority(), createRequest());
		fence.resolve(false);
		await expect(creating).rejects.toThrow("fence was lost");
		expect(f.createCalls).toEqual([]);
		await f.runtime.stop();
	});

	test("binds external resume to the complete session id and workspace and rejects broad list targets", async () => {
		const f = fixture();
		f.runtime.registerTenant(tenant);
		await f.runtime.start();
		const resume: ResumeRequest = {
			actor: closeRequest().actor,
			capability: "session.resume",
			requestKey: "resume",
			target: { sessionIdOrPrefix: tenant.sessionId, path: tenant.canonicalWorkspace },
			readinessTimeoutMs: 500,
		};
		for (const target of [
			{ ...resume.target, sessionIdOrPrefix: "session" },
			{ ...resume.target, path: "/foreign" },
		])
			await expect(f.runtime.resumeExternalLifecycleSession(tenant, { ...resume, target })).rejects.toThrow();
		for (const target of [
			undefined,
			{ cwd: tenant.canonicalWorkspace },
			{ ...listRequest().target, scope: { kind: "all" } },
			{ ...listRequest().target, resolveSessionId: "foreign" },
		])
			await expect(f.runtime.listLifecycleSessions(tenant, { ...listRequest(), target } as never)).rejects.toThrow();
		expect(f.resumeCalls).toEqual([]);
		expect(f.listCalls).toEqual([]);
		await f.runtime.resumeExternalLifecycleSession(tenant, resume);
		expect(f.resumeCalls[0]?.target).toEqual(resume.target);
		await f.runtime.stop();
	});

	test("filters declared list authority without leaking global evidence", async () => {
		const exact = {
			sessionId: tenant.sessionId,
			endpointGeneration: tenant.generation,
			cwd: tenant.canonicalWorkspace,
		};
		const f = fixture({
			list: async () => ({
				ok: true,
				operation: "session.list",
				result: {
					indexSeq: 3,
					sessions: [
						exact,
						{ ...exact, sessionId: "foreign" },
						{ ...exact, endpointGeneration: 8 },
						{ ...exact, cwd: "/foreign" },
					],
					warnings: ["foreign workspace secret"],
				},
			}),
		});
		f.runtime.registerTenant(tenant);
		await f.runtime.start();
		const result = await f.runtime.listLifecycleSessions(tenant, {
			...listRequest(),
			target: { ...listRequest().target, cursor: "opaque" },
		});
		expect(result).toEqual({
			ok: true,
			operation: "session.list",
			result: { indexSeq: 3, sessions: [exact], warnings: [] },
		});
		await f.runtime.stop();
	});

	test("rejects unfilterable list output and always blocks public delete before effect", async () => {
		const f = fixture({
			list: async () => ({ ok: true, operation: "session.list", result: { items: ["foreign"] } }) as never,
		});
		f.runtime.registerTenant(tenant);
		await f.runtime.start();
		await expect(f.runtime.listLifecycleSessions(tenant, listRequest())).rejects.toMatchObject({
			code: "invalid_result",
		});
		await expect(
			f.runtime.deleteLifecycleSession(tenant, {
				actor: closeRequest().actor,
				capability: "session.delete",
				requestKey: "delete",
				target: { sessionId: tenant.sessionId },
			}),
		).rejects.toMatchObject({ code: "exact_delete_authority_unavailable" });
		expect(f.calls).not.toContain("delete");
		await f.runtime.stop();
	});

	test.each(["replacement", "lease", "unregister"] as const)(
		"drops queued frames after %s and records failed observation",
		async change => {
			let allowed = true;
			const f = fixture({ fence: () => allowed });
			f.runtime.registerTenant(tenant);
			await f.runtime.start();
			const first = deferred<void>();
			const release = deferred<void>();
			const received: number[] = [];
			const subscription = f.runtime.subscribeFrames(
				await f.runtime.acquireAttachment(tenant),
				"turn",
				{ commandId: "queued-command" },
				async value => {
					received.push(value.frame.seq!);
					first.resolve();
					await release.promise;
				},
			);
			await f.emit(observedFrame(1));
			await first.promise;
			await f.emit(observedFrame(2));
			if (change === "replacement") f.replaceAttachment();
			else if (change === "lease") allowed = false;
			else f.runtime.unregisterTenant(tenant);
			release.resolve();
			await expect(subscription.drain()).rejects.toThrow();
			expect(received).toEqual([1]);
			expect(f.runtime.frameDiagnostics().listenerError).toBe(1);
			subscription();
			await f.runtime.stop();
		},
	);

	test.each(["request", "lifecycle", "authorization"] as const)(
		"bounds shutdown for a hanging %s without later dispatch",
		async kind => {
			const entered = deferred<void>();
			const result = deferred<Record<string, unknown>>();
			const fence = deferred<boolean>();
			let blockFence = false;
			const f = fixture({
				drainTimeoutMs: 15,
				fence: () => {
					if (!blockFence) return true;
					entered.resolve();
					return fence.promise;
				},
				request: () => {
					entered.resolve();
					return result.promise;
				},
				close: async () => {
					entered.resolve();
					await result.promise;
					return { ok: true, operation: "session.close", result: { sessionId: tenant.sessionId } };
				},
			});
			f.runtime.registerTenant(tenant);
			await f.runtime.start();
			const token = await f.runtime.acquireAttachment(tenant);
			blockFence = kind === "authorization";
			const pending = (
				kind === "request"
					? f.runtime.request(token, {}, { timeoutMs: 500 })
					: f.runtime.closeLifecycleSession(tenant, closeRequest())
			).catch(error => error);
			await entered.promise;
			const stopped = f.runtime.stop();
			await expect(stopped).rejects.toMatchObject({ code: "drain_timeout" });
			expect(await pending).toMatchObject({ code: "runtime_interrupted" });
			expect(f.calls.filter(call => call === "stop")).toHaveLength(1);
			fence.resolve(true);
			result.resolve({ ok: true });
			await new Promise(resolve => setTimeout(resolve, 0));
			if (kind === "authorization") expect(f.closeCalls).toEqual([]);
			expect(token.isCurrent()).toBe(false);
		},
	);

	test("bounds a hanging Router stop and never remotely closes sessions", async () => {
		const f = fixture({ drainTimeoutMs: 15, stop: () => new Promise(() => {}) });
		await f.runtime.start();
		await expect(f.runtime.stop()).rejects.toMatchObject({ code: "drain_timeout" });
		expect(f.runtime.state).toBe("failed");
		expect(f.closeCalls).toEqual([]);
	});

	test("never starts tracked work after stop wins the admission microtask", async () => {
		const f = fixture();
		f.runtime.registerTenant(tenant);
		await f.runtime.start();
		const call = f.runtime.closeLifecycleSession(tenant, closeRequest()).catch(error => error);
		await f.runtime.stop();
		expect(await call).toMatchObject({ code: "runtime_interrupted" });
		expect(f.closeCalls).toEqual([]);
	});

	test("settles an already dispatched request during drain while rejecting new work", async () => {
		const entered = deferred<void>();
		const response = deferred<Record<string, unknown>>();
		const f = fixture({
			request: () => {
				entered.resolve();
				return response.promise;
			},
		});
		f.runtime.registerTenant(tenant);
		await f.runtime.start();
		const token = await f.runtime.acquireAttachment(tenant);
		const accepted = f.runtime.request(token, {});
		await entered.promise;
		const stopping = f.runtime.stop();
		await expect(f.runtime.request(token, {})).rejects.toMatchObject({ code: "runtime_interrupted" });
		response.resolve({ ok: true });
		await expect(accepted).resolves.toEqual({ ok: true });
		await stopping;
		expect(f.calls.filter(call => call === "request")).toHaveLength(1);
	});

	test("invalidates a prepared authorization still pending when drain expires", async () => {
		const entered = deferred<void>();
		const fence = deferred<boolean>();
		const f = fixture({
			drainTimeoutMs: 15,
			preparedFence: () => {
				entered.resolve();
				return fence.promise;
			},
		});
		await f.runtime.start();
		const call = f.runtime
			.createPreparedExternalLifecycleSession(preparedAuthority(), createRequest())
			.catch(error => error);
		await entered.promise;
		await expect(f.runtime.stop()).rejects.toMatchObject({ code: "drain_timeout" });
		expect(await call).toMatchObject({ code: "runtime_interrupted" });
		fence.resolve(true);
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(f.createCalls).toEqual([]);
	});

	test("bounds stop while Router start or a queued delivery fence never finishes", async () => {
		const starting = fixture({ drainTimeoutMs: 15, start: () => new Promise(() => {}) });
		void starting.runtime.start();
		await expect(starting.runtime.stop()).rejects.toMatchObject({ code: "drain_timeout" });
		expect(starting.calls).toEqual(["start", "stop"]);
		let blocked = false;
		const fence = deferred<boolean>();
		const f = fixture({ drainTimeoutMs: 15, fence: () => (blocked ? fence.promise : true) });
		f.runtime.registerTenant(tenant);
		await f.runtime.start();
		let delivered = false;
		const token = await f.runtime.acquireAttachment(tenant);
		const subscription = f.runtime.subscribeFrames(token, "turn", { commandId: "queued-command" }, () => {
			delivered = true;
		});
		blocked = true;
		await f.emit(observedFrame(1));
		await expect(f.runtime.stop()).rejects.toMatchObject({ code: "drain_timeout" });
		fence.resolve(true);
		await expect(subscription.drain()).rejects.toThrow();
		expect(delivered).toBe(false);
	});

	test("does not return lifecycle success as proof after the live tenant fence is lost", async () => {
		let allowed = true;
		const f = fixture({
			fence: () => allowed,
			close: async request => {
				allowed = false;
				return { ok: true, operation: "session.close", result: { sessionId: request.target.sessionId } };
			},
		});
		f.runtime.registerTenant(tenant);
		await f.runtime.start();
		await expect(f.runtime.closeLifecycleSession(tenant, closeRequest())).rejects.toThrow("fence was lost");
		expect(f.closeCalls).toHaveLength(1);
		await f.runtime.stop();
	});

	test("shares start/stop races, admits bootstrap only while starting, and records start failure", async () => {
		const startGate = deferred<void>();
		const active = fixture({ start: async () => await startGate.promise });
		active.runtime.registerTenant(tenant);
		const firstStart = active.runtime.start();
		expect(active.runtime.start()).toBe(firstStart);
		expect(active.runtime.bootstrapAdmissionOpen).toBe(true);
		await expect(active.runtime.acquireAttachment(tenant)).resolves.toMatchObject({ generation: 7 });
		const stopping = active.runtime.stop();
		expect(active.runtime.bootstrapAdmissionOpen).toBe(false);
		startGate.resolve();
		await Promise.all([firstStart, stopping]);
		expect(active.runtime.state).toBe("stopped");
		expect(active.calls).toEqual(["start", "stop"]);

		const failed = fixture({
			start: async () => {
				throw new Error("start failed");
			},
		});
		await expect(failed.runtime.start()).rejects.toThrow("start failed");
		expect(failed.runtime.state).toBe("failed");
	});

	test("requires full registered tenant fencing, exact positive generation, and a current attachment", async () => {
		const current = fixture();
		await current.runtime.start();
		await expect(current.runtime.acquireAttachment(tenant)).rejects.toThrow("not registered");
		current.runtime.registerTenant(tenant);
		const managed = await current.runtime.acquireAttachment(tenant);
		await expect(current.runtime.acquireAttachment({ ...tenant, generation: 0 })).rejects.toThrow(
			"positive generation",
		);
		await expect(current.runtime.acquireAttachment({ ...tenant, leaseId: "wrong" })).rejects.toThrow(
			"not registered",
		);
		await expect(current.runtime.request({ ...managed, generation: 8 }, {})).rejects.toThrow(
			"Exact tenant generation",
		);
		(current.attachment as unknown as { isCurrent: () => boolean }).isCurrent = () => false;
		await expect(current.runtime.request(managed, {})).rejects.toThrow("Current Router attachment");
		await current.runtime.stop();

		const fenced = fixture({ fence: () => false });
		fenced.runtime.registerTenant(tenant);
		await fenced.runtime.start();
		await expect(fenced.runtime.acquireAttachment(tenant)).rejects.toThrow("fence was lost");
		await fenced.runtime.stop();
	});

	test("reserves one complete tenant for each session generation and rejects foreign boundaries", async () => {
		const current = fixture();
		current.runtime.registerTenant(tenant);
		expect(() => current.runtime.registerTenant({ ...tenant, leaseId: "foreign-lease" })).toThrow("already owned");
		await current.runtime.start();
		const managed = await current.runtime.acquireAttachment(tenant);
		const foreign = { ...managed, tenant: { ...tenant, leaseId: "foreign-lease" } };
		await expect(current.runtime.request(foreign, {})).rejects.toThrow("not registered");
		expect(() =>
			current.runtime.subscribeFrames(foreign, "turn", { commandId: "command-foreign" }, () => {}),
		).toThrow("Registered current tenant attachment");
		await current.emit(
			{
				body: {},
				name: "event",
				sessionId: tenant.sessionId,
				generation: tenant.generation,
				commandId: "command-foreign",
				seq: 1,
			},
			current.foreignAttachment,
		);
		expect(current.runtime.frameDiagnostics().foreign).toBe(1);
		await current.runtime.stop();
	});

	test("delegates request settlement solely to Router and preserves dispatch hook order", async () => {
		const current = fixture();
		current.runtime.registerTenant(tenant);
		await current.runtime.start();
		const managed = await current.runtime.acquireAttachment(tenant);
		const order: string[] = [];
		await expect(
			current.runtime.request(
				managed,
				{ type: "query_request" },
				{
					beforeDispatch: () => order.push("before"),
					onDispatch: () => order.push("after"),
				},
			),
		).resolves.toEqual({ ok: true });
		expect(order).toEqual(["before", "after"]);
		expect(current.calls).toContain("request");
		await current.runtime.stop();
	});

	test("multiplexes only matching frames with duplicate, foreign, overflow, and cleanup classification", async () => {
		const current = fixture({ maxFrames: 1 });
		current.runtime.registerTenant(tenant);
		await current.runtime.start();
		const managed = await current.runtime.acquireAttachment(tenant);
		const received: string[] = [];
		const listenerEntered = deferred<void>();
		const releaseListener = deferred<void>();
		const unsubscribe = current.runtime.subscribeFrames(managed, "turn", { commandId: "command-1" }, async frame => {
			received.push(String(frame.frame.seq));
			listenerEntered.resolve();
			await releaseListener.promise;
		});
		const matching = {
			body: {},
			name: "event",
			sessionId: tenant.sessionId,
			generation: tenant.generation,
			commandId: "command-1",
			seq: 1,
		};
		await current.emit(matching);
		await listenerEntered.promise;
		await current.emit(matching);
		await current.emit({ ...matching, sessionId: "foreign", seq: 2 });
		await current.emit({ ...matching, seq: 3 });
		unsubscribe();
		unsubscribe();
		await current.emit({ ...matching, seq: 4 });
		releaseListener.resolve();
		await Promise.resolve();
		expect(received).toEqual(["1"]);
		expect(current.runtime.frameDiagnostics()).toMatchObject({ duplicate: 1, foreign: 1, overflow: 1, late: 1 });
		await current.runtime.stop();
	});

	test("forwards exact-generation retirement status without retaining credential data", async () => {
		const current = fixture();
		current.runtime.registerTenant(tenant);
		await current.runtime.start();
		await expect(current.runtime.generationStatus(tenant)).resolves.toMatchObject({ status: "retired" });
		expect(JSON.stringify(current.runtime.frameDiagnostics())).not.toContain("token");
		expect(JSON.stringify(current.runtime.frameDiagnostics())).not.toContain("url");
		await current.runtime.dispose();
	});

	test("rejects lifecycle calls without complete managed tenant authority", async () => {
		const current = fixture();
		current.runtime.registerTenant(tenant);
		await current.runtime.start();
		await expect(
			current.runtime.createLifecycleSession({
				actor: { id: tenant.principalId, namespace: "adapter" },
				capability: "session.create",
				requestKey: "create-1",
				target: { cwd: tenant.canonicalWorkspace },
			} as never),
		).rejects.toThrow("Complete managed tenant authority");
		expect("lifecycleService" in current.runtime).toBeFalse();
		await current.runtime.stop();
	});

	test("rejects tenantless close even with paired endpoint authority", async () => {
		const current = fixture();
		current.runtime.registerTenant(tenant);
		await current.runtime.start();
		try {
			await expect(current.runtime.closeLifecycleSession(closeRequest() as never)).rejects.toThrow(
				"Complete managed tenant authority",
			);
			await expect(current.runtime.closeLifecycleSession({ request: closeRequest() } as never)).rejects.toThrow(
				"Complete managed tenant authority",
			);
			await expect(
				current.runtime.closeLifecycleSession({
					...closeRequest(),
					tenant: { sessionId: tenant.sessionId },
				} as never),
			).rejects.toThrow("Complete managed tenant authority");
			expect(current.closeCalls).toHaveLength(0);
		} finally {
			await current.runtime.dispose();
		}
	});

	test("rejects close without registration or with foreign tenant, session, generation, or fence identity", async () => {
		const current = fixture();
		await current.runtime.start();
		try {
			await expect(current.runtime.closeLifecycleSession(tenant, closeRequest())).rejects.toThrow("not registered");
			current.runtime.registerTenant(tenant);
			for (const foreign of [
				{ principalId: "foreign-principal" },
				{ projectId: "foreign-project" },
				{ canonicalWorkspace: "/foreign-workspace" },
				{ chatId: "foreign-chat" },
				{ sessionId: "foreign-session" },
				{ generation: tenant.generation + 1 },
				{ leaseId: "foreign-lease" },
				{ epoch: "foreign-epoch" },
			]) {
				await expect(
					current.runtime.closeLifecycleSession({ ...tenant, ...foreign }, closeRequest()),
				).rejects.toThrow("not registered");
			}
			await expect(
				current.runtime.closeLifecycleSession(tenant, {
					...closeRequest(),
					actor: { id: "foreign-principal", namespace: "adapter" },
				}),
			).rejects.toThrow("Lifecycle actor does not match");
			expect(current.closeCalls).toHaveLength(0);
		} finally {
			await current.runtime.dispose();
		}
	});

	test.each([
		{ name: "absent target", target: undefined },
		{ name: "empty target", target: {} },
		{
			name: "missing session",
			target: {
				endpointGeneration: tenant.generation,
				endpointIncarnation: closeRequest().target.endpointIncarnation,
			},
		},
		{ name: "foreign session", target: { ...closeRequest().target, sessionId: "foreign-session" } },
		{ name: "session-ID-only", target: { sessionId: tenant.sessionId } },
		{
			name: "incarnation without generation",
			target: { sessionId: tenant.sessionId, endpointIncarnation: closeRequest().target.endpointIncarnation },
		},
		...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, tenant.generation + 1, String(tenant.generation), null].map(
			generation => ({
				name: `invalid or foreign generation ${generation}`,
				target: { ...closeRequest().target, endpointGeneration: generation },
			}),
		),
	])("rejects close with $name before SDK mutation", async ({ target }) => {
		const current = fixture();
		current.runtime.registerTenant(tenant);
		await current.runtime.start();
		try {
			await expect(
				current.runtime.closeLifecycleSession(tenant, { ...closeRequest(), target } as never),
			).rejects.toThrow(/target.*(generation|managed tenant authority)/i);
			expect(current.closeCalls).toHaveLength(0);
		} finally {
			await current.runtime.dispose();
		}
	});

	test.each([
		undefined,
		null,
		"",
		"a".repeat(63),
		"a".repeat(65),
		"A".repeat(64),
		"g".repeat(64),
		`${"a".repeat(64)}\n`,
		123,
	])(
		"fails closed with an actionable unavailable diagnostic for absent or invalid incarnation %j",
		async endpointIncarnation => {
			const current = fixture();
			current.runtime.registerTenant(tenant);
			await current.runtime.start();
			try {
				await expect(
					current.runtime.closeLifecycleSession(tenant, {
						...closeRequest(),
						target: { ...closeRequest().target, endpointIncarnation },
					} as never),
				).rejects.toMatchObject({
					code: "exact_close_authority_unavailable",
					message: expect.stringContaining("SDK 0.16.4 public binding/lifecycle results do not supply it"),
				});
				expect(current.closeCalls).toHaveLength(0);
			} finally {
				await current.runtime.dispose();
			}
		},
	);

	test.each(["explicit", "wrapped", "flat"] as const)(
		"forwards a supplied opaque pair untouched with %s tenant admission",
		async shape => {
			let fenceChecks = 0;
			const current = fixture({
				fence: () => {
					fenceChecks += 1;
					return true;
				},
			});
			current.runtime.registerTenant(tenant);
			await current.runtime.start();
			const request = closeRequest();
			try {
				const outcome =
					shape === "explicit"
						? await current.runtime.closeLifecycleSession(tenant, request)
						: shape === "wrapped"
							? await current.runtime.closeLifecycleSession({ tenant, request })
							: await current.runtime.closeLifecycleSession({ tenant, ...request });
				expect(outcome).toEqual({ ok: true, operation: "session.close", result: { sessionId: tenant.sessionId } });
				expect(fenceChecks).toBe(2);
				expect(current.closeCalls).toHaveLength(1);
				expect(current.closeCalls[0]?.target).toEqual(request.target);
				expect(current.closeCalls[0]?.requestKey).toBe(request.requestKey);
				expect(current.closeCalls[0]?.timeoutMs).toBeGreaterThan(0);
				expect(current.closeCalls[0]!.timeoutMs!).toBeLessThanOrEqual(request.timeoutMs!);
				expect(request.timeoutMs).toBe(500);
				expect(current.calls).toEqual(["start"]);
			} finally {
				await current.runtime.dispose();
			}
		},
	);

	test("does not dispatch paired close when the tenant fence is lost", async () => {
		const current = fixture({ fence: () => false });
		current.runtime.registerTenant(tenant);
		await current.runtime.start();
		try {
			await expect(current.runtime.closeLifecycleSession(tenant, closeRequest())).rejects.toThrow("fence was lost");
			expect(current.closeCalls).toHaveLength(0);
		} finally {
			await current.runtime.dispose();
		}
	});

	test.each(["fence loss", "unregistration", "registration replacement"] as const)(
		"rejects paired close after %s during authorization",
		async change => {
			const fenceEntered = deferred<void>();
			const fenceResult = deferred<boolean>();
			const current = fixture({
				fence: async () => {
					fenceEntered.resolve();
					return await fenceResult.promise;
				},
			});
			current.runtime.registerTenant(tenant);
			await current.runtime.start();
			try {
				const closing = current.runtime.closeLifecycleSession(tenant, closeRequest());
				await fenceEntered.promise;
				expect(current.closeCalls).toHaveLength(0);
				if (change !== "fence loss") current.runtime.unregisterTenant(tenant);
				if (change === "registration replacement")
					current.runtime.registerTenant({ ...tenant, leaseId: "replacement-lease" });
				fenceResult.resolve(change !== "fence loss");
				await expect(closing).rejects.toThrow(change === "fence loss" ? "fence was lost" : "registration changed");
				expect(current.closeCalls).toHaveLength(0);
			} finally {
				await current.runtime.dispose();
			}
		},
	);

	test("exposes listener failures through subscription drain and diagnostics", async () => {
		const current = fixture();
		current.runtime.registerTenant(tenant);
		await current.runtime.start();
		const managed = await current.runtime.acquireAttachment(tenant);
		const unsubscribe = current.runtime.subscribeFrames(managed, "turn", { commandId: "command-error" }, () => {
			throw new Error("listener failed");
		});
		await current.emit({
			body: {},
			name: "event",
			sessionId: tenant.sessionId,
			generation: tenant.generation,
			commandId: "command-error",
			seq: 1,
		});
		await expect(unsubscribe.drain()).rejects.toThrow("listener failed");
		expect(current.runtime.frameDiagnostics().listenerError).toBe(1);
		unsubscribe();
		await current.runtime.stop();
	});
});
