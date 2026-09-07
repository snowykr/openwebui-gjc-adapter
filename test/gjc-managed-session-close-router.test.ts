import { describe, expect, test } from "bun:test";
import type { lifecycle, router } from "@gajae-code/coding-agent/sdk";
import type { ManagedSdkRuntimeDependency } from "../src/gjc/managed-sdk-dependency";
import { ManagedSdkRuntime, type TenantSessionKey } from "../src/gjc/managed-sdk-runtime";
import { SESSION_AUTHORITY_V3_EPOCH } from "../src/gjc/session-authority-v3";
import { type RouteGjcSessionCloseInput, routeGjcSessionClose } from "../src/gjc/session-close-router";
import { SessionMappingStore } from "../src/gjc/session-router";

type CloseRequest = Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["close"]>[0];
type CloseOutcome = Awaited<ReturnType<ManagedSdkRuntime["closeLifecycleSession"]>>;
type GenerationStatus = router.SessionGenerationStatus["status"];

const tenant: TenantSessionKey = {
	principalId: "owner",
	projectId: "project",
	canonicalWorkspace: "/workspace/project",
	chatId: "chat",
	sessionId: "session",
	generation: 2,
	leaseId: "lease",
	epoch: SESSION_AUTHORITY_V3_EPOCH,
};

function generationStatus(status: GenerationStatus): router.SessionGenerationStatus {
	const evidence = { source: "session_index", observedIndexSeq: 3, evidenceIndexSeq: 3 } as const;
	switch (status) {
		case "retired":
			return { status, evidence: { ...evidence, event: "session_closed" } };
		case "replaced":
			return { status, currentGeneration: tenant.generation + 1, evidence };
		case "unknown":
			return { status, reason: "generation_not_observed", evidence };
		case "current":
			return { status, evidence };
	}
}

function mappingFixture(runtime: ManagedSdkRuntimeDependency) {
	const mappings = new SessionMappingStore();
	mappings.setScoped(tenant, {
		principalId: tenant.principalId,
		chatId: tenant.chatId,
		projectId: tenant.projectId,
		sessionId: tenant.sessionId,
		rawFrameCursor: 1,
		eventCursor: 1,
		operationId: "initial",
		managedAuthority: { ...tenant, requestKey: "initial", authorityEpoch: SESSION_AUTHORITY_V3_EPOCH } as never,
	});
	const publications: string[] = [];
	const input: RouteGjcSessionCloseInput = {
		mapping: mappings.getScoped(tenant)!,
		mappings,
		ingressId: "close",
		ingressHash: "close-hash",
		managedSdkRuntime: runtime,
		managedSdkTenantFence: () => true,
		afterPublish: mapping => {
			publications.push(mapping.sessionId);
		},
	};
	return { mappings, publications, input };
}

async function realRuntimeFixture(status: GenerationStatus) {
	const calls: CloseRequest[] = [];
	const observations: string[] = [];
	const lifecycleService: Pick<ReturnType<typeof lifecycle.createSessionLifecycleService>, "close"> = {
		async close(request) {
			calls.push(request);
			return { ok: true, operation: "session.close", result: { sessionId: tenant.sessionId } };
		},
	};
	const sessionRouter: Pick<router.SessionRouter, "start" | "stop" | "reconcile" | "generationStatus"> = {
		start: async () => {},
		stop: async () => {},
		reconcile: async () => {
			observations.push("reconcile");
		},
		generationStatus: async () => {
			observations.push("generationStatus");
			return generationStatus(status);
		},
	};
	const runtime = new ManagedSdkRuntime({
		agentDir: "/test-agent",
		deps: {
			tenantFence: key => JSON.stringify(key) === JSON.stringify(tenant),
			createLifecycleService: () => lifecycleService as ReturnType<typeof lifecycle.createSessionLifecycleService>,
			createRouter: () => sessionRouter as router.SessionRouter,
		},
	});
	runtime.registerTenant(tenant);
	await runtime.start();
	return { runtime, calls, observations, ...mappingFixture(runtime) };
}

interface PublicationFixtureOptions {
	readonly ok?: boolean;
	readonly sessionId?: string;
	readonly status?: GenerationStatus;
}

function publicationFixture(options: PublicationFixtureOptions = {}) {
	const calls: { tenant: unknown; request: CloseRequest | undefined }[] = [];
	const unexpected = (): never => {
		throw new Error("Unexpected operation in close publication fixture.");
	};
	// This typed boundary fake tests journal publication only. It deliberately bypasses runtime
	// admission and does not represent an exact-close path available in the SDK 0.16.4 public API.
	const runtime: ManagedSdkRuntimeDependency = {
		state: "running",
		start: unexpected,
		dispose: unexpected,
		createProducerScope: unexpected,
		acquireAttachment: unexpected,
		request: unexpected,
		subscribeFrames: unexpected,
		createLifecycleSession: unexpected,
		resumeLifecycleSession: unexpected,
		deleteLifecycleSession: unexpected,
		reconcile: async () => {},
		generationStatus: async key => {
			expect(key).toEqual(tenant);
			return generationStatus(options.status ?? "retired");
		},
		closeLifecycleSession: async (key, request): Promise<CloseOutcome> => {
			calls.push({ tenant: key, request });
			return options.ok === false
				? {
						ok: false,
						operation: "session.close",
						certainty: "retryable",
						error: { code: "invalid_input", message: "exact close authority unavailable" },
					}
				: { ok: true, operation: "session.close", result: { sessionId: options.sessionId ?? tenant.sessionId } };
		},
	};
	return { calls, ...mappingFixture(runtime) };
}

describe("managed session close routing through real runtime admission", () => {
	test.each(["current", "retired", "unknown", "replaced"] as const)(
		"generation-only production close fails closed without SDK dispatch when the old generation is %s",
		async status => {
			const f = await realRuntimeFixture(status);
			try {
				// Even positive evidence that the old generation already retired cannot supply missing close authority.
				expect((await f.runtime.generationStatus(tenant)).status).toBe(status);
				f.observations.length = 0;
				expect(await routeGjcSessionClose(f.input)).toEqual({
					status: "uncertain",
					message: expect.stringContaining("SDK 0.16.4 public binding/lifecycle results do not supply it"),
				});
				expect(f.calls).toHaveLength(0);
				expect(f.observations).toHaveLength(0);
				expect(f.mappings.operationScoped(tenant, "close")?.state).toBe("uncertain");
				expect(f.mappings.operationScoped(tenant, "close")?.result).toBeUndefined();
				expect(f.publications).toHaveLength(0);
				await expect(routeGjcSessionClose(f.input)).rejects.toThrow("requires reconciliation");
				expect(f.calls).toHaveLength(0);
				expect(f.publications).toHaveLength(0);
			} finally {
				await f.runtime.dispose();
			}
		},
	);
});

describe("managed session close publication with an explicitly mocked runtime boundary", () => {
	test("publishes matching success plus positive retirement and replays without another mocked close", async () => {
		const f = publicationFixture();
		expect(await routeGjcSessionClose(f.input)).toEqual({ status: "closed" });
		expect(await routeGjcSessionClose(f.input)).toEqual({ status: "closed" });
		expect(f.calls).toEqual([
			{
				tenant,
				request: {
					actor: { id: tenant.principalId, namespace: "openwebui-gjc-adapter" },
					capability: "session.close",
					requestKey: "close",
					target: { sessionId: tenant.sessionId, endpointGeneration: tenant.generation },
				},
			},
		]);
		expect(f.mappings.operationScoped(tenant, "close")?.state).toBe("complete");
		expect(f.publications).toEqual([tenant.sessionId, tenant.sessionId]);
	});

	test.each([
		{ ok: false, status: "retired" as const },
		{ ok: false, status: "current" as const },
		{ sessionId: "foreign-session", status: "retired" as const },
		{ status: "current" as const },
		{ status: "unknown" as const },
		{ status: "replaced" as const },
	])("does not publish without matching mocked success and positive retirement: %j", async options => {
		const f = publicationFixture(options);
		expect((await routeGjcSessionClose(f.input)).status).not.toBe("closed");
		expect(f.calls).toHaveLength(1);
		expect(f.mappings.operationScoped(tenant, "close")?.state).not.toBe("complete");
		expect(f.publications).toHaveLength(0);
	});
});
