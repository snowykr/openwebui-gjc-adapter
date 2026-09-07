import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { lifecycle } from "@gajae-code/coding-agent/sdk";

// These fixtures exercise only the released public facade's projection and error handling.
// No Broker, host, endpoint, retirement event, or persisted adapter authority is created.
// Live lifecycle producer and replacement-safety evidence belongs to the separate release probes.
const actor = { id: "facade-contract-actor", namespace: "sdk-contract-fixture" };
const cwd = "/synthetic/sdk-contract-workspace";
const pair = { endpointGeneration: 73, endpointIncarnation: "0123456789abcdef".repeat(4) };
type ClientCall = Parameters<lifecycle.SessionLifecycleClient["global"]>;
type ProducingRequest = lifecycle.SessionCreateRequest | lifecycle.SessionForkRequest | lifecycle.SessionResumeRequest;

function fixture(respond: lifecycle.SessionLifecycleClient["global"]) {
	const calls: ClientCall[] = [];
	const client: lifecycle.SessionLifecycleClient = {
		async global(...call) {
			calls.push(call);
			return await respond(...call);
		},
	};
	return { calls, service: new lifecycle.SessionLifecycleService(client) };
}

function invokeProducerFacade(service: lifecycle.SessionLifecycleService, request: ProducingRequest) {
	switch (request.operation) {
		case "session.create":
			return service.create(request);
		case "session.fork":
			return service.fork(request);
		case "session.resume":
			return service.resume(request);
	}
}

const producingRequests: readonly ProducingRequest[] = [
	{
		operation: "session.create",
		actor,
		capability: "session.create",
		requestKey: "synthetic-create",
		target: { cwd, readiness: "immediate" },
	},
	{
		operation: "session.fork",
		actor,
		capability: "session.fork",
		requestKey: "synthetic-fork",
		target: { cwd, sourceSessionId: "synthetic-source-session" },
	},
	{
		operation: "session.resume",
		actor,
		capability: "session.resume",
		requestKey: "synthetic-resume",
		target: { sessionId: "synthetic-resumed-session", cwd },
	},
];

const closeRequest: lifecycle.SessionCloseRequest = {
	operation: "session.close",
	actor,
	capability: "session.close",
	requestKey: "synthetic-exact-close",
	target: { sessionId: "synthetic-close-session", ...pair },
	timeoutMs: 321,
};

const invalidGenerations: readonly [string, unknown][] = [
	["null", null],
	["string", "73"],
	["zero", 0],
	["negative", -1],
	["fraction", 1.5],
	["NaN", Number.NaN],
	["infinity", Number.POSITIVE_INFINITY],
	["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
];
const invalidIncarnations: readonly [string, unknown][] = [
	["null", null],
	["number", 73],
	["empty", ""],
	["short", "a".repeat(63)],
	["long", "a".repeat(65)],
	["uppercase", "A".repeat(64)],
	["nonhex", "g".repeat(64)],
	["padded", ` ${pair.endpointIncarnation} `],
];

const incompletePairs: readonly [string, Record<string, unknown>][] = [
	["both fields absent", {}],
	["incarnation absent", { endpointGeneration: pair.endpointGeneration }],
	["generation absent", { endpointIncarnation: pair.endpointIncarnation }],
];

for (const request of producingRequests) {
	const sessionId =
		request.operation === "session.resume" ? request.target.sessionId : `synthetic-${request.operation}-result`;

	describe(`released ${request.operation} synthetic facade projection (not live producer proof)`, () => {
		test.each([1, pair.endpointGeneration, Number.MAX_SAFE_INTEGER])(
			"preserves exact sessionId, generation %s, and opaque incarnation without leaking endpoint credentials",
			async endpointGeneration => {
				const result = { sessionId, cwd, endpointGeneration, endpointIncarnation: pair.endpointIncarnation };
				const f = fixture(async () => ({
					ok: true,
					result: { ...result, endpoint: { url: "synthetic://endpoint", token: "synthetic-secret" } },
				}));

				expect(await invokeProducerFacade(f.service, request)).toEqual({
					ok: true,
					operation: request.operation,
					result,
				});
				expect(f.calls).toHaveLength(1);
				expect(f.calls[0]?.[0]).toBe(request.operation);
				expect(f.calls[0]?.[1]).toEqual(request.target);
			},
		);

		test.each(incompletePairs)(
			"%s stays incomplete despite ok:true; no authority is synthesized",
			async (_label, fields) => {
				const f = fixture(async () => ({ ok: true, result: { sessionId, ...fields } }));
				// In 0.16.6 these fields are optional and independently projected. ok:true alone is NOT exact-close authority.
				expect(await invokeProducerFacade(f.service, request)).toEqual({
					ok: true,
					operation: request.operation,
					result: { sessionId, ...fields },
				});
			},
		);

		test.each(invalidGenerations)(
			"omits %s generation without inventing or discarding a valid incarnation",
			async (_label, value) => {
				const f = fixture(async () => ({ ok: true, result: { sessionId, ...pair, endpointGeneration: value } }));
				expect(await invokeProducerFacade(f.service, request)).toEqual({
					ok: true,
					operation: request.operation,
					result: { sessionId, endpointIncarnation: pair.endpointIncarnation },
				});
			},
		);

		test.each(invalidIncarnations)(
			"omits %s incarnation without inventing or discarding a valid generation",
			async (_label, value) => {
				const f = fixture(async () => ({ ok: true, result: { sessionId, ...pair, endpointIncarnation: value } }));
				expect(await invokeProducerFacade(f.service, request)).toEqual({
					ok: true,
					operation: request.operation,
					result: { sessionId, endpointGeneration: pair.endpointGeneration },
				});
			},
		);

		test("omits both malformed authority fields rather than manufacturing a complete pair", async () => {
			const f = fixture(async () => ({
				ok: true,
				result: { sessionId, endpointGeneration: 0, endpointIncarnation: "not-an-incarnation" },
			}));
			expect(await invokeProducerFacade(f.service, request)).toEqual({
				ok: true,
				operation: request.operation,
				result: { sessionId },
			});
		});
	});
}

describe("released exact-close facade validation boundary (synthetic client only)", () => {
	const invalidEnvelopes: readonly [string, Record<string, unknown>, string][] = [
		["missing actor", { actor: undefined }, "unauthorized"],
		["empty actor id", { actor: { ...actor, id: "" } }, "unauthorized"],
		["empty actor namespace", { actor: { ...actor, namespace: "" } }, "unauthorized"],
		["missing request key", { requestKey: undefined }, "invalid_request"],
		["empty request key", { requestKey: "" }, "invalid_request"],
		["wrong capability", { capability: "session.delete" }, "capability_denied"],
		["null target", { target: null }, "invalid_request"],
		["array target", { target: [] }, "invalid_request"],
		["scalar target", { target: "synthetic-close-session" }, "invalid_request"],
	];

	test.each(invalidEnvelopes)("rejects %s before invoking the client", async (_label, override, code) => {
		const request = { ...closeRequest, ...override };
		const f = fixture(async () => {
			throw new Error("invalid envelopes must not invoke the client");
		});
		const failure = { ok: false, operation: "session.close", certainty: "terminal", error: { code } };
		expect(lifecycle.validateSessionLifecycleMutationRequest(request)).toMatchObject(failure);
		// Deliberately cross the typed boundary with malformed caller input to exercise runtime validation.
		expect(await f.service.execute(request as lifecycle.SessionCloseRequest)).toMatchObject(failure);
		expect(f.calls).toEqual([]);
	});

	const unvalidatedPairs: readonly [string, Record<string, unknown>][] = [
		...incompletePairs,
		...invalidGenerations.map(([label, value]): [string, Record<string, unknown>] => [
			`${label} generation`,
			{ ...pair, endpointGeneration: value },
		]),
		...invalidIncarnations.map(([label, value]): [string, Record<string, unknown>] => [
			`${label} incarnation`,
			{ ...pair, endpointIncarnation: value },
		]),
		["both malformed", { endpointGeneration: 0, endpointIncarnation: "not-an-incarnation" }],
	];

	test.each(unvalidatedPairs)(
		"public-facade validation gap: %s reaches the client unchanged",
		async (_label, fields) => {
			const target = { sessionId: closeRequest.target.sessionId, ...fields };
			const request = { ...closeRequest, target };
			// 0.16.6 checks the envelope, NOT close-pair shape. This synthetic rejection is not proof of Broker validation.
			// Adapter-side exact-pair validation and fail-closed production guards must remain in place.
			const error = { code: "invalid_input", message: "synthetic Broker rejection" };
			const f = fixture(async () => ({ ok: false, error }));
			expect(lifecycle.validateSessionLifecycleMutationRequest(request)).toEqual({
				ok: true,
				operation: request.operation,
				actor,
				requestKey: request.requestKey,
				target,
			});
			expect(await f.service.execute(request as lifecycle.SessionCloseRequest)).toEqual({
				ok: false,
				operation: "session.close",
				certainty: "terminal",
				error,
			});
			expect(f.calls).toHaveLength(1);
			expect(f.calls[0]?.[0]).toBe("session.close");
			expect(f.calls[0]?.[1]).toEqual(target);
		},
	);

	test("forwards the complete exact-close pair unchanged (synthetic ACK, not retirement proof)", async () => {
		const f = fixture(async () => ({ ok: true, result: { sessionId: closeRequest.target.sessionId } }));
		expect(lifecycle.validateSessionLifecycleMutationRequest(closeRequest)).toMatchObject({
			ok: true,
			target: closeRequest.target,
		});
		expect(await f.service.close(closeRequest)).toEqual({
			ok: true,
			operation: "session.close",
			result: { sessionId: closeRequest.target.sessionId },
		});
		expect(f.calls).toHaveLength(1);
		expect(f.calls[0]?.[0]).toBe("session.close");
		expect(f.calls[0]?.[1]).toEqual({ ...closeRequest.target });
		expect(f.calls[0]?.[2]).toMatchObject({ timeoutMs: closeRequest.timeoutMs });
	});
});

for (const request of [...producingRequests, closeRequest]) {
	describe(`released ${request.operation} failure projection (synthetic client only)`, () => {
		test.each([
			["terminal_uncertain", "uncertain"],
			["cleanup_pending", "cleanup_pending"],
			["readiness_timeout", "retryable"],
			["endpoint_stale", "terminal"],
		] as const)("keeps Broker %s as a %s failure even with a success-shaped result", async (code, certainty) => {
			const error = { code, message: "synthetic lifecycle failure" };
			const f = fixture(async () => ({ ok: false, error, result: { sessionId: "misleading-result", ...pair } }));
			expect(await f.service.execute(request)).toEqual({
				ok: false,
				operation: request.operation,
				certainty,
				error,
			});
			expect(f.calls).toHaveLength(1);
		});

		test.each(["timeout", "connection_closed", "protocol_error"])(
			"keeps dispatched %s transport failure uncertain",
			async code => {
				const f = fixture(async () => {
					throw Object.assign(new Error("synthetic transport failure"), { code, requestSent: true });
				});
				expect(await f.service.execute(request)).toEqual({
					ok: false,
					operation: request.operation,
					certainty: "uncertain",
					error: { code, message: "synthetic transport failure" },
				});
				expect(f.calls).toHaveLength(1);
			},
		);

		test.each([
			["absent envelope", undefined],
			["missing success discriminant", { result: { sessionId: "synthetic-result", ...pair } }],
			["absent result", { ok: true }],
			["missing sessionId", { ok: true, result: { ...pair } }],
			["empty sessionId", { ok: true, result: { sessionId: "", ...pair } }],
			["nonstring sessionId", { ok: true, result: { sessionId: 73, ...pair } }],
			["malformed error", { ok: false, error: { code: "terminal_uncertain" } }],
		] as const)("keeps %s uncertain rather than promoting it to success", async (_label, response) => {
			const f = fixture(async () => response);
			expect(await f.service.execute(request)).toMatchObject({
				ok: false,
				operation: request.operation,
				certainty: "uncertain",
				error: { code: "malformed_response" },
			});
			expect(f.calls).toHaveLength(1);
		});
	});
}

describe("released declared authority gaps (not runtime recovery evidence)", () => {
	test("resume and close reject a different returned sessionId even when its pair is well formed", async () => {
		for (const request of [
			...producingRequests.filter(value => value.operation === "session.resume"),
			closeRequest,
		]) {
			const f = fixture(async () => ({ ok: true, result: { sessionId: "wrong-session", ...pair } }));
			expect(await f.service.execute(request)).toMatchObject({
				ok: false,
				operation: request.operation,
				certainty: "uncertain",
				error: { code: "malformed_response" },
			});
			expect(f.calls).toHaveLength(1);
		}
	});

	test("installed public declarations expose generation-only bindingAuthority and no exact pair on delete", () => {
		// Read the installed declarations as evidence, never import private SDK modules or construct a fake Router.
		const root = new URL("../node_modules/@gajae-code/coding-agent/dist/types/sdk/", import.meta.url);
		const routerDeclaration = readFileSync(new URL("router/session-router.d.ts", root), "utf8");
		const lifecycleDeclaration = readFileSync(new URL("lifecycle/service.d.ts", root), "utf8");
		const binding = routerDeclaration.match(
			/bindingAuthority\(sessionId: string\): Promise<\{([^}]+)\} \| undefined>;/,
		);
		const deletion = lifecycleDeclaration.match(/export interface SessionDeleteTarget \{([^}]+)\}/);
		expect(binding).not.toBeNull();
		expect(binding?.[1]).toMatch(/sessionId: string;/);
		expect(binding?.[1]).toMatch(/endpointGeneration: number;/);
		expect(binding?.[1]).not.toContain("endpointIncarnation");
		expect(deletion).not.toBeNull();
		expect(deletion?.[1]).toMatch(/readonly sessionId: string;/);
		expect(deletion?.[1]).not.toContain("endpointGeneration");
		expect(deletion?.[1]).not.toContain("endpointIncarnation");
	});
});
