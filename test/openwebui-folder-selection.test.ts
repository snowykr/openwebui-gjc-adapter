import { describe, expect, test } from "bun:test";
import { OpenWebUIHttpClient } from "../src/openwebui/client";
import { type RecordingServerOptions, startRecordingServer } from "./openwebui-http-fixture";

describe("OpenWebUIHttpClient folder selection", () => {
	test("does not merge different adapter projects into a same-named OpenWebUI folder", async () => {
		const fixture = startRecordingServer({ folders: sameNamedProjectFolders() });
		const client = new OpenWebUIHttpClient({ baseUrl: fixture.baseUrl, apiToken: "token-1" });

		try {
			const folder = await client.upsertFolder({
				id: "gjc-project-project-b",
				owner_user_id: "owner-1",
				name: "Same Name",
				metadata: { gjc_adapter: { projectId: "project-b" } },
			});

			expect(folder.id).toBe("folder-b");
			expect(fixture.requests.map(request => `${request.method} ${request.path}`)).toEqual([
				"GET /api/v1/folders/gjc-project-project-b",
				"GET /api/v1/folders/",
				"GET /api/v1/folders/folder-a",
				"GET /api/v1/folders/folder-b",
				"POST /api/v1/folders/folder-b/update",
			]);
		} finally {
			fixture.stop();
		}
	});

	test("does not reuse adapter folders owned by a different OpenWebUI user", async () => {
		const fixture = startRecordingServer({
			folders: [
				{
					id: "foreign-folder",
					name: "Project",
					userId: "owner-2",
					meta: { gjc_adapter: { projectId: "project-1" } },
				},
			],
		});
		const client = new OpenWebUIHttpClient({ baseUrl: fixture.baseUrl, apiToken: "token-1" });

		try {
			const folder = await client.upsertFolder({
				id: "gjc-project-project-1",
				owner_user_id: "owner-1",
				name: "Project",
				metadata: { gjc_adapter: { projectId: "project-1" } },
			});

			expect(folder).toMatchObject({ id: "folder-1", owner_user_id: "owner-1" });
			expect(fixture.requests.map(request => `${request.method} ${request.path}`)).toEqual([
				"GET /api/v1/folders/gjc-project-project-1",
				"GET /api/v1/folders/",
				"GET /api/v1/folders/foreign-folder",
				"POST /api/v1/folders/",
				"POST /api/v1/folders/folder-1/update",
			]);
		} finally {
			fixture.stop();
		}
	});

	test("does not reuse adapter folders when OpenWebUI omits owner data", async () => {
		const fixture = startRecordingServer({
			folders: [
				{
					id: "ownerless-folder",
					name: "Project",
					omitUserId: true,
					meta: { gjc_adapter: { projectId: "project-1" } },
				},
			],
		});
		const client = new OpenWebUIHttpClient({ baseUrl: fixture.baseUrl, apiToken: "token-1" });

		try {
			const folder = await client.upsertFolder({
				id: "gjc-project-project-1",
				owner_user_id: "owner-1",
				name: "Project",
				metadata: { gjc_adapter: { projectId: "project-1" } },
			});

			expect(folder).toMatchObject({ id: "folder-1", owner_user_id: "owner-1" });
			expect(fixture.requests.map(request => `${request.method} ${request.path}`)).toEqual([
				"GET /api/v1/folders/gjc-project-project-1",
				"GET /api/v1/folders/",
				"GET /api/v1/folders/ownerless-folder",
				"POST /api/v1/folders/",
				"POST /api/v1/folders/folder-1/update",
			]);
		} finally {
			fixture.stop();
		}
	});
});

function sameNamedProjectFolders(): RecordingServerOptions["folders"] {
	return [
		{ id: "folder-a", name: "Same Name", meta: { gjc_adapter: { projectId: "project-a" } } },
		{ id: "folder-b", name: "Same Name", meta: { gjc_adapter: { projectId: "project-b" } } },
	];
}
