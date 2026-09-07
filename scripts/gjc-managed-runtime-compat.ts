#!/usr/bin/env bun
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { lifecycle } from "@gajae-code/coding-agent/sdk";
import { requireManagedEndpointReceipt } from "../src/gjc/managed-lifecycle-evidence";
import { type ManagedSdkAttachment, ManagedSdkRuntime } from "../src/gjc/managed-sdk-runtime";
import { routeGjcTurn } from "../src/gjc/session-turn-router";
import { SessionV3FileBackedMappingStore } from "../src/gjc/session-v3-file-backed-mapping-store";
import { createManagedGjcTurnRunner } from "../src/live/gjc-managed-turn-runner";
import { apiKey, providerResponse, writeLocalProviderConfig } from "./gjc-release-compat-fixtures";

// This probe owns a fresh workspace exclusively. Cleanup uses its persisted
// original public lifecycle receipt, not a refreshed session-only identity.
const root = await mkdtemp(join(tmpdir(), "gjc-managed-route-compat-"));
const workspace = join(root, "workspace");
const agentDir = join(workspace, ".gjc", "agent");
await mkdir(workspace, { recursive: true });
let releaseProvider!: () => void;
const providerGate = new Promise<void>(resolve => {
	releaseProvider = resolve;
});
let providerStarted!: () => void;
const providerReady = new Promise<void>(resolve => {
	providerStarted = resolve;
});
const provider = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		if (new URL(request.url).pathname === "/v1/chat/completions") {
			providerStarted();
			await providerGate;
		}
		return providerResponse(request);
	},
});
await writeLocalProviderConfig(agentDir, `http://127.0.0.1:${provider.port}`);
process.env.GJC_CODING_AGENT_DIR = agentDir;
process.env.GJC_COMPAT_LOCAL_API_KEY = apiKey;
const service = lifecycle.createSessionLifecycleService(agentDir);
const responses: Record<string, unknown>[] = [];
let lifecycleCreates = 0;
let promptAccepted!: () => void;
const promptAcknowledged = new Promise<void>(resolve => {
	promptAccepted = resolve;
});
class ProbeRuntime extends ManagedSdkRuntime {
	override async createPreparedExternalLifecycleSession(
		authority: Parameters<ManagedSdkRuntime["createPreparedExternalLifecycleSession"]>[0],
		request: Parameters<ManagedSdkRuntime["createPreparedExternalLifecycleSession"]>[1],
		timeoutMs?: number,
		onOutcome?: Parameters<ManagedSdkRuntime["createPreparedExternalLifecycleSession"]>[3],
	) {
		lifecycleCreates += 1;
		return super.createPreparedExternalLifecycleSession(authority, request, timeoutMs, onOutcome);
	}
	override async request(
		attachment: ManagedSdkAttachment,
		frame: Record<string, unknown>,
		options?: Parameters<ManagedSdkRuntime["request"]>[2],
	) {
		const response = await super.request(attachment, frame, options);
		responses.push({ operation: frame.operation ?? frame.query, response });
		if (frame.operation === "turn.prompt") promptAccepted();
		return response;
	}
}
const runtime = new ProbeRuntime({
	agentDir,
	deps: {
		createLifecycleService: () => service,
		tenantFence: key =>
			key.principalId === "managed-compat" &&
			key.projectId === "managed-compat-project" &&
			key.chatId === "managed-compat-chat" &&
			key.canonicalWorkspace === workspace &&
			key.leaseId === "isolated-lease" &&
			key.epoch === "isolated-epoch",
		preparedTenantFence: key =>
			key.principalId === "managed-compat" &&
			key.projectId === "managed-compat-project" &&
			key.chatId === "managed-compat-chat" &&
			key.canonicalWorkspace === workspace &&
			key.leaseId === "isolated-lease" &&
			key.epoch === "isolated-epoch" &&
			key.requestKey === "managed-compat-ingress",
	},
});
let mappings = new SessionV3FileBackedMappingStore(join(root, "authority.json"));
const runner = createManagedGjcTurnRunner(runtime);
const scope = { principalId: "managed-compat", chatId: "managed-compat-chat" };
const project = {
	id: "managed-compat-project",
	name: "Managed compatibility",
	cwd: workspace,
	allowedRoot: root,
	createdAt: new Date(),
};
const startedAt = new Date().toISOString();
const report: Record<string, unknown> = {
	kind: "managed-routing-api-package-test-report",
	root,
	startedAt,
	limitations: [
		"Hermetic provider and exclusively owned probe workspace; no browser.",
		"Persisted original receipt cleanup is isolated; full production reaper/catalog ownership and uncertain recovery require separate verification.",
	],
};
const errors: unknown[] = [];
let turn: ReturnType<typeof routeGjcTurn> | undefined;
try {
	await runtime.start();
	let settled = false;
	turn = routeGjcTurn({
		project,
		...scope,
		userMessageId: "managed-compat-ingress",
		text: "Respond with compatibility-ok.",
		runner,
		mappings,
		modelSelection: { provider: "compat-local", modelId: "hermetic-model", thinkingLevel: "off" },
		preparedManagedAuthority: {
			...scope,
			projectId: project.id,
			canonicalWorkspace: workspace,
			leaseId: "isolated-lease",
			epoch: "isolated-epoch",
			requestKey: "managed-compat-ingress",
		},
	});
	void turn.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	await deadline(
		Promise.race([
			Promise.all([providerReady, promptAcknowledged]).then(() => setImmediate()),
			turn.then(() => {
				throw new Error("Turn completed before provider response.");
			}),
		]),
		30_000,
	);
	if (settled || mappings.getScoped(scope) !== undefined)
		throw new Error("Acknowledgement published a turn before semantic completion.");
	report.withheldBeforeProviderResponse = true;
	releaseProvider();
	const result = await deadline(turn, 60_000);
	if (!result.assistantText.includes("compatibility-ok")) throw new Error("Managed turn omitted terminal finalText.");
	if (!result.events.some(event => event.type === "agent_end"))
		throw new Error("Managed turn completed without agent_end.");
	const control = responses.find(value => value.operation === "turn.prompt")?.response as
		| { result?: Record<string, unknown> }
		| undefined;
	if (
		control?.result?.accepted !== true ||
		typeof control.result.commandId !== "string" ||
		typeof control.result.turnId !== "string"
	)
		throw new Error("Public prompt acknowledgement lacked accepted correlation.");
	if (control.result.finalizedAssistantText !== undefined || control.result.events !== undefined)
		throw new Error("Probe did not exercise an acknowledgement-only public response.");
	report.acknowledgement = control;
	report.result = {
		text: result.assistantText,
		events: result.events.map(event => event.type),
		generation: result.mapping.managedAuthority?.generation,
	};
	const before = responses.length;
	const createsBeforeReplay = lifecycleCreates;
	mappings.close();
	mappings = new SessionV3FileBackedMappingStore(join(root, "authority.json"));
	const replay = await routeGjcTurn({
		project,
		...scope,
		userMessageId: "managed-compat-ingress",
		text: "Respond with compatibility-ok.",
		runner,
		mappings,
		managedAuthority: result.mapping.managedAuthority,
		modelSelection: { provider: "compat-local", modelId: "hermetic-model", thinkingLevel: "off" },
	});
	if (
		replay.assistantText !== result.assistantText ||
		!isDeepStrictEqual(replay.events, result.events) ||
		responses.length !== before ||
		lifecycleCreates !== createsBeforeReplay
	)
		throw new Error("Replay changed the result or reissued SDK requests.");
	report.replayedWithoutDispatch = true;
	report.replayedAfterStoreReopen = true;
	report.replayedImmutableEvents = true;
	report.lifecycleCreates = lifecycleCreates;
	const originalEvidence = mappings.operationScoped(scope, "managed-compat-ingress")?.lifecycle;
	if (originalEvidence === undefined) throw new Error("Reopened canonical source lost lifecycle evidence.");
	requireManagedEndpointReceipt(originalEvidence);
	report.originalEndpointReceiptReopened = true;
} catch (error) {
	errors.push(error);
} finally {
	releaseProvider();
	if (turn !== undefined) {
		try {
			await deadline(turn, 5_000);
		} catch (error) {
			if (!errors.includes(error)) errors.push(error);
		}
	}
	const authority =
		mappings.getScoped(scope)?.managedAuthority ??
		mappings.provisionalOperationScoped(scope, "managed-compat-ingress")?.managedAuthority;
	try {
		report.cleanup = await cleanupIsolatedSession(authority);
	} catch (error) {
		errors.push(error);
	}
	try {
		await runtime.dispose();
		report.routerStopped = runtime.state === "stopped";
	} catch (error) {
		errors.push(error);
	}
	try {
		mappings.close();
	} catch (error) {
		errors.push(error);
	}
	try {
		await provider.stop(true);
	} catch (error) {
		errors.push(error);
	}
	report.finishedAt = new Date().toISOString();
	report.responses = responses;
	report.errors = errors.map(errorRecord);
	await writeFile(join(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
	console.log(JSON.stringify({ report: join(root, "report.json"), ok: errors.length === 0 }));
}
if (errors.length > 0) throw new AggregateError(errors, "Managed routing compatibility failed.");

async function cleanupIsolatedSession(authority: Parameters<ManagedSdkRuntime["generationStatus"]>[0] | undefined) {
	if (authority === undefined) throw new Error("Probe has no exact known session identity for cleanup.");
	const evidence =
		mappings.operationScoped(scope, "managed-compat-ingress")?.lifecycle ??
		mappings.provisionalOperationScoped(scope, "managed-compat-ingress")?.lifecycle;
	if (evidence === undefined) throw new Error("Probe cleanup lost original durable lifecycle evidence.");
	const endpointReceipt = requireManagedEndpointReceipt(evidence);
	if (endpointReceipt.sessionId !== authority.sessionId || endpointReceipt.endpointGeneration !== authority.generation)
		throw new Error("Persisted endpoint receipt conflicts with the cleanup owner.");
	const acknowledgement = await service.close({
		actor: { id: scope.principalId, namespace: "managed-compat" },
		capability: "session.close",
		requestKey: "isolated-cleanup",
		target: { ...endpointReceipt },
	});
	if (!acknowledgement.ok || acknowledgement.result.sessionId !== authority.sessionId)
		throw new Error("Isolated public cleanup failed or acknowledged a different session.");
	await runtime.reconcile();
	const retirement = await runtime.generationStatus(authority);
	if (retirement.status !== "retired") throw new Error("Isolated cleanup retirement is unproven.");
	return { acknowledgement, retirement, originalEndpointReceiptUsed: true };
}

function errorRecord(error: unknown): Record<string, unknown> {
	if (!(error instanceof Error)) return { message: String(error) };
	return {
		name: error.name,
		message: error.message,
		...(error instanceof AggregateError ? { errors: error.errors.map(errorRecord) } : {}),
		...(error.cause === undefined ? {} : { cause: errorRecord(error.cause) }),
	};
}

async function deadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("Managed compatibility deadline exceeded.")), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
