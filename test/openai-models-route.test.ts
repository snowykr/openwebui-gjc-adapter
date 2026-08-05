import { describe, expect, test } from "bun:test";
import { acquireWorkspaceAdmission } from "../src/live/chat-completions";
import type { ModelReaderFactory } from "../src/live/model-reader";
import type { AdapterRouteDependencies } from "../src/live/openai-routes";
import { handleOpenAIModelsRequest } from "../src/live/openai-routes";
import type { OpenWebUIPrincipal } from "../src/openwebui/auth";

describe("handleOpenAIModelsRequest normal-user lease lifecycle", () => {
	test("keeps the workspace lease until the catalog read settles after heartbeat loss", async () => {
		let catalogSettled = false;
		let releases = 0;
		let releasesAfterSettled = 0;
		let fenceLost = false;
		const lease = {
			renew: async () => {
				fenceLost = true;
				throw new Error("heartbeat lost");
			},
			assertFence: async () => {
				if (fenceLost) throw new Error("fence lost");
			},
			release: async () => {
				releases += 1;
				if (catalogSettled) releasesAfterSettled += 1;
			},
		};
		const modelReaderFactory: ModelReaderFactory = async () => ({
			getAvailableModels: async () => {
				await new Promise(resolve => setTimeout(resolve, 120));
				catalogSettled = true;
				return [];
			},
			getActiveProviders: async () => [],
			getState: async () => ({}),
			stop: async () => {},
		});
		const principal: OpenWebUIPrincipal = { userId: "models-user", role: "user" };
		const routes = {
			projects: [],
			owner: { ownerUserId: "admin-1", singleOwnerLocalMode: false },
			runner: { run: async () => ({ content: "unused" }), stop: async () => {} },
			modelReaderFactory,
			workspaceRegistry: {
				open: async (userId: string) => ({
					userId,
					safeKey: "a".repeat(64),
					root: "/workspace/models-user",
					sessionRoot: "/workspace/models-user/.gjc/sessions",
				}),
			},
			workspaceLeaseManager: {
				acquire: async () => lease,
			},
			workspaceLeaseHeartbeatMs: 5,
		} as unknown as AdapterRouteDependencies;

		const response = await handleOpenAIModelsRequest(routes, principal);

		expect(response.status).toBe(503);
		expect(releases).toBe(1);
		expect(releasesAfterSettled).toBe(1);
	});
	test("queues a normal-user models read behind the same-workspace admission gate", async () => {
		const safeKey = "a".repeat(64);
		let catalogSettled = false;
		const lease = {
			renew: async () => lease,
			assertFence: async () => {},
			release: async () => {},
		};
		const manager = { acquire: async () => lease };
		const modelReaderFactory: ModelReaderFactory = async () => ({
			getAvailableModels: async () => {
				catalogSettled = true;
				return [];
			},
			getActiveProviders: async () => [],
			getState: async () => ({}),
			stop: async () => {},
		});
		const principal: OpenWebUIPrincipal = { userId: "models-user", role: "user" };
		const routes = {
			projects: [],
			owner: { ownerUserId: "admin-1", singleOwnerLocalMode: false },
			runner: { run: async () => ({ content: "unused" }), stop: async () => {} },
			modelReaderFactory,
			workspaceRegistry: {
				open: async (userId: string) => ({
					userId,
					safeKey,
					root: "/workspace/models-user",
					sessionRoot: "/workspace/models-user/.gjc/sessions",
				}),
			},
			workspaceLeaseManager: manager,
			workspaceLeaseDurationMs: 5000,
			workspaceLeaseHeartbeatMs: 1000,
		} as unknown as AdapterRouteDependencies;

		const releaseTurn = await acquireWorkspaceAdmission(manager, safeKey, 5000, 8);
		const request = handleOpenAIModelsRequest(routes, principal);
		await new Promise(resolve => setTimeout(resolve, 40));
		expect(catalogSettled).toBe(false);
		releaseTurn();
		const response = await request;
		expect(response.status).toBe(200);
		expect(catalogSettled).toBe(true);
	});
});
