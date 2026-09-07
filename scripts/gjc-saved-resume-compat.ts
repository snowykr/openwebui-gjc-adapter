#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { lifecycle } from "@gajae-code/coding-agent/sdk";
import {
	type AdapterManagedBootstrapAttempt,
	startAdapterSessionAuthorityV3Activation,
} from "../src/adapter-managed-bootstrap";
import { ManagedBootstrapAdmissionOwner } from "../src/adapter-managed-bootstrap-admission";
import { ManagedOperationDeadline } from "../src/gjc/managed-operation-deadline";
import { ManagedSdkRuntime } from "../src/gjc/managed-sdk-runtime";
import { parseSessionAuthorityV3Document, type SessionAuthorityV3Document } from "../src/gjc/session-authority-v3";
import { SqliteProjectRegistrationStore } from "../src/projects/registration-store";
import { RuntimeSingletonLock } from "../src/runtime-singleton-lock";
import { UserWorkspaceRegistry } from "../src/security/user-workspace";
import { WorkspaceLeaseManager } from "../src/security/workspace-lease";
import { apiKey, providerResponse, writeLocalProviderConfig } from "./gjc-release-compat-fixtures";
import { promptAndAwaitTerminal } from "./gjc-release-compat-runtime";
import { connectFor, publicLifecycle, startPublicSdk, stopPublicSdk } from "./gjc-release-compat-sdk";

type ResumeRequest =
	| { kind: "external"; request: Parameters<lifecycle.AgentDirSessionLifecycleService["resumeExternal"]>[0] }
	| { kind: "exact"; request: Parameters<lifecycle.AgentDirSessionLifecycleService["resume"]>[0] };

// A separate adapter/client process, not a simulated SDK response or broker restart.
if (process.argv[2] === "--replay") {
	const agentDir = process.argv[3];
	if (agentDir === undefined) throw new Error("Missing isolated agent directory.");
	const request: ResumeRequest = JSON.parse(await Bun.stdin.text());
	const result = await invokeResume(lifecycle.createSessionLifecycleService(agentDir), request);
	console.log(JSON.stringify(result));
} else {
	await probe();
}

async function probe(): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "gjc-saved-resume-compat-"));
	const actor = { id: "saved-resume-compat", namespace: "openwebui-gjc-adapter" } as const;
	const workspace = process.argv.includes("--bootstrap")
		? (await new UserWorkspaceRegistry({ stateRoot: join(root, "adapter-state") }).open(actor.id)).root
		: join(root, "workspace");
	const agentDir = join(workspace, ".gjc", "agent");
	await mkdir(workspace, { recursive: true });
	const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: providerResponse });
	await writeLocalProviderConfig(agentDir, `http://127.0.0.1:${provider.port}`);
	process.env.GJC_CODING_AGENT_DIR = agentDir;
	process.env.GJC_COMPAT_LOCAL_API_KEY = apiKey;
	const budget = new ManagedOperationDeadline(90_000, "saved resume compatibility");
	const observations: { name: string; value: unknown }[] = [];
	const errors: unknown[] = [];
	const report: Record<string, unknown> = {
		kind: "public-saved-resume-api-test-report",
		selection: process.argv.includes("--exact") ? "public-list-exact-saved-id" : "external-full-id",
		root,
		startedAt: new Date().toISOString(),
		limitations: [
			"Exclusive hermetic workspace; no production bootstrap admission or migration journal proof.",
			"Session-ID-only cleanup is allowed only in this exclusively owned probe; not replacement-safe close proof (#5345).",
			"A new client process is not a broker/storage crash. Cached outcomes here cannot establish every interrupted invocation window.",
		],
	};
	let identity: { sessionId: string; generation: number } | undefined;
	let live = false;
	const observe = async (name: string, action: () => Promise<unknown>): Promise<unknown> => {
		budget.remaining();
		const value = await budget.wait(action());
		observations.push({ name, value });
		return value;
	};
	const close = async (requestKey: string) => {
		if (identity === undefined) throw new Error("No known session to clean up.");
		const client = await budget.wait(connectFor(workspace, identity.sessionId, identity.generation));
		const result = await observe(requestKey, () =>
			publicLifecycle(workspace).close({
				actor,
				capability: "session.close",
				requestKey,
				target: { sessionId: identity!.sessionId },
				timeoutMs: budget.remaining(),
			}),
		);
		if (
			!isRecord(result) ||
			result.ok !== true ||
			!isRecord(result.result) ||
			result.result.sessionId !== identity.sessionId
		)
			throw new Error("Isolated close did not acknowledge the exact session.");
		const retired = await observe(`${requestKey}.retirement`, () => client.generationStatus());
		if (!isRecord(retired) || retired.status !== "retired") throw new Error("Exact isolated retirement unproven.");
		live = false;
	};
	try {
		await budget.wait(startPublicSdk(workspace));
		const created = await observe("create", () =>
			publicLifecycle(workspace).createExternal({
				actor,
				capability: "session.create",
				requestKey: "saved-resume-create",
				target: { kind: "existing_path", path: workspace },
				readinessTimeoutMs: Math.min(60_000, budget.remaining()),
			}),
		);
		identity = exactIdentity(created, "session.create");
		live = true;
		const client = await budget.wait(connectFor(workspace, identity.sessionId, identity.generation));
		await observe("model.set", () => client.control("model.set", { id: "compat-local/hermetic-model" }));
		await observe("thinking.set", () => client.control("thinking.set", { level: "off" }));
		await budget.wait(
			promptAndAwaitTerminal(client, identity.sessionId, "save", "Respond with compatibility-ok.", observe),
		);
		await close("close-original");
		if (process.argv.includes("--bootstrap")) {
			report.selection = "manifest-bound-adapter-bootstrap";
			await bootstrapProbe(
				root,
				workspace,
				agentDir,
				identity.sessionId,
				actor.id,
				budget,
				observations,
				acknowledged => {
					identity = acknowledged;
					live = true;
				},
			);
			report.scopedHistoricalBootstrapVerified = true;
			await close("close-bootstrapped-session");
		} else {
			// Distinct API contract probes, not a production fallback chain. The bare
			// service target cannot resume saved sessions without transcript authority.
			const bare = await observe("resume.saved-full-id", () =>
				publicLifecycle(workspace).resume({
					actor,
					capability: "session.resume",
					requestKey: "bare-saved-resume",
					target: { sessionId: identity!.sessionId, cwd: workspace },
					timeoutMs: 15_000,
				}),
			);
			if (!isRecord(bare) || bare.ok !== false || !isRecord(bare.error) || bare.error.code !== "invalid_input")
				throw new Error("Bare saved resume contract changed; review the observed outcome.");
			report.bareSavedResumeUnsupported = true;
			const foreignWorkspace = join(root, "foreign-workspace");
			await mkdir(foreignWorkspace);
			const foreign = await observe("resume.foreign-workspace", () =>
				publicLifecycle(workspace).resumeExternal({
					actor,
					capability: "session.resume",
					requestKey: "foreign-workspace-denial",
					target: { sessionIdOrPrefix: identity!.sessionId, path: foreignWorkspace },
				}),
			);
			if (!isRecord(foreign) || foreign.kind !== "not_found")
				throw new Error("Foreign workspace selected the saved session.");
			let request: ResumeRequest;
			if (process.argv.includes("--exact")) {
				const selected = await observe("list.exact-saved-id", () =>
					publicLifecycle(workspace).list({
						actor,
						capability: "session.list",
						target: { cwd: workspace, resolveSessionId: identity!.sessionId },
						timeoutMs: budget.remaining(),
					}),
				);
				const saved = selectedSavedSession(selected, identity.sessionId);
				request = {
					kind: "exact",
					request: {
						actor,
						capability: "session.resume",
						requestKey: "manifest-occurrence-resume",
						target: {
							sessionId: identity.sessionId,
							cwd: workspace,
							sessionPath: saved.path,
							sessionIdentity: saved.identity,
						},
						timeoutMs: 15_000,
					},
				};
			} else
				request = {
					kind: "external",
					request: {
						actor,
						capability: "session.resume",
						requestKey: "manifest-occurrence-resume",
						target: { sessionIdOrPrefix: identity.sessionId, path: workspace },
						readinessTimeoutMs: 15_000,
					},
				};
			report.request = request;
			const resumed = await observe(`resume.${request.kind}-saved-full-id`, () =>
				invokeResume(publicLifecycle(workspace), request),
			);
			const resumedIdentity = exactIdentity(externalOutcome(resumed), "session.resume", identity.sessionId);
			identity = resumedIdentity;
			live = true;
			const attached = await budget.wait(connectFor(workspace, identity.sessionId, identity.generation));
			const metadata = await observe("resumed.metadata", () => attached.query("session.metadata"));
			if (
				!isRecord(metadata) ||
				metadata.type !== "query_response" ||
				metadata.ok !== true ||
				!isRecord(metadata.page) ||
				metadata.page.complete !== true ||
				!Array.isArray(metadata.page.items) ||
				metadata.page.items.length !== 1 ||
				!isRecord(metadata.page.items[0]) ||
				metadata.page.items[0].sessionId !== identity.sessionId ||
				metadata.page.items[0].cwd !== workspace
			)
				throw new Error("Resumed public metadata crossed its exact session/workspace fence.");
			const recreated = await observe("resume.new-service", () =>
				invokeResume(lifecycle.createSessionLifecycleService(agentDir), request),
			);
			if (!isDeepStrictEqual(resumed, recreated)) throw new Error("Same-key new-service result changed.");
			const restarted = await observe("resume.new-client-process", () => replayInChild(agentDir, request, budget));
			if (!isDeepStrictEqual(resumed, restarted)) throw new Error("Same-key new-process result changed.");
			report.clientRestartSameKeyOutcomeEqual = true;
			await close("close-resumed");
			const afterRetirement = await observe("resume.same-key-after-retirement", () =>
				replayInChild(agentDir, request, budget),
			);
			const retiredOutcome = externalOutcome(afterRetirement);
			if (isRecord(retiredOutcome) && retiredOutcome.ok === true) {
				const replayIdentity = exactIdentity(retiredOutcome, "session.resume", identity.sessionId);
				if (!isDeepStrictEqual(afterRetirement, resumed)) {
					identity = replayIdentity;
					live = true;
					throw new Error("Same-key replay after retirement changed its successful lifecycle identity.");
				}
			} else if (
				!isRecord(retiredOutcome) ||
				retiredOutcome.operation !== "session.resume" ||
				retiredOutcome.certainty !== "terminal" ||
				!isRecord(retiredOutcome.error) ||
				retiredOutcome.error.code !== "resource_gone"
			) {
				throw new Error("Retired replay returned neither its cached identity nor explicit resource_gone.");
			}
			const status = await observe("cached-generation-status", () => attached.generationStatus());
			if (!isRecord(status) || status.status !== "retired")
				throw new Error("Cached replay reactivated a retired generation.");
			report.retiredReplayDoesNotReinvokeSession = true;
			if (process.argv.includes("--replacement")) {
				// This mode reproduces an upstream contract gap. Passing this probe is
				// evidence of the unsafe behavior, never a production recovery gate.
				if (request.kind !== "exact") throw new Error("Replacement probe requires --exact.");
				const replacement: ResumeRequest = {
					kind: "exact",
					request: {
						...request.request,
						requestKey: "independent-replacement-resume",
						target: {
							...request.request.target,
							sessionIdentity: {
								...request.request.target.sessionIdentity!,
								sha256: "0".repeat(64),
							},
						},
					},
				};
				const newOutcome = await observe("resume.mismatching-public-snapshot", () =>
					invokeResume(publicLifecycle(workspace), replacement),
				);
				const nextIdentity = exactIdentity(externalOutcome(newOutcome), "session.resume", identity.sessionId);
				report.suppliedSnapshotHashEnforced = false;
				report.numericGenerationReused = nextIdentity.generation === identity.generation;
				identity = nextIdentity;
				live = true;
				await budget.wait(connectFor(workspace, identity.sessionId, identity.generation));
				const oldKey = await observe("resume.old-key-after-independent-replacement", () =>
					replayInChild(agentDir, request, budget),
				);
				exactIdentity(externalOutcome(oldKey), "session.resume", identity.sessionId);
				report.oldKeyNowAcknowledgesReplacement = true;
				report.originalIncarnationRecoveryProven = false;
				report.verdict = "blocked: snapshot precondition and original-incarnation replay are not enforced";
				await close("close-independent-replacement");
			}
		}
	} catch (error) {
		errors.push(error);
	} finally {
		if (live) {
			try {
				await close("cleanup");
			} catch (error) {
				errors.push(error);
			}
		}
		try {
			await budget.wait(stopPublicSdk(workspace));
			report.routerStopped = true;
		} catch (error) {
			errors.push(error);
		}
		try {
			await budget.wait(Promise.resolve(provider.stop(true)));
		} catch (error) {
			errors.push(error);
		}
		budget.close();
		report.finishedAt = new Date().toISOString();
		report.observations = observations;
		report.errors = errors.map(error =>
			error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) },
		);
		await writeFile(join(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
		console.log(JSON.stringify({ report: join(root, "report.json"), ok: errors.length === 0 }));
	}
	if (errors.length > 0) throw new AggregateError(errors, "Public saved resume compatibility failed.");
}

async function bootstrapProbe(
	root: string,
	workspace: string,
	agentDir: string,
	sessionId: string,
	principalId: string,
	budget: ManagedOperationDeadline,
	observations: { name: string; value: unknown }[],
	acknowledge: (identity: { sessionId: string; generation: number }) => void,
): Promise<void> {
	const stateRoot = join(root, "adapter-state");
	await mkdir(stateRoot, { recursive: true });
	const sourcePath = join(stateRoot, "authority.json");
	const unscoped = process.argv.includes("--bootstrap-unscoped");
	const chatId = unscoped ? "saved-chat" : JSON.stringify([principalId, "saved-chat"]);
	const stamp = new Date().toISOString();
	const terminalHistory = process.argv.includes("--bootstrap-history");
	const prior = {
		version: 2,
		chatId,
		projectId: "older-project",
		sessionId,
		createdAt: stamp,
		header: { chatId, projectId: "older-project", sessionId },
		rawFrameCursor: 0,
		eventCursor: 0,
		operationId: "older-turn",
		journal: [],
		retiredAt: stamp,
	};
	const original = JSON.stringify({
		kind: "openwebui-gjc-session-authority",
		version: 2,
		mappings: [
			{
				version: 2,
				chatId,
				projectId: "probe-project",
				sessionId,
				createdAt: stamp,
				header: { chatId, projectId: "probe-project", sessionId },
				rawFrameCursor: 0,
				eventCursor: 0,
				operationId: "prior-answer",
				...(terminalHistory
					? {
							reassignment: {
								state: "committed",
								sourceProjectId: "old-project",
								targetProjectId: "probe-project",
								startedAt: stamp,
								completedAt: stamp,
								sourceTombstone: {
									...prior,
									projectId: "old-project",
									header: { ...prior.header, projectId: "old-project" },
									operationId: "old-turn",
									prior,
								},
								priorTombstone: prior,
							},
						}
					: {}),
				journal: [
					{
						id: "prior-answer",
						kind: "prompt",
						state: "complete",
						startedAt: stamp,
						completedAt: stamp,
						result: {
							kind: "turn",
							assistantText: "immutable prior answer",
							mapping: {
								chatId,
								projectId: "probe-project",
								sessionId,
								rawFrameCursor: 0,
								eventCursor: 0,
								operationId: "prior-answer",
							},
						},
					},
				],
			},
		],
		provisionalOperations: [],
	});
	await writeFile(sourcePath, original);
	const lock = await RuntimeSingletonLock.acquire(stateRoot);
	let projectStore: SqliteProjectRegistrationStore | undefined;
	let admissionOwner: ManagedBootstrapAdmissionOwner | undefined;
	let admissionReleased = false;
	const stagePath = join(
		stateRoot,
		`session-authority-v3-${createHash("sha256").update(sourcePath).digest("hex").slice(0, 16)}`,
		"historical.v3.json",
	);
	let runtime: ManagedSdkRuntime | undefined;
	let initialGraph: SessionAuthorityV3Document | undefined;
	let attempt: AdapterManagedBootstrapAttempt | undefined;
	try {
		projectStore = new SqliteProjectRegistrationStore(join(stateRoot, "projects.sqlite"));
		const registry = new UserWorkspaceRegistry({ stateRoot });
		const leaseManager = new WorkspaceLeaseManager({ stateRoot });
		const sourceRoot = join(root, "source-project");
		await mkdir(sourceRoot);
		projectStore.linkProject(
			{ id: "probe-project", name: "probe", cwd: sourceRoot, allowedRoot: root, createdAt: new Date(stamp) },
			"admin",
		);
		admissionOwner = new ManagedBootstrapAdmissionOwner({ projectStore, registry, leaseManager, leaseMs: 30_000 });
		const owner = admissionOwner;
		attempt = startAdapterSessionAuthorityV3Activation({
			locations: { agentDir, stateRoot },
			sourcePath,
			runtimeLock: lock,
			configuredOwnerUserId: principalId,
			timeoutMs: Math.min(25_000, budget.remaining()),
			admission: {
				admit: async request => {
					initialGraph = parseSessionAuthorityV3Document(await readFile(stagePath));
					if (
						initialGraph === undefined ||
						request.candidates.length !== 1 ||
						request.candidates[0]!.principalId !== principalId ||
						request.candidates[0]!.retainedIntent !== undefined ||
						(await readFile(sourcePath, "utf8")) !== original
					)
						throw new Error("Probe admission lacks its original staged authority.");
					await owner.admit(request);
				},
				release: async () => {
					if (runtime !== undefined && runtime.state !== "stopped")
						throw new Error("Probe runtime has not stopped.");
					await owner.release();
					admissionReleased = true;
				},
			},
			authority: owner,
			createRuntime: (directory, deps) => {
				initialGraph = parseSessionAuthorityV3Document(readFileSync(stagePath));
				runtime = new ManagedSdkRuntime({
					agentDir: directory,
					deps: {
						...deps,
						createLifecycleService: value => {
							const service = lifecycle.createSessionLifecycleService(value);
							const resume = service.resume.bind(service);
							service.resume = async request => {
								if ((await readFile(sourcePath, "utf8")) !== original)
									throw new Error("Canonical source changed before public resume.");
								const outcome = await resume(request);
								observations.push({ name: "bootstrap.public-resume", value: outcome });
								if (
									outcome.ok &&
									outcome.result.sessionId === sessionId &&
									Number.isSafeInteger(outcome.result.endpointGeneration)
								)
									acknowledge({ sessionId, generation: outcome.result.endpointGeneration! });
								return outcome;
							};
							return service;
						},
					},
				});
				return runtime;
			},
		});
		const result = await attempt.result;
		if (result.status !== "activated") throw new Error("Scoped public historical bootstrap did not activate.");
		try {
			const document = parseSessionAuthorityV3Document(await readFile(sourcePath));
			const record = document?.mappings[0];
			if (
				record?.managedAuthority?.sessionId !== sessionId ||
				record.chatId !== JSON.stringify([principalId, "saved-chat"]) ||
				result.store.getScoped({ principalId, chatId: "saved-chat" })?.managedAuthority?.sessionId !== sessionId ||
				initialGraph === undefined ||
				!isDeepStrictEqual(record.reassignment, initialGraph.mappings[0]?.reassignment) ||
				record.journal[0]?.result?.assistantText !== "immutable prior answer" ||
				record.journal[0].result.managedAuthority !== undefined ||
				record.journal[0].result.historicalBinding === undefined ||
				record.journal.at(-1)?.lifecycle?.state !== "active_generation_proven" ||
				record.managedAuthority.canonicalWorkspace !== workspace ||
				projectStore.getProject("probe-project")?.cwd !== sourceRoot ||
				!admissionReleased ||
				runtime?.state !== "stopped"
			)
				throw new Error("Bootstrap failed history, proof, or runtime isolation invariants.");
			observations.push({
				name: "bootstrap.canonical-v3",
				value: {
					version: document!.version,
					generation: record.managedAuthority.generation,
					originalResultPreserved: true,
					terminalReassignmentHistoryPreserved: terminalHistory,
					unscopedOwnerResolved: unscoped,
					postStageAdmissionReleased: admissionReleased,
					registeredWorkspaceAdmission: true,
					sourceProjectUnchanged: projectStore.getProject("probe-project")?.cwd === sourceRoot,
					bootstrapRuntimeStopped: true,
					migrationOperationCount: record.journal.length - 1,
				},
			});
		} finally {
			result.store.close();
		}
	} finally {
		await attempt?.settled;
		await admissionOwner?.release();
		projectStore?.close();
		await lock.release();
	}
}

async function replayInChild(
	agentDir: string,
	request: ResumeRequest,
	budget: ManagedOperationDeadline,
): Promise<unknown> {
	const child = Bun.spawn([process.execPath, import.meta.path, "--replay", agentDir], {
		stdin: new Blob([JSON.stringify(request)]),
		stdout: "pipe",
		stderr: "pipe",
	});
	try {
		const [code, stdout, stderr] = await budget.wait(
			Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]),
		);
		if (code !== 0) throw new Error(`Public replay process failed (${code}): ${stderr}`);
		return JSON.parse(stdout);
	} finally {
		if (child.exitCode === null) child.kill();
	}
}

function exactIdentity(
	value: unknown,
	operation: string,
	expectedSessionId?: string,
): { sessionId: string; generation: number } {
	if (
		!isRecord(value) ||
		value.ok !== true ||
		value.operation !== operation ||
		!isRecord(value.result) ||
		typeof value.result.sessionId !== "string" ||
		!Number.isSafeInteger(value.result.endpointGeneration) ||
		(value.result.endpointGeneration as number) <= 0 ||
		(expectedSessionId !== undefined && value.result.sessionId !== expectedSessionId)
	)
		throw new Error(`${operation} did not acknowledge the exact identity and positive generation.`);
	return { sessionId: value.result.sessionId, generation: value.result.endpointGeneration as number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function externalOutcome(value: unknown): unknown {
	if (!isRecord(value) || value.kind !== "result")
		throw new Error("External saved resume did not resolve one result.");
	return value.outcome;
}

async function invokeResume(
	service: lifecycle.AgentDirSessionLifecycleService,
	input: ResumeRequest,
): Promise<unknown> {
	return input.kind === "external"
		? service.resumeExternal(input.request)
		: { kind: "result", outcome: await service.resume(input.request) };
}

function selectedSavedSession(
	value: unknown,
	sessionId: string,
): { path: string; identity: lifecycle.SessionLifecycleTranscriptIdentity } {
	if (
		!isRecord(value) ||
		value.operation !== "session.list" ||
		value.ok !== true ||
		!isRecord(value.result) ||
		!isRecord(value.result.savedSession) ||
		value.result.savedSession.id !== sessionId ||
		typeof value.result.savedSession.path !== "string"
	)
		throw new Error("Public list omitted the exact saved session selection.");
	const identity = value.result.savedSession.identity;
	if (
		!isRecord(identity) ||
		!["dev", "ino", "mtimeNs", "sha256"].every(field => typeof identity[field] === "string") ||
		typeof identity.size !== "number" ||
		typeof identity.mtimeMs !== "number"
	)
		throw new Error("Public saved-session identity is malformed.");
	return {
		path: value.result.savedSession.path,
		identity: {
			dev: identity.dev as string,
			ino: identity.ino as string,
			size: identity.size,
			mtimeMs: identity.mtimeMs,
			mtimeNs: identity.mtimeNs as string,
			sha256: identity.sha256 as string,
		},
	};
}
