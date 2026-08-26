import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildAdapterServerOptionsFromEnv } from "../src/adapter-server-options";
import { resolveGjcRuntimeLocations } from "../src/configure/runtime-locations";
import { SESSION_AUTHORITY_V3_EPOCH } from "../src/gjc/session-authority-v3";
import type { SessionMapping, SessionMappingStore } from "../src/gjc/session-router";
import type { ManagedTurnAuthority } from "../src/gjc/turn-runner";
import type { LiveGatewayRunner } from "../src/live/chat-completions";
import type { ManagedSdkRuntimeDependency, ManagedSdkTenantFence } from "../src/live/gjc-routing-lifecycle";
import type { OpenWebUIOwnerContext } from "../src/openwebui/auth";
import { InMemoryOpenWebUIProjectionRepository } from "../src/openwebui/client";
import { ProjectLinkService } from "../src/projects/link-service";
import { SqliteProjectRegistrationStore } from "../src/projects/registration-store";
import { resolveAllowedRoots } from "../src/security/paths";
import { workspaceLeaseId } from "../src/security/workspace-lease";
import { createAdapterRequestHandler } from "../src/server";
import { FakeManagedSdkRuntime, writeDirectV3Authority } from "./cli-fixtures";
import { CANONICAL_MODEL_IDS, LOW_MODEL_ID, staticModelReaderFactory } from "./model-selection-fixtures";
import { messageEntry, writeSessionFile } from "./session-sync-fixtures";

const tempDirs: string[] = [];
const supportsPermissionDeniedPathTest =
	process.platform !== "win32" && process.getuid?.() !== undefined && process.getuid() !== 0;

afterEach(async () => {
	for (const tempDir of tempDirs.splice(0)) {
		await fs.rm(tempDir, { force: true, recursive: true });
	}
});

describe("project admin routes", () => {
	test("links, exposes, unlinks, and relinks a project without deleting local GJC sessions", async () => {
		const workspace = await createAdapterWorkspace("gjc-project-admin-");
		const projectDirectory = path.join(workspace, "Admin Project");
		const sessionRoot = path.join(projectDirectory, ".gjc", "sessions");
		const sessionFile = path.join(sessionRoot, "session-one.jsonl");
		await fs.mkdir(sessionRoot, { recursive: true });
		await writeSessionFile(sessionFile, {
			header: { id: "session-one", title: "Admin Session", cwd: projectDirectory },
			entries: [messageEntry("user-1", null, "user", "load admin history")],
		});
		const repository = new InMemoryOpenWebUIProjectionRepository();
		const service = new ProjectLinkService({
			allowedRoots: await resolveAllowedRoots([workspace]),
			store: new SqliteProjectRegistrationStore(":memory:"),
			repository,
			ownerUserId: "owner-1",
			protectedPaths: resolveGjcRuntimeLocations({ mode: "existing", serviceHome: workspace }).protectedProjectPaths,
		});
		const handler = createAdapterRequestHandler({
			routes: {
				projects: [],
				projectProvider: () => service.listLinkedProjects(),
				projectLinkService: service,
				owner,
				runner: fixedRunner("unused"),
				adapterApiToken: "adapter-token",
				requireAdapterApiToken: true,
				modelReaderFactory,
			},
		});

		const linked = await handler(
			jsonRequest("http://adapter.test/admin/projects/link", {
				cwd: projectDirectory,
				name: "Admin Project",
			}),
		);
		expect(linked.status).toBe(200);
		expect(await linked.json()).toMatchObject({
			project: { id: "admin-project", status: "linked" },
			sync: { imported: [{ sessionId: "session-one" }] },
		});
		expect(await modelIds(handler)).toEqual([...CANONICAL_MODEL_IDS]);

		const unlinked = await handler(
			new Request("http://adapter.test/admin/projects/admin-project/unlink", {
				method: "POST",
				headers: { authorization: "Bearer adapter-token", "X-OpenWebUI-User-Id": "owner-1" },
			}),
		);
		expect(unlinked.status).toBe(200);
		expect(await unlinked.json()).toMatchObject({ project: { id: "admin-project", status: "unlinked" } });
		expect(await modelIds(handler)).toEqual([...CANONICAL_MODEL_IDS]);
		expect(await fs.stat(sessionFile)).toBeTruthy();
		expect(await repository.getChat("owner-1", "gjc-project-admin-project-session-session-one")).toBeUndefined();

		const relinked = await handler(
			jsonRequest("http://adapter.test/admin/projects/link", {
				cwd: projectDirectory,
				name: "Admin Project",
			}),
		);
		expect(relinked.status).toBe(200);
		expect(await modelIds(handler)).toEqual([...CANONICAL_MODEL_IDS]);
		expect(await repository.getChat("owner-1", "gjc-project-admin-project-session-session-one")).toMatchObject({
			title: "Admin Session",
		});
	});

	test("closes a managed generation through lifecycle retirement and replays the completed operation", async () => {
		const workspace = await createAdapterWorkspace("gjc-managed-close-");
		const projectDirectory = path.join(workspace, "Managed Project");
		await fs.mkdir(projectDirectory, { recursive: true });
		const managed = managedCloseRuntime("retired");
		const fenceKeys: string[] = [];
		const options = await buildAdapterServerOptionsFromEnv(adapterEnv(workspace), {
			managedSdkRuntime: managed.runtime,
			managedSdkTenantFence: (key => {
				fenceKeys.push(`${key.sessionId}:${key.generation}`);
				return true;
			}) satisfies ManagedSdkTenantFence,
		});
		const routes = options.routes;
		if (routes?.closeSession === undefined || routes.projectLinkService === undefined)
			throw new Error("expected project close route");
		const mapping = await linkManagedProject(
			options,
			projectDirectory,
			"Managed Project",
			"managed-session",
			"managed-request",
		);
		const mappings = managedMappings(options);
		const ingress = { ingressId: "managed-close", ingressHash: "managed-close" };
		await expect(
			routes.closeSession(
				mappings.getScoped({ principalId: mapping.principalId!, chatId: mapping.chatId })!,
				ingress,
			),
		).resolves.toEqual({ status: "closed" });
		expect(managed.requests).toEqual(["managed-close"]);
		expect(managed.calls).toEqual(["close", "reconcile", "status"]);
		expect(fenceKeys).toEqual(["managed-session:7", "managed-session:7", "managed-session:7"]);
		expect(
			mappings.operationScoped({ principalId: mapping.principalId!, chatId: mapping.chatId }, ingress.ingressId),
		).toMatchObject({ state: "complete" });
		await expect(
			routes.closeSession(
				mappings.getScoped({ principalId: mapping.principalId!, chatId: mapping.chatId })!,
				ingress,
			),
		).resolves.toEqual({ status: "closed" });
		expect(managed.requests).toEqual(["managed-close"]);
	});
	test("fails closed when the managed tenant lease fence is unavailable", async () => {
		const workspace = await createAdapterWorkspace("gjc-managed-close-unwired-");
		const projectDirectory = path.join(workspace, "Managed Unwired");
		await fs.mkdir(projectDirectory, { recursive: true });
		const managed = managedCloseRuntime("current");
		const options = await buildAdapterServerOptionsFromEnv(adapterEnv(workspace), {
			managedSdkRuntime: managed.runtime,
			managedSdkTenantFence: () => false,
		});
		const routes = options.routes;
		if (routes?.closeSession === undefined || routes.projectLinkService === undefined)
			throw new Error("expected project close route");
		const mapping = await linkManagedProject(
			options,
			projectDirectory,
			"Managed Unwired",
			"managed-unwired",
			"managed-unwired-request",
		);
		const mappings = managedMappings(options);
		await expect(
			routes.closeSession(mappings.getScoped({ principalId: mapping.principalId!, chatId: mapping.chatId })!, {
				ingressId: "managed-unwired-close",
				ingressHash: "managed-unwired-close",
			}),
		).resolves.toMatchObject({ status: "uncertain" });
		expect(
			mappings.operationScoped(
				{ principalId: mapping.principalId!, chatId: mapping.chatId },
				"managed-unwired-close",
			),
		).toMatchObject({ state: "conflict" });
	});
	test("runs V3 workspace admin cleanup through managed retirement before evicting the exact generation", async () => {
		const workspace = await createAdapterWorkspace("gjc-managed-cleanup-");
		const projectDirectory = path.join(workspace, "Managed Cleanup Project");
		await fs.mkdir(projectDirectory, { recursive: true });
		const managed = managedCloseRuntime("retired");
		const options = await buildAdapterServerOptionsFromEnv(
			{ ...adapterEnv(workspace), GJC_OPENWEBUI_OWNER_USER_ID: "admin-test" },
			{
				managedSdkRuntime: managed.runtime,
				managedSdkTenantFence: (() => true) satisfies ManagedSdkTenantFence,
			},
		);
		try {
			const routes = options.routes;
			if (
				routes?.workspaceCleanupService === undefined ||
				routes.workspaceRegistry === undefined ||
				routes.projectLinkService === undefined
			)
				throw new Error("expected workspace cleanup routes");
			const userWorkspace = await routes.workspaceRegistry.open("owner-test");
			const linked = await routes.projectLinkService.linkProject({
				cwd: projectDirectory,
				name: "Managed Cleanup Project",
			});
			const mapping = await managedProjectMapping(
				linked.project.id,
				userWorkspace.root,
				userWorkspace.safeKey,
				"managed-cleanup",
				"managed-cleanup-request",
			);
			seedManagedMapping(options, mapping);
			const mappings = managedMappings(options);
			const preview = await routes.workspaceCleanupService.preview({ userId: "owner-test" });
			if (preview.confirmationToken === undefined) throw new Error("expected cleanup confirmation token");
			await expect(
				routes.workspaceCleanupService.cleanup({
					userId: "owner-test",
					confirmationToken: preview.confirmationToken,
				}),
			).resolves.toMatchObject({ status: "removed", outcome: "success" });
			expect(managed.requests).toHaveLength(1);
			expect(managed.calls).toEqual(["close", "reconcile", "status"]);
			expect(mappings.getScoped({ principalId: mapping.principalId!, chatId: mapping.chatId })).toBeUndefined();
		} finally {
			await options.shutdownCleanup?.();
		}
	});
	test("fails closed for managed unknown, replaced, non-dispatch, and fence-loss outcomes", async () => {
		const workspace = await createAdapterWorkspace("gjc-managed-close-outcomes-");
		const projectDirectory = path.join(workspace, "Managed Outcomes");
		await fs.mkdir(projectDirectory, { recursive: true });
		const managed = managedCloseRuntime("unknown");
		let fenceOpen = true;
		const options = await buildAdapterServerOptionsFromEnv(adapterEnv(workspace), {
			managedSdkRuntime: managed.runtime,
			managedSdkTenantFence: (key => fenceOpen && key.generation === 7) satisfies ManagedSdkTenantFence,
		});
		const routes = options.routes;
		if (routes?.closeSession === undefined || routes.projectLinkService === undefined)
			throw new Error("expected project close route");
		const mapping = await linkManagedProject(
			options,
			projectDirectory,
			"Managed Outcomes",
			"managed-outcomes",
			"outcome-request",
		);
		const mappings = managedMappings(options);
		const close = (ingressId: string) =>
			routes.closeSession!(mappings.getScoped({ principalId: mapping.principalId!, chatId: mapping.chatId })!, {
				ingressId,
				ingressHash: ingressId,
			});
		await expect(close("managed-unknown")).resolves.toMatchObject({ status: "uncertain" });
		expect(
			mappings.operationScoped({ principalId: mapping.principalId!, chatId: mapping.chatId }, "managed-unknown"),
		).toMatchObject({ state: "conflict" });
		managed.status = "replaced";
		await expect(close("managed-replaced")).resolves.toMatchObject({ status: "uncertain" });
		managed.status = "current";
		managed.outcome = { ok: false, certainty: "retryable" };
		await expect(close("managed-not-dispatched")).resolves.toMatchObject({ status: "unavailable" });
		managed.throws = true;
		fenceOpen = true;
		await expect(close("managed-throws")).resolves.toMatchObject({ status: "uncertain" });
		expect(
			mappings.operationScoped({ principalId: mapping.principalId!, chatId: mapping.chatId }, "managed-throws"),
		).toMatchObject({ state: "uncertain" });
		managed.throws = false;
		fenceOpen = false;
		await expect(close("managed-fence-lost")).resolves.toMatchObject({ status: "uncertain" });
		expect(managed.requests).toEqual(["managed-unknown", "managed-replaced", "managed-not-dispatched"]);
	});

	test("supports OpenWebUI chat slash commands through the regular gjc model", async () => {
		const workspace = await createAdapterWorkspace("gjc-project-admin-");
		const projectDirectory = path.join(workspace, "Slash Project");
		await fs.mkdir(projectDirectory);
		const service = await createProjectService(workspace);
		const handler = createAdapterRequestHandler({
			routes: {
				projects: [],
				projectProvider: () => service.listLinkedProjects(),
				projectLinkService: service,
				owner,
				runner: fixedRunner("unused"),
				adapterApiToken: "adapter-token",
				requireAdapterApiToken: true,
				modelReaderFactory,
			},
		});

		const linked = await handler(
			chatCommandRequest({
				model: "gjc",
				messages: [{ role: "user", content: `/gjc project link ${projectDirectory}` }],
			}),
		);
		expect(linked.status).toBe(200);
		const linkedBody = (await linked.json()) as ChatCompletionBody;
		expect(linkedBody.choices[0].message.content).toContain("Linked slash-project");
		expect(await modelIds(handler)).toEqual([...CANONICAL_MODEL_IDS]);

		const unlinked = await handler(
			chatCommandRequest({
				model: "gjc",
				messages: [{ role: "user", content: "/gjc project unlink slash-project" }],
			}),
		);
		expect(unlinked.status).toBe(200);
		const unlinkedBody = (await unlinked.json()) as ChatCompletionBody;
		expect(unlinkedBody.choices[0].message.content).toContain("Unlinked slash-project");
		expect(await modelIds(handler)).toEqual([...CANONICAL_MODEL_IDS]);
	});

	test("rejects admin link requests outside allowed roots", async () => {
		const workspace = await createAdapterWorkspace("gjc-project-admin-");
		const outside = await createAdapterWorkspace("gjc-project-admin-outside-");
		const service = await createProjectService(workspace);
		const handler = createAdapterRequestHandler({
			routes: {
				projects: [],
				projectProvider: () => service.listLinkedProjects(),
				projectLinkService: service,
				owner,
				runner: fixedRunner("unused"),
				adapterApiToken: "adapter-token",
				requireAdapterApiToken: true,
			},
		});

		const response = await handler(jsonRequest("http://adapter.test/admin/projects/link", { cwd: outside }));

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code: "invalid_project_link" } });
	});
	test.skipIf(!supportsPermissionDeniedPathTest)(
		"maps canonicalization permission denial to invalid project input",
		async () => {
			const workspace = await createAdapterWorkspace("gjc-project-admin-permission-");
			const lockedParent = path.join(workspace, "locked");
			const projectDirectory = path.join(lockedParent, "project");
			await fs.mkdir(projectDirectory, { recursive: true });
			const service = await createProjectService(workspace);
			const handler = createAdapterRequestHandler({
				routes: {
					projects: [],
					projectProvider: () => service.listLinkedProjects(),
					projectLinkService: service,
					owner,
					runner: fixedRunner("unused"),
					adapterApiToken: "adapter-token",
					requireAdapterApiToken: true,
				},
			});

			await fs.chmod(lockedParent, 0o000);
			try {
				const response = await handler(
					jsonRequest("http://adapter.test/admin/projects/link", { cwd: projectDirectory }),
				);
				expect(response.status).toBe(400);
				expect(await response.json()).toMatchObject({
					error: { code: "invalid_project_link" },
				});
			} finally {
				await fs.chmod(lockedParent, 0o755);
			}
		},
	);

	test("rejects malformed optional link fields with a client error", async () => {
		const workspace = await createAdapterWorkspace("gjc-project-admin-");
		const projectDirectory = path.join(workspace, "Bad Link Body");
		await fs.mkdir(projectDirectory);
		const service = await createProjectService(workspace);
		const handler = createAdapterRequestHandler({
			routes: {
				projects: [],
				projectProvider: () => service.listLinkedProjects(),
				projectLinkService: service,
				owner,
				runner: fixedRunner("unused"),
				adapterApiToken: "adapter-token",
				requireAdapterApiToken: true,
			},
		});

		const response = await handler(
			jsonRequest("http://adapter.test/admin/projects/link", { cwd: projectDirectory, name: 42 }),
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: { code: "invalid_project_link", type: "invalid_request_error" },
		});
	});

	test("preserves a completed project mutation when later alias canonicalization fails", async () => {
		const workspace = await createAdapterWorkspace("gjc-project-admin-");
		const projectDirectory = path.join(workspace, "Durable Project");
		await fs.mkdir(projectDirectory);
		const service = await createProjectService(workspace);
		const handler = createAdapterRequestHandler({
			routes: {
				projects: [],
				projectLinkService: service,
				owner,
				runner: fixedRunner("unused"),
				modelReaderFactory: () => Promise.reject(new Error("reader path must stay private")),
			},
		});
		const response = await handler(
			chatCommandRequest({
				model: "gjc",
				messages: [{ role: "user", content: `/gjc project link ${projectDirectory}` }],
			}),
		);
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ error: { code: "model_selection_default_read_failed" } });
		expect(service.listLinkedProjects()).toHaveLength(1);
	});
});

const owner: OpenWebUIOwnerContext = { ownerUserId: "owner-1", singleOwnerLocalMode: false };

async function createAdapterWorkspace(prefix: string): Promise<string> {
	const workspace = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(workspace);
	await writeDirectV3Authority(path.join(workspace, "state"));
	return workspace;
}

async function createProjectService(workspace: string): Promise<ProjectLinkService> {
	return new ProjectLinkService({
		allowedRoots: await resolveAllowedRoots([workspace]),
		store: new SqliteProjectRegistrationStore(":memory:"),
		ownerUserId: "owner-1",
		protectedPaths: resolveGjcRuntimeLocations({ mode: "existing", serviceHome: workspace }).protectedProjectPaths,
	});
}

function fixedRunner(content: string): LiveGatewayRunner {
	return { run: () => ({ content, model: LOW_MODEL_ID }) };
}

const modelReaderFactory = staticModelReaderFactory();

function adapterEnv(workspace: string): Record<string, string | undefined> {
	return {
		...process.env,
		GJC_OPENWEBUI_MODE: "existing",
		GJC_OPENWEBUI_BIND_HOST: "127.0.0.1",
		GJC_OPENWEBUI_BIND_PORT: "8765",
		GJC_OPENWEBUI_ADAPTER_API_TOKEN: "adapter-token",
		GJC_OPENWEBUI_OWNER_USER_ID: "owner-1",
		GJC_OPENWEBUI_ALLOWED_PROJECT_ROOTS: workspace,
		GJC_OPENWEBUI_SESSION_ROOT: path.join(workspace, "state"),
		GJC_OPENWEBUI_STATE_PATH: path.join(workspace, "adapter-state"),
		GJC_OPENWEBUI_PROJECTS: "",
	};
}

function managedProjectMapping(
	projectId: string,
	cwd: string,
	safeKey: string,
	sessionId: string,
	requestKey: string,
	chatId = "dynamic-chat",
): SessionMapping {
	const authority = managedAuthority(
		cwd,
		projectId,
		sessionId,
		requestKey,
		chatId,
		workspaceLeaseId({
			safeKey,
			holderId: `managed-${sessionId}`,
			generation: 1,
			operation: "close",
		}),
	);
	return {
		chatId,
		principalId: authority.principalId,
		projectId,
		sessionId,
		rawFrameCursor: 0,
		eventCursor: 0,
		operationId: "dynamic-operation",
		managedAuthority: authority,
	};
}

function managedAuthority(
	cwd: string,
	projectId: string,
	sessionId: string,
	requestKey: string,
	chatId: string,
	leaseId: string,
): ManagedTurnAuthority {
	return {
		principalId: "owner-test",
		projectId,
		canonicalWorkspace: path.resolve(cwd),
		chatId,
		sessionId,
		generation: 7,
		leaseId,
		epoch: SESSION_AUTHORITY_V3_EPOCH,
		requestKey,
		authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
	} as ManagedTurnAuthority;
}

async function linkManagedProject(
	options: Awaited<ReturnType<typeof buildAdapterServerOptionsFromEnv>>,
	projectDirectory: string,
	name: string,
	sessionId: string,
	requestKey: string,
	chatId = "dynamic-chat",
): Promise<SessionMapping> {
	const routes = options.routes;
	if (routes?.projectLinkService === undefined || routes.workspaceRegistry === undefined)
		throw new Error("expected managed project routes");
	const linked = await routes.projectLinkService.linkProject({ cwd: projectDirectory, name });
	const workspace = await routes.workspaceRegistry.open("owner-test");
	const mapping = managedProjectMapping(
		linked.project.id,
		workspace.root,
		workspace.safeKey,
		sessionId,
		requestKey,
		chatId,
	);
	seedManagedMapping(options, mapping);
	return mapping;
}

function managedMappings(options: Awaited<ReturnType<typeof buildAdapterServerOptionsFromEnv>>): SessionMappingStore {
	const mappings = options.routes?.mappings;
	if (mappings === undefined) throw new Error("expected managed V3 mapping store");
	return mappings as SessionMappingStore;
}

function seedManagedMapping(
	options: Awaited<ReturnType<typeof buildAdapterServerOptionsFromEnv>>,
	mapping: SessionMapping,
): void {
	const mappings = managedMappings(options);
	if (mapping.principalId === undefined) throw new Error("managed mapping requires a principal");
	mappings.setScoped({ principalId: mapping.principalId, chatId: mapping.chatId }, mapping);
}

function managedCloseRuntime(initialStatus: "current" | "retired" | "replaced" | "unknown") {
	const runtime = new FakeManagedSdkRuntime() as unknown as ManagedSdkRuntimeDependency;
	const subject: {
		runtime: ManagedSdkRuntimeDependency;
		readonly calls: string[];
		readonly requests: string[];
		status: "current" | "retired" | "replaced" | "unknown";
		outcome: { ok: boolean; certainty?: string };
		throws: boolean;
	} = {
		runtime,
		calls: [],
		requests: [],
		status: initialStatus,
		outcome: { ok: true },
		throws: false,
	};
	const reconcile = runtime.reconcile.bind(runtime);
	runtime.reconcile = async () => {
		subject.calls.push("reconcile");
		await reconcile();
	};
	runtime.generationStatus = async () => {
		subject.calls.push("status");
		return { status: subject.status === "unknown" ? "current" : subject.status } as never;
	};
	const close = runtime.closeLifecycleSession.bind(runtime);
	runtime.closeLifecycleSession = async (tenantOrRequest, request) => {
		if (subject.throws) throw new Error("managed close transport failed");
		const lifecycleRequest = request ?? tenantOrRequest;
		subject.calls.push("close");
		const target =
			typeof lifecycleRequest === "object" && lifecycleRequest !== null
				? Reflect.get(lifecycleRequest, "target")
				: undefined;
		if (
			typeof lifecycleRequest !== "object" ||
			lifecycleRequest === null ||
			Reflect.get(lifecycleRequest, "capability") !== "session.close" ||
			typeof target !== "object" ||
			target === null ||
			Reflect.get(target, "endpointGeneration") !== 7 ||
			typeof Reflect.get(target, "sessionId") !== "string"
		)
			throw new Error("managed close fixture requires the exact session generation");
		const requestKey =
			typeof lifecycleRequest === "object" &&
			lifecycleRequest !== null &&
			typeof Reflect.get(lifecycleRequest, "requestKey") === "string"
				? (Reflect.get(lifecycleRequest, "requestKey") as string)
				: "";
		subject.requests.push(requestKey);
		await close(tenantOrRequest, request);
		return { ok: subject.outcome.ok, certainty: subject.outcome.certainty } as never;
	};
	return subject;
}
function jsonRequest(url: string, body: unknown): Request {
	return new Request(url, {
		method: "POST",
		headers: {
			authorization: "Bearer adapter-token",
			"content-type": "application/json",
			"X-OpenWebUI-User-Id": "owner-1",
		},
		body: JSON.stringify(body),
	});
}

function chatCommandRequest(
	body: unknown,
	options: { readonly userId?: string; readonly task?: string } = {},
): Request {
	const headers = new Headers({
		authorization: "Bearer adapter-token",
		"content-type": "application/json",
		"X-OpenWebUI-Chat-Id": "chat-1",
		"X-OpenWebUI-Message-Id": "assistant-1",
		"X-OpenWebUI-User-Message-Id": "user-1",
		"X-OpenWebUI-User-Message-Parent-Id": "",
		"X-OpenWebUI-User-Id": options.userId ?? "owner-1",
	});
	if (options.task !== undefined) headers.set("X-OpenWebUI-Task", options.task);
	return new Request("http://adapter.test/v1/chat/completions", {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
}

async function modelIds(handler: (request: Request) => Response | Promise<Response>): Promise<string[]> {
	const response = await handler(
		new Request("http://adapter.test/v1/models", {
			headers: { authorization: "Bearer adapter-token", "X-OpenWebUI-User-Id": "owner-1" },
		}),
	);
	expect(response.status).toBe(200);
	const body = (await response.json()) as { data: { id: string }[] };
	return body.data.map((model: { id: string }) => model.id);
}

type ChatCompletionBody = {
	readonly choices: readonly [{ readonly message: { readonly content: string } }];
};
