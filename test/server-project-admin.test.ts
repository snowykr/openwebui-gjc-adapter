import { afterEach, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildAdapterServerOptionsFromEnv } from "../src/adapter-server-options";
import { resolveGjcRuntimeLocations } from "../src/configure/runtime-locations";
import type { PublicSdkSessionPort } from "../src/gjc/public-sdk-contract";
import {
	attachmentFromPublishedSdkEndpoint,
	readPublishedSdkEndpointDescriptor,
} from "../src/gjc/public-sdk-session-port";
import { SESSION_AUTHORITY_V3_EPOCH } from "../src/gjc/session-authority-v3";
import { type SessionMapping, SessionMappingStore } from "../src/gjc/session-router";
import {
	GjcCloseReceipt,
	type GjcLifecyclePublicationAddress,
	type ManagedTurnAuthority,
} from "../src/gjc/turn-runner";
import type { LiveGatewayRunner } from "../src/live/chat-completions";
import type { ManagedSdkRuntimeDependency, ManagedSdkTenantFence } from "../src/live/gjc-routing-lifecycle";
import type { OpenWebUIOwnerContext } from "../src/openwebui/auth";
import { InMemoryOpenWebUIProjectionRepository } from "../src/openwebui/client";
import { ProjectLinkService } from "../src/projects/link-service";
import { SqliteProjectRegistrationStore } from "../src/projects/registration-store";
import { resolveAllowedRoots } from "../src/security/paths";
import { createAdapterRequestHandler } from "../src/server";
import { FakeGjcTurnRunner } from "./cli-fixtures";
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
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-admin-"));
		tempDirs.push(workspace);
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
			mappings: new SessionMappingStore(),
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
	test("returns uncertainty without remote or fallback effects for endpoint-only close attachments", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-live-close-"));
		tempDirs.push(workspace);
		const projectDirectory = path.join(workspace, "Dynamic Project");
		const sessionId = "dynamic-session";
		await fs.mkdir(path.join(projectDirectory, ".gjc", "state", "sdk"), { recursive: true });
		await fs.writeFile(
			path.join(projectDirectory, ".gjc", "state", "sdk", `${sessionId}.json`),
			JSON.stringify({ url: "ws://127.0.0.1:9876", token: "healthy-token" }),
		);
		const mappings = new SessionMappingStore();
		const calls: string[] = [];
		let fallbackCalls = 0;
		const options = await buildAdapterServerOptionsFromEnv(adapterEnv(workspace), {
			turnRunner: strictCloseTurnRunner(),
			mappings,
			modelReaderFactory,
			sessionPortFactory: () => ({
				async attach(attachment) {
					calls.push(`attach:${attachment.cwd}:${attachment.endpoint.url}`);
				},
				async closeSession() {
					calls.push("close");
				},
				detach() {
					calls.push("detach");
				},
				async getState() {
					return unexpectedSessionPortCall("getState");
				},
				async getAvailableModels() {
					return unexpectedSessionPortCall("getAvailableModels");
				},
				async getActiveProviders() {
					return unexpectedSessionPortCall("getActiveProviders");
				},
				async setModel() {
					return unexpectedSessionPortCall("setModel");
				},
				async setThinking() {
					return unexpectedSessionPortCall("setThinking");
				},
				async prompt() {
					return unexpectedSessionPortCall("prompt");
				},
				async reply() {
					return unexpectedSessionPortCall("reply");
				},
				async steer() {
					return unexpectedSessionPortCall("steer");
				},
				async followUp() {
					return unexpectedSessionPortCall("followUp");
				},
				async abort() {
					return unexpectedSessionPortCall("abort");
				},
				async abortAndPrompt() {
					return unexpectedSessionPortCall("abortAndPrompt");
				},
				async replyToAction() {
					return unexpectedSessionPortCall("replyToAction");
				},
				async planApprove() {
					return unexpectedSessionPortCall("planApprove");
				},
				async answerGate() {
					return unexpectedSessionPortCall("answerGate");
				},
				async branchCandidates() {
					return unexpectedSessionPortCall("branchCandidates");
				},
				async branch() {
					return unexpectedSessionPortCall("branch");
				},
				async newSession() {
					return unexpectedSessionPortCall("newSession");
				},
				async resumeSession() {
					return unexpectedSessionPortCall("resumeSession");
				},
			}),
			fallbackCloseSession: async () => {
				fallbackCalls += 1;
				return { status: "closed", message: "fallback" };
			},
			proveClosedSession: async () => ({ status: "closed", message: "public SDK close proven" }),
		});
		const routes = options.routes;
		if (routes?.projectLinkService === undefined || routes.closeSession === undefined)
			throw new Error("expected project close routes");
		const linked = await routes.projectLinkService.linkProject({ cwd: projectDirectory, name: "Dynamic Project" });
		const mapping = await currentLifecycleMapping(linked.project.id, sessionId, projectDirectory);
		mappings.setScoped({ principalId: "owner-1", chatId: mapping.chatId }, { ...mapping, principalId: "owner-1" });
		await expect(
			routes.closeSession(mappings.getScoped({ principalId: "owner-1", chatId: "dynamic-chat" })!, {
				ingressId: "direct-close",
				ingressHash: "direct-close",
			}),
		).resolves.toMatchObject({
			status: "uncertain",
		});
		const unlinked = await routes.projectLinkService.unlinkProject(linked.project.id);
		expect(unlinked.closeResults).toMatchObject([{ chatId: "dynamic-chat", result: { status: "uncertain" } }]);
		expect(calls).toEqual([]);
		expect(fallbackCalls).toBe(0);
	});
	test("closes a managed generation through public lifecycle retirement and replays without legacy lifecycle", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-close-"));
		tempDirs.push(workspace);
		const projectDirectory = path.join(workspace, "Managed Project");
		await fs.mkdir(projectDirectory, { recursive: true });
		const mappings = new SessionMappingStore();
		const managed = managedCloseRuntime("retired");
		const fenceKeys: string[] = [];
		const turnRunner = strictCloseTurnRunner();
		let legacyPreflights = 0;
		turnRunner.withLifecycleClosePreflight = async () => {
			legacyPreflights += 1;
			throw new Error("managed close must not enter the legacy lifecycle");
		};
		const options = await buildAdapterServerOptionsFromEnv(adapterEnv(workspace), {
			turnRunner,
			mappings,
			modelReaderFactory,
			managedSdkRuntime: managed.runtime,
			managedSdkTenantFence: (key => {
				fenceKeys.push(`${key.sessionId}:${key.generation}`);
				return true;
			}) satisfies ManagedSdkTenantFence,
		});
		const routes = options.routes;
		if (routes?.closeSession === undefined) throw new Error("expected project close route");
		const authority = managedAuthority(projectDirectory, "managed-session", "managed-request");
		const mapping = { ...mappingFor("managed-project", "managed-session"), managedAuthority: authority };
		mappings.setScoped({ principalId: authority.principalId, chatId: mapping.chatId }, mapping);
		const ingress = { ingressId: "managed-close", ingressHash: "managed-close" };
		await expect(
			routes.closeSession(
				mappings.getScoped({ principalId: authority.principalId, chatId: mapping.chatId })!,
				ingress,
			),
		).resolves.toEqual({ status: "closed" });
		expect(managed.requests).toEqual(["managed-close"]);
		expect(managed.calls).toEqual(["close", "reconcile", "status"]);
		expect(fenceKeys).toEqual(["managed-session:7", "managed-session:7", "managed-session:7"]);
		expect(legacyPreflights).toBe(0);
		expect(
			mappings.operationScoped({ principalId: authority.principalId, chatId: mapping.chatId }, ingress.ingressId),
		).toMatchObject({ state: "complete" });
		await expect(
			routes.closeSession(
				mappings.getScoped({ principalId: authority.principalId, chatId: mapping.chatId })!,
				ingress,
			),
		).resolves.toEqual({ status: "closed" });
		expect(managed.requests).toEqual(["managed-close"]);
	});
	test("fails closed without managed runtime and fence instead of entering legacy lifecycle", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-close-unwired-"));
		tempDirs.push(workspace);
		const projectDirectory = path.join(workspace, "Managed Unwired");
		await fs.mkdir(projectDirectory, { recursive: true });
		const mappings = new SessionMappingStore();
		const turnRunner = strictCloseTurnRunner();
		let legacyPreflights = 0;
		turnRunner.withLifecycleClosePreflight = async () => {
			legacyPreflights += 1;
			throw new Error("managed close must not enter the legacy lifecycle");
		};
		const options = await buildAdapterServerOptionsFromEnv(adapterEnv(workspace), {
			turnRunner,
			mappings,
			modelReaderFactory,
		});
		const routes = options.routes;
		if (routes?.closeSession === undefined) throw new Error("expected project close route");
		const authority = managedAuthority(projectDirectory, "managed-unwired", "managed-unwired-request");
		const mapping = { ...mappingFor("managed-project", "managed-unwired"), managedAuthority: authority };
		mappings.setScoped({ principalId: authority.principalId, chatId: mapping.chatId }, mapping);
		await expect(
			routes.closeSession(mappings.getScoped({ principalId: authority.principalId, chatId: mapping.chatId })!, {
				ingressId: "managed-unwired-close",
				ingressHash: "managed-unwired-close",
			}),
		).resolves.toMatchObject({ status: "uncertain" });
		expect(legacyPreflights).toBe(0);
		expect(
			mappings.operationScoped(
				{ principalId: authority.principalId, chatId: mapping.chatId },
				"managed-unwired-close",
			),
		).toBeUndefined();
	});
	test("runs V3 workspace admin cleanup through managed retirement before evicting the exact generation", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-cleanup-"));
		tempDirs.push(workspace);
		const mappings = new SessionMappingStore();
		const managed = managedCloseRuntime("retired");
		const turnRunner = strictCloseTurnRunner();
		let legacyPreflights = 0;
		turnRunner.withLifecycleClosePreflight = async () => {
			legacyPreflights += 1;
			throw new Error("managed cleanup must not enter the legacy lifecycle");
		};
		const options = await buildAdapterServerOptionsFromEnv(
			{ ...adapterEnv(workspace), GJC_OPENWEBUI_OWNER_USER_ID: "admin-test" },
			{
				turnRunner,
				mappings,
				modelReaderFactory,
				managedSdkRuntime: managed.runtime,
				managedSdkTenantFence: (() => true) satisfies ManagedSdkTenantFence,
			},
		);
		try {
			const routes = options.routes;
			if (routes?.workspaceCleanupService === undefined || routes.workspaceRegistry === undefined)
				throw new Error("expected workspace cleanup routes");
			const userWorkspace = await routes.workspaceRegistry.open("owner-test");
			const authority = managedAuthority(userWorkspace.root, "managed-cleanup", "managed-cleanup-request");
			const mapping = {
				...mappingFor("managed-project", "managed-cleanup"),
				managedAuthority: authority,
			};
			mappings.setScoped({ principalId: authority.principalId, chatId: mapping.chatId }, mapping);
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
			expect(legacyPreflights).toBe(0);
			expect(mappings.getScoped({ principalId: authority.principalId, chatId: mapping.chatId })).toBeUndefined();
		} finally {
			await options.shutdownCleanup?.();
		}
	});
	test("fails closed for managed unknown, replaced, non-dispatch, and fence-loss outcomes", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-close-outcomes-"));
		tempDirs.push(workspace);
		const projectDirectory = path.join(workspace, "Managed Outcomes");
		await fs.mkdir(projectDirectory, { recursive: true });
		const mappings = new SessionMappingStore();
		const managed = managedCloseRuntime("unknown");
		let fenceOpen = true;
		const options = await buildAdapterServerOptionsFromEnv(adapterEnv(workspace), {
			turnRunner: strictCloseTurnRunner(),
			mappings,
			modelReaderFactory,
			managedSdkRuntime: managed.runtime,
			managedSdkTenantFence: (key => fenceOpen && key.generation === 7) satisfies ManagedSdkTenantFence,
		});
		const routes = options.routes;
		if (routes?.closeSession === undefined) throw new Error("expected project close route");
		const authority = managedAuthority(projectDirectory, "managed-outcomes", "outcome-request");
		const mapping = { ...mappingFor("managed-project", "managed-outcomes"), managedAuthority: authority };
		mappings.setScoped({ principalId: authority.principalId, chatId: mapping.chatId }, mapping);
		const close = (ingressId: string) =>
			routes.closeSession!(mappings.getScoped({ principalId: authority.principalId, chatId: mapping.chatId })!, {
				ingressId,
				ingressHash: ingressId,
			});
		await expect(close("managed-unknown")).resolves.toMatchObject({ status: "uncertain" });
		expect(
			mappings.operationScoped({ principalId: authority.principalId, chatId: mapping.chatId }, "managed-unknown"),
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
			mappings.operationScoped({ principalId: authority.principalId, chatId: mapping.chatId }, "managed-throws"),
		).toMatchObject({ state: "uncertain" });
		managed.throws = false;
		fenceOpen = false;
		await expect(close("managed-fence-lost")).resolves.toMatchObject({ status: "uncertain" });
		expect(managed.requests).toEqual(["managed-unknown", "managed-replaced", "managed-not-dispatched"]);
	});
	test("uses exact owned /exit proof without invoking released SDK session.close and replays the completed close", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-default-close-wiring-"));
		tempDirs.push(workspace);
		const projectDirectory = path.join(workspace, "Default Project");
		const sessionId = "default-close-session";
		const socket = `gjc-close-${process.pid}-${Date.now()}`;
		const descriptor = path.join(projectDirectory, ".gjc", "state", "sdk", `${sessionId}.json`);
		const trace = path.join(workspace, "close-trace");
		await fs.mkdir(path.dirname(descriptor), { recursive: true });
		await writeSdkDescriptor(projectDirectory, sessionId, { url: "ws://127.0.0.1:9876", token: "healthy-token" });
		const started = await runTmux(socket, [
			"new-session",
			"-d",
			"-P",
			"-F",
			"#{pane_id}|#{pane_pid}",
			"-s",
			"default-close",
			"--",
			"sh",
			"-c",
			`while IFS= read -r line; do if [ "$line" = /exit ]; then printf 'exit\n' >> '${trace}'; sleep 0.1; rm -f '${descriptor}'; exit; fi; done`,
		]);
		if (started.exitCode !== 0) throw new Error(started.stderr);
		const [tmuxPane, pid] = started.stdout.trim().split("|");
		if (tmuxPane === undefined || pid === undefined) throw new Error("tmux did not return a pane");
		const owner = "default-close-owner";
		await expect(
			runTmux(socket, ["set-option", "-p", "-t", tmuxPane, "@openwebui_gjc_owner", owner]),
		).resolves.toMatchObject({ exitCode: 0 });
		const mappings = new SessionMappingStore();
		const calls: string[] = [];
		const options = await buildAdapterServerOptionsFromEnv(
			{ ...adapterEnv(workspace), GJC_OPENWEBUI_GJC_COMMAND: "/bin/true" },
			{
				turnRunner: strictCloseTurnRunner(),
				mappings,
				modelReaderFactory,
				sessionPortFactory: (): PublicSdkSessionPort => ({
					async attach() {
						calls.push("attach");
					},
					detach() {
						calls.push("detach");
					},
					async closeSession() {
						calls.push("close");
					},
					async getState() {
						return unexpectedSessionPortCall("getState");
					},
					async getAvailableModels() {
						return unexpectedSessionPortCall("getAvailableModels");
					},
					async getActiveProviders() {
						return unexpectedSessionPortCall("getActiveProviders");
					},
					async setModel() {
						return unexpectedSessionPortCall("setModel");
					},
					async setThinking() {
						return unexpectedSessionPortCall("setThinking");
					},
					async prompt() {
						return unexpectedSessionPortCall("prompt");
					},
					async reply() {
						return unexpectedSessionPortCall("reply");
					},
					async steer() {
						return unexpectedSessionPortCall("steer");
					},
					async followUp() {
						return unexpectedSessionPortCall("followUp");
					},
					async abort() {
						return unexpectedSessionPortCall("abort");
					},
					async abortAndPrompt() {
						return unexpectedSessionPortCall("abortAndPrompt");
					},
					async replyToAction() {
						return unexpectedSessionPortCall("replyToAction");
					},
					async planApprove() {
						return unexpectedSessionPortCall("planApprove");
					},
					async answerGate() {
						return unexpectedSessionPortCall("answerGate");
					},
					async branchCandidates() {
						return unexpectedSessionPortCall("branchCandidates");
					},
					async branch() {
						return unexpectedSessionPortCall("branch");
					},
					async newSession() {
						return unexpectedSessionPortCall("newSession");
					},
					async resumeSession() {
						return unexpectedSessionPortCall("resumeSession");
					},
				}),
			},
		);
		const routes = options.routes;
		if (routes?.projectLinkService === undefined || routes.closeSession === undefined)
			throw new Error("expected project close routes");
		const linked = await routes.projectLinkService.linkProject({ cwd: projectDirectory, name: "Default Project" });
		const mapping = {
			...mappingFor(linked.project.id, sessionId),
			attachment: {
				...(await currentSdkAttachment(projectDirectory, sessionId)).authority!,
				tmuxSocket: socket,
				tmuxPane,
				tmuxPanePid: Number(pid),
				tmuxOwnershipTag: owner,
			},
		};
		mappings.setScoped({ principalId: "owner-test", chatId: mapping.chatId }, mapping);
		const closeIngress = { ingressId: "default-close", ingressHash: "default-close" };
		await expect(
			routes.closeSession(mappings.getScoped({ principalId: "owner-test", chatId: "dynamic-chat" })!, closeIngress),
		).resolves.toEqual({
			status: "closed",
		});
		expect(calls).toEqual([]);
		expect(await fs.readFile(trace, "utf8")).toBe("exit\n");
		expect(await readPublishedSdkEndpointDescriptor(projectDirectory, sessionId)).toBeNull();
		const pane = await runTmux(socket, ["display-message", "-p", "-t", tmuxPane, "#{pane_id}"]);
		expect(pane.exitCode).not.toBe(0);
		expect(mappings.getScoped({ principalId: "owner-test", chatId: "dynamic-chat" })).toBeDefined();
		expect(
			mappings.operationScoped({ principalId: "owner-test", chatId: "dynamic-chat" }, "default-close"),
		).toMatchObject({
			id: "default-close",
			kind: "close",
			state: "complete",
			ingressId: "default-close",
			detail: "default-close",
			result: {
				kind: "close",
				correlation: { closeStatus: "closed" },
				mapping: { chatId: "dynamic-chat", sessionId },
			},
		});
		await expect(
			routes.closeSession(mappings.getScoped({ principalId: "owner-test", chatId: "dynamic-chat" })!, closeIngress),
		).resolves.toEqual({
			status: "closed",
		});
		expect(calls).toEqual([]);
		await runTmux(socket, ["kill-server"]);
	});
	test("fails closed when exact descriptor or owned-pane proof cannot establish lifecycle closure", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-current-close-"));
		tempDirs.push(workspace);
		const projectDirectory = path.join(workspace, "Current Project");
		await fs.mkdir(projectDirectory);
		const sessionId = "same-id";
		await fs.mkdir(path.join(projectDirectory, ".gjc", "state", "sdk"), { recursive: true });
		await writeSdkDescriptor(projectDirectory, sessionId, {
			url: "ws://127.0.0.1:9876",
			token: "original-token",
			pid: 42,
		});
		const mappings = new SessionMappingStore();
		const discarded: string[] = [];
		const turnRunner = Object.assign(strictCloseTurnRunner(), {
			discardSessionAttachment(cwd: string, discardedSessionId: string) {
				discarded.push(`${cwd}:${discardedSessionId}`);
			},
		});
		let closes = 0;
		let proofs = 0;
		const options = await buildAdapterServerOptionsFromEnv(adapterEnv(workspace), {
			turnRunner,
			mappings,
			modelReaderFactory,
			sessionPortFactory: (): PublicSdkSessionPort => ({
				async attach() {},
				detach() {},
				async getState() {
					return unexpectedSessionPortCall("getState");
				},
				async getAvailableModels() {
					return unexpectedSessionPortCall("getAvailableModels");
				},
				async getActiveProviders() {
					return unexpectedSessionPortCall("getActiveProviders");
				},
				async setModel() {
					return unexpectedSessionPortCall("setModel");
				},
				async setThinking() {
					return unexpectedSessionPortCall("setThinking");
				},
				async prompt() {
					return unexpectedSessionPortCall("prompt");
				},
				async reply() {
					return unexpectedSessionPortCall("reply");
				},
				async steer() {
					return unexpectedSessionPortCall("steer");
				},
				async followUp() {
					return unexpectedSessionPortCall("followUp");
				},
				async abort() {
					return unexpectedSessionPortCall("abort");
				},
				async abortAndPrompt() {
					return unexpectedSessionPortCall("abortAndPrompt");
				},
				async replyToAction() {
					return unexpectedSessionPortCall("replyToAction");
				},
				async planApprove() {
					return unexpectedSessionPortCall("planApprove");
				},
				async answerGate() {
					return unexpectedSessionPortCall("answerGate");
				},
				async branchCandidates() {
					return unexpectedSessionPortCall("branchCandidates");
				},
				async branch() {
					return unexpectedSessionPortCall("branch");
				},
				async newSession() {
					return unexpectedSessionPortCall("newSession");
				},
				async resumeSession() {
					return unexpectedSessionPortCall("resumeSession");
				},
				async closeSession() {
					closes += 1;
				},
			}),
			proveClosedSession: async (_provenMapping, _attachment) => {
				proofs += 1;
				return { status: "closed", message: "current pane absent" };
			},
		});
		const routes = options.routes;
		if (routes?.projectLinkService === undefined || routes.closeSession === undefined)
			throw new Error("expected project close routes");
		const linked = await routes.projectLinkService.linkProject({ cwd: projectDirectory, name: "Current Project" });
		const pane = {
			tmuxSocket: "socket",
			tmuxPane: "%10",
			tmuxPanePid: 42,
			tmuxOwnershipTag: "owner",
			ownedAt: "2026-01-01T00:00:00.000Z",
		};
		const staleMapping = {
			...mappingFor(linked.project.id, sessionId),
			attachment: { ...(await currentSdkAttachment(projectDirectory, sessionId)).authority!, ...pane },
		};
		mappings.setScoped({ principalId: "owner-test", chatId: staleMapping.chatId }, staleMapping);

		await writeSdkDescriptor(projectDirectory, sessionId, {
			url: "ws://127.0.0.1:9876",
			token: "successor-token",
			pid: 42,
		});
		await expect(
			routes.closeSession(mappings.getScoped({ principalId: "owner-test", chatId: "dynamic-chat" })!, {
				ingressId: "stale-close",
				ingressHash: "stale-close",
			}),
		).resolves.toMatchObject({ status: "uncertain" });
		expect(closes).toBe(0);
		expect(proofs).toBe(0);
		expect(discarded).toEqual([]);

		const currentMapping = {
			...mappingFor(linked.project.id, sessionId),
			attachment: { ...(await currentSdkAttachment(projectDirectory, sessionId)).authority!, ...pane },
		};
		mappings.setScoped({ principalId: "owner-test", chatId: currentMapping.chatId }, currentMapping);
		await expect(
			routes.closeSession(mappings.getScoped({ principalId: "owner-test", chatId: "dynamic-chat" })!, {
				ingressId: "current-close",
				ingressHash: "current-close",
			}),
		).resolves.toMatchObject({ status: "uncertain" });
		expect(closes).toBe(0);
		expect(proofs).toBe(0);
		expect(discarded).toEqual([]);
	});
	test("keeps duplicate live session IDs isolated by canonical project cwd during close", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-close-isolation-"));
		tempDirs.push(workspace);
		const firstDirectory = path.join(workspace, "First Project");
		const secondDirectory = path.join(workspace, "Second Project");
		const sessionId = "shared-session";
		await Promise.all(
			[firstDirectory, secondDirectory].map(async (directory, index) => {
				await fs.mkdir(path.join(directory, ".gjc", "state", "sdk"), { recursive: true });
				await fs.writeFile(
					path.join(directory, ".gjc", "state", "sdk", `${sessionId}.json`),
					JSON.stringify({ url: `ws://127.0.0.1:${9876 + index}`, token: `token-${index}` }),
				);
			}),
		);
		const mappings = new SessionMappingStore();
		const attachments: string[] = [];
		let closeCalls = 0;
		let fallbackCalls = 0;
		const options = await buildAdapterServerOptionsFromEnv(adapterEnv(workspace), {
			turnRunner: strictCloseTurnRunner(),
			mappings,
			modelReaderFactory,
			sessionPortFactory: () => ({
				async attach(attachment) {
					attachments.push(`${attachment.cwd}:${attachment.endpoint.url}`);
				},
				async closeSession() {
					closeCalls += 1;
				},
				detach() {},
				async getState() {
					return unexpectedSessionPortCall("getState");
				},
				async getAvailableModels() {
					return unexpectedSessionPortCall("getAvailableModels");
				},
				async getActiveProviders() {
					return unexpectedSessionPortCall("getActiveProviders");
				},
				async setModel() {
					return unexpectedSessionPortCall("setModel");
				},
				async setThinking() {
					return unexpectedSessionPortCall("setThinking");
				},
				async prompt() {
					return unexpectedSessionPortCall("prompt");
				},
				async reply() {
					return unexpectedSessionPortCall("reply");
				},
				async steer() {
					return unexpectedSessionPortCall("steer");
				},
				async followUp() {
					return unexpectedSessionPortCall("followUp");
				},
				async abort() {
					return unexpectedSessionPortCall("abort");
				},
				async abortAndPrompt() {
					return unexpectedSessionPortCall("abortAndPrompt");
				},
				async replyToAction() {
					return unexpectedSessionPortCall("replyToAction");
				},
				async planApprove() {
					return unexpectedSessionPortCall("planApprove");
				},
				async answerGate() {
					return unexpectedSessionPortCall("answerGate");
				},
				async branchCandidates() {
					return unexpectedSessionPortCall("branchCandidates");
				},
				async branch() {
					return unexpectedSessionPortCall("branch");
				},
				async newSession() {
					return unexpectedSessionPortCall("newSession");
				},
				async resumeSession() {
					return unexpectedSessionPortCall("resumeSession");
				},
			}),
			fallbackCloseSession: async () => {
				fallbackCalls += 1;
				return { status: "closed", message: "fallback" };
			},
			proveClosedSession: async () => ({ status: "closed", message: "public SDK close proven" }),
		});
		const routes = options.routes;
		if (routes?.projectLinkService === undefined || routes.closeSession === undefined)
			throw new Error("expected project close routes");
		const [first, second] = await Promise.all([
			routes.projectLinkService.linkProject({ cwd: firstDirectory, name: "First Project" }),
			routes.projectLinkService.linkProject({ cwd: secondDirectory, name: "Second Project" }),
		]);
		const firstMapping = await currentLifecycleMapping(first.project.id, sessionId, firstDirectory, "first-chat");
		const secondMapping = await currentLifecycleMapping(second.project.id, sessionId, secondDirectory, "second-chat");
		mappings.setScoped({ principalId: "owner-test", chatId: firstMapping.chatId }, firstMapping);
		mappings.setScoped({ principalId: "owner-test", chatId: secondMapping.chatId }, secondMapping);
		await routes.closeSession(mappings.getScoped({ principalId: "owner-test", chatId: "first-chat" })!, {
			ingressId: "close-first",
			ingressHash: "close-first",
		});
		await routes.closeSession(mappings.getScoped({ principalId: "owner-test", chatId: "second-chat" })!, {
			ingressId: "close-second",
			ingressHash: "close-second",
		});
		expect(attachments).toEqual([]);
		expect(closeCalls).toBe(0);
		expect(fallbackCalls).toBe(0);
	});

	test("supports OpenWebUI chat slash commands through the regular gjc model", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-admin-"));
		tempDirs.push(workspace);
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
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-admin-"));
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-admin-outside-"));
		tempDirs.push(workspace, outside);
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
			const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-admin-permission-"));
			const lockedParent = path.join(workspace, "locked");
			const projectDirectory = path.join(lockedParent, "project");
			tempDirs.push(workspace);
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
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-admin-"));
		tempDirs.push(workspace);
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
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-admin-"));
		tempDirs.push(workspace);
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
function unexpectedSessionPortCall(method: string): never {
	throw new Error(`unexpected session port call: ${method}`);
}

const modelReaderFactory = staticModelReaderFactory();

function adapterEnv(workspace: string): Record<string, string | undefined> {
	return {
		...process.env,
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

function mappingFor(projectId: string, sessionId: string): SessionMapping {
	return {
		chatId: "dynamic-chat",
		principalId: "owner-test",
		projectId,
		sessionId,
		rawFrameCursor: 0,
		eventCursor: 0,
		operationId: "dynamic-operation",
	};
}

function managedAuthority(cwd: string, sessionId: string, requestKey: string): ManagedTurnAuthority {
	return {
		principalId: "owner-test",
		projectId: "managed-project",
		canonicalWorkspace: path.resolve(cwd),
		chatId: "dynamic-chat",
		sessionId,
		generation: 7,
		leaseId: "managed-lease",
		epoch: SESSION_AUTHORITY_V3_EPOCH,
		requestKey,
		authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
	} as ManagedTurnAuthority;
}

function managedCloseRuntime(initialStatus: "current" | "retired" | "replaced" | "unknown") {
	const subject: {
		runtime: ManagedSdkRuntimeDependency;
		readonly calls: string[];
		readonly requests: string[];
		status: "current" | "retired" | "replaced" | "unknown";
		outcome: { ok: boolean; certainty?: string };
		throws: boolean;
	} = {
		runtime: undefined as never,
		calls: [],
		requests: [],
		status: initialStatus,
		outcome: { ok: true },
		throws: false,
	};
	subject.runtime = {
		async start() {},
		async reconcile() {
			subject.calls.push("reconcile");
		},
		async dispose() {},
		async acquireAttachment() {
			throw new Error("managed close fixture must not acquire an attachment");
		},
		async request() {
			throw new Error("managed close fixture must not issue a Router request");
		},
		subscribeFrames() {
			throw new Error("managed close fixture must not subscribe frames");
		},
		async generationStatus() {
			subject.calls.push("status");
			return { status: subject.status };
		},
		async createLifecycleSession() {
			throw new Error("managed close fixture must not create a session");
		},
		async resumeLifecycleSession() {
			throw new Error("managed close fixture must not resume a session");
		},
		async closeLifecycleSession(request: { readonly requestKey: string }) {
			if (subject.throws) throw new Error("managed close transport failed");
			subject.calls.push("close");
			subject.requests.push(request.requestKey);
			return subject.outcome;
		},
		async deleteLifecycleSession() {
			throw new Error("managed close fixture must not delete a session");
		},
	} as unknown as ManagedSdkRuntimeDependency;
	return subject;
}

async function currentLifecycleMapping(
	projectId: string,
	sessionId: string,
	cwd: string,
	chatId = "dynamic-chat",
): Promise<SessionMapping> {
	return {
		...mappingFor(projectId, sessionId),
		chatId,
		attachment: (await currentSdkAttachment(cwd, sessionId)).authority,
	};
}

async function currentSdkAttachment(cwd: string, sessionId: string) {
	const endpoint = await readPublishedSdkEndpointDescriptor(cwd, sessionId);
	if (endpoint === null) throw new Error(`expected published SDK endpoint for ${sessionId}`);
	return attachmentFromPublishedSdkEndpoint(cwd, sessionId, endpoint);
}

async function writeSdkDescriptor(
	cwd: string,
	sessionId: string,
	endpoint: { readonly url: string; readonly token: string; readonly pid?: number },
): Promise<void> {
	await fs.writeFile(path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`), JSON.stringify(endpoint));
}
async function runTmux(
	socket: string,
	args: readonly string[],
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
	const child = Bun.spawn(["tmux", "-L", socket, ...args], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { exitCode, stdout, stderr };
}

function strictCloseTurnRunner(): FakeGjcTurnRunner {
	const runner = new FakeGjcTurnRunner();
	runner.withLifecyclePublication = async (address, effect) => {
		const proof = (address as GjcLifecyclePublicationAddress).recoveryAttachment;
		if (proof === undefined) throw new Error("expected persisted close attachment proof");
		return await effect({
			owner: {},
			address,
			assertClosePreflight(): never {
				throw new Error("Strict close fixture has no active attachment cache.");
			},
			async publish(candidate, write) {
				assertExactAttachmentProof(candidate, proof);
				return write();
			},
			async publishClosed(receipt, write) {
				assertExactAttachmentProof(receipt.proof, proof);
				return write();
			},
			async handoff(_successor, candidate) {
				assertExactAttachmentProof(candidate, proof);
			},
		});
	};
	runner.withLifecycleClosePreflight = async (address, effect) => {
		const proof = (address as GjcLifecyclePublicationAddress).recoveryAttachment;
		if (proof === undefined) throw new Error("expected persisted close attachment proof");
		return await effect({
			owner: {},
			address,
			assertClosePreflight(candidate) {
				assertExactAttachmentProof(candidate, proof);
				const descriptor = statSync(candidate.descriptorPath);
				if (
					descriptor.dev !== candidate.descriptorStat.dev ||
					descriptor.ino !== candidate.descriptorStat.ino ||
					descriptor.size !== candidate.descriptorStat.size ||
					descriptor.mtimeMs !== candidate.descriptorStat.mtimeMs
				)
					throw new Error("Strict close fixture has a stale descriptor.");
				if (
					candidate.tmuxSocket === undefined ||
					candidate.tmuxPane === undefined ||
					candidate.tmuxPanePid === undefined ||
					candidate.tmuxOwnershipTag === undefined
				)
					throw new Error("Strict close fixture requires a complete owned pane proof.");
				const attachment = {
					sessionId: candidate.expectedSessionId,
					cwd: candidate.expectedCwd,
					endpoint: { url: "ws://127.0.0.1:9876", token: "fixture-token", pid: candidate.tmuxPanePid },
					authority: candidate,
				};
				return GjcCloseReceipt.fromPreflight(address, candidate, attachment);
			},
			async publish(candidate, write) {
				assertExactAttachmentProof(candidate, proof);
				return write();
			},
			async publishClosed(receipt, write) {
				assertExactAttachmentProof(receipt.proof, proof);
				return write();
			},
			async handoff(_successor, candidate) {
				assertExactAttachmentProof(candidate, proof);
			},
		});
	};
	return runner;
}

function assertExactAttachmentProof(
	candidate: NonNullable<SessionMapping["attachment"]>,
	expected: NonNullable<SessionMapping["attachment"]>,
): void {
	expect(candidate).toEqual(expected);
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
