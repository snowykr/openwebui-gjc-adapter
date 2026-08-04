import { describe, expect, test } from "bun:test";
import { createAdapterRequestHandler } from "../src/server-request-handler";

const owner = { ownerUserId: "admin-1", singleOwnerLocalMode: false };

function handler() {
	const previews: string[] = [];
	const cleanups: { userId: string; confirmationToken: string }[] = [];
	return {
		previews,
		cleanups,
		handler: createAdapterRequestHandler({
			routes: {
				projects: [],
				owner,
				runner: { run: () => ({ content: "unused", model: "gjc/anthropic/claude-sonnet-4:low" }) },
				requireAdapterApiToken: true,
				adapterApiToken: "adapter-token",
				workspaceCleanupService: {
					async preview({ userId }) {
						previews.push(userId);
						return { dryRun: true, found: false, issuedAt: 1 };
					},
					async cleanup({ userId, confirmationToken }) {
						cleanups.push({ userId, confirmationToken });
						return {
							status: "removed",
							outcome: "success",
							safeKey: "a".repeat(64),
							workspaceRoot: "/state/workspaces/a/workspace",
							completedAt: 1,
						};
					},
				},
			},
		}),
	};
}

function request(path: string, userId: string | undefined, body?: unknown): Request {
	const headers = new Headers({ authorization: "Bearer adapter-token" });
	if (userId !== undefined) headers.set("X-OpenWebUI-User-Id", userId);
	if (body !== undefined) headers.set("content-type", "application/json");
	return new Request(`http://adapter.test${path}`, {
		method: "POST",
		headers,
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

describe("workspace cleanup admin API", () => {
	test("requires the exact configured administrator and consumes a confirmation token", async () => {
		const adapter = handler();

		const missing = await adapter.handler(request("/admin/workspaces/user-a/cleanup/preview", undefined));
		const normal = await adapter.handler(request("/admin/workspaces/user-a/cleanup/preview", "normal-user"));
		const preview = await adapter.handler(request("/admin/workspaces/user-a/cleanup/preview", "admin-1"));
		const cleanup = await adapter.handler(
			request("/admin/workspaces/user-a/cleanup", "admin-1", { confirmationToken: "confirm" }),
		);

		expect(missing.status).toBe(401);
		expect(normal.status).toBe(403);
		expect(preview.status).toBe(200);
		expect(cleanup.status).toBe(200);
		expect(adapter.previews).toEqual(["user-a"]);
		expect(adapter.cleanups).toEqual([{ userId: "user-a", confirmationToken: "confirm" }]);
	});
});
