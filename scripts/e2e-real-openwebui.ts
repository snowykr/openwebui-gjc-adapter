import { access, mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import {
	choiceText,
	E2EContext,
	type HttpJson,
	importedCount,
	type JsonRecord,
	modelIdsFrom,
	requireString,
	syncedSessionCount,
	tinyPng,
} from "./e2e-real-openwebui-support";

const context = await E2EContext.create();

try {
	await run(context);
	await writeSummary(context);
	console.log(`E2E passed. Artifact: ${path.join(context.config.artifactDir, "summary.json")}`);
} catch (error) {
	await writeSummary(context, error);
	throw error;
}

async function run(ctx: E2EContext): Promise<void> {
	const health = await ctx.getJson(`${ctx.config.adapterBaseUrl}/healthz`, ctx.adapterHeaders());
	ctx.record("adapter healthz", health.status === 200, `HTTP ${health.status}`);

	const adapterModels = await ctx.getJson(`${ctx.config.adapterBaseUrl}/v1/models`, ctx.adapterHeaders());
	const modelIds = modelIdsFrom(adapterModels.body);
	ctx.record("adapter models include project admin", modelIds.includes("gjc/projects"), modelIds.join(", "));

	const openWebUIModels = await ctx.getJson(`${ctx.config.openWebUIBaseUrl}/api/v1/models`, ctx.openWebUIHeaders());
	const openWebUIModelIds = modelIdsFrom(openWebUIModels.body);
	ctx.record(
		"OpenWebUI sees GJC project model",
		openWebUIModelIds.includes("gjc/gajae-code-openwebui"),
		openWebUIModelIds.join(", "),
	);

	const relinkReal = await ctx.postJson(`${ctx.config.adapterBaseUrl}/admin/projects/link`, ctx.adapterHeaders(), {
		cwd: ctx.config.realProjectDir,
		name: "gajae-code-openwebui",
	});
	const realImportCount = importedCount(relinkReal.body);
	ctx.record(
		"real project link/import completed",
		relinkReal.status === 200 && syncedSessionCount(relinkReal.body) > 0,
		`HTTP ${relinkReal.status}, imported ${realImportCount}, synced ${syncedSessionCount(relinkReal.body)}`,
	);

	const projectList = await projectCommand(ctx, "/gjc project list", "real-list");
	ctx.record(
		"slash command lists linked projects",
		projectList.includes("linked: gjc/gajae-code-openwebui"),
		projectList,
	);

	const fixture = await createPreviousProjectFixture(ctx);
	const fixtureLinkText = await projectCommand(ctx, `/gjc project link ${fixture.cwd}`, "fixture-link");
	ctx.record(
		"slash command links previous project directory",
		fixtureLinkText.includes(`Linked ${fixture.modelId}.`) && fixtureLinkText.includes("Imported 1 session"),
		fixtureLinkText,
	);

	const afterFixtureLink = await ctx.getJson(`${ctx.config.adapterBaseUrl}/v1/models`, ctx.adapterHeaders());
	ctx.record(
		"linked previous project appears as model",
		modelIdsFrom(afterFixtureLink.body).includes(fixture.modelId),
		modelIdsFrom(afterFixtureLink.body).join(", "),
	);

	const fixtureUnlinkText = await projectCommand(ctx, `/gjc project unlink ${fixture.projectId}`, "fixture-unlink");
	ctx.record(
		"unlink hides project without deleting local history",
		fixtureUnlinkText.includes("Local GJC files were left untouched.") && (await fileExists(fixture.sessionFile)),
		fixtureUnlinkText,
	);

	const afterFixtureUnlink = await ctx.getJson(`${ctx.config.adapterBaseUrl}/v1/models`, ctx.adapterHeaders());
	ctx.record(
		"unlinked previous project model disappears",
		!modelIdsFrom(afterFixtureUnlink.body).includes(fixture.modelId),
		modelIdsFrom(afterFixtureUnlink.body).join(", "),
	);

	const relinkFixture = await ctx.postJson(`${ctx.config.adapterBaseUrl}/admin/projects/link`, ctx.adapterHeaders(), {
		cwd: fixture.cwd,
	});
	ctx.record(
		"admin relink imports previous project again",
		relinkFixture.status === 200 && syncedSessionCount(relinkFixture.body) >= 1,
		`HTTP ${relinkFixture.status}, imported ${importedCount(relinkFixture.body)}, synced ${syncedSessionCount(relinkFixture.body)}`,
	);

	const fixtureCleanupText = await projectCommand(ctx, `/gjc project unlink ${fixture.projectId}`, "fixture-cleanup");
	ctx.record(
		"fixture cleanup hides relinked project without deleting history",
		fixtureCleanupText.includes("Local GJC files were left untouched.") && (await fileExists(fixture.sessionFile)),
		fixtureCleanupText,
	);

	const textUpload = await ctx.uploadFile(
		"e2e-upload-context.txt",
		"text/plain",
		`needle=E2E_FILE_OK_${ctx.config.runId}\n`,
	);
	ctx.record("OpenWebUI text file upload", typeof textUpload.id === "string", JSON.stringify(textUpload));

	const imageUpload = await ctx.uploadFile("e2e-upload-image.png", "image/png", tinyPng());
	ctx.record("OpenWebUI image upload", typeof imageUpload.id === "string", JSON.stringify(imageUpload));

	const fileContext = await openWebUIChatWithFile(ctx, textUpload, imageUpload);
	ctx.record(
		"OpenWebUI chat forwards file/image context to GJC",
		fileContext.status === 200,
		`HTTP ${fileContext.status}`,
	);

	const finalModels = await ctx.getJson(`${ctx.config.adapterBaseUrl}/v1/models`, ctx.adapterHeaders());
	ctx.record(
		"final model list keeps real project linked",
		modelIdsFrom(finalModels.body).includes("gjc/gajae-code-openwebui") &&
			!modelIdsFrom(finalModels.body).includes(fixture.modelId),
		modelIdsFrom(finalModels.body).join(", "),
	);

	ctx.assertAllChecks();
}

async function createPreviousProjectFixture(ctx: E2EContext) {
	const projectId = `previous-work-project-${ctx.config.runId}`;
	const cwd = path.join(ctx.config.artifactDir, `Previous Work Project ${ctx.config.runId}`);
	const sessionRoot = path.join(cwd, ".gjc", "sessions");
	await mkdir(sessionRoot, { recursive: true });
	const sessionFile = path.join(sessionRoot, "2026-07-09T00-00-00-000Z_previous.jsonl");
	const records = [
		{
			type: "session",
			version: 3,
			id: `session-${ctx.config.runId}`,
			timestamp: "2026-07-09T00:00:00.000Z",
			cwd,
		},
		{
			type: "message",
			id: `user-${ctx.config.runId}`,
			timestamp: "2026-07-09T00:00:00.000Z",
			message: { role: "user", content: [{ type: "text", text: `previous project import ${ctx.config.runId}` }] },
		},
		{
			type: "message",
			id: `assistant-${ctx.config.runId}`,
			parentId: `user-${ctx.config.runId}`,
			timestamp: "2026-07-09T00:00:01.000Z",
			message: { role: "assistant", content: [{ type: "text", text: `imported history ${ctx.config.runId}` }] },
		},
	];
	await writeFile(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
	return { cwd, modelId: `gjc/${projectId}`, projectId, sessionFile };
}

async function projectCommand(ctx: E2EContext, command: string, suffix: string): Promise<string> {
	const response = await ctx.postJson(
		`${ctx.config.adapterBaseUrl}/v1/chat/completions`,
		ctx.adapterHeaders(ctx.openWebUIForwardHeaders()),
		{ model: "gjc/projects", stream: false, messages: [{ role: "user", content: command }] },
	);
	if (response.status !== 200)
		throw new Error(`Project command failed (${response.status}): ${JSON.stringify(response.body)}`);
	const text = choiceText(response.body);
	await ctx.writeJson(`project-command-${suffix}.json`, response.body);
	return text;
}

async function openWebUIChatWithFile(
	ctx: E2EContext,
	textUpload: JsonRecord,
	imageUpload: JsonRecord,
): Promise<HttpJson> {
	const textId = requireString(textUpload.id, "text upload id");
	const imageId = requireString(imageUpload.id, "image upload id");
	const payload = {
		model: "gjc/gajae-code-openwebui",
		stream: false,
		chat_id: `e2e-file-context-${ctx.config.runId}`,
		parent_id: null,
		id: `assistant-e2e-${ctx.config.runId}`,
		assistant_message_id: `assistant-e2e-${ctx.config.runId}`,
		messages: [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: `E2E attachment QA. Do not edit files. Reply with E2E_FILE_OK_${ctx.config.runId} if file context is visible.`,
					},
					{ type: "image_url", image_url: { url: `/api/v1/files/${imageId}/content`, detail: "low" } },
				],
			},
		],
		user_message: {
			id: `user-e2e-${ctx.config.runId}`,
			role: "user",
			content: `E2E attachment QA. Reply with E2E_FILE_OK_${ctx.config.runId}.`,
			files: [
				{ type: "file", id: textId, name: "e2e-upload-context.txt", context: "full" },
				{ type: "image", id: imageId, name: "e2e-upload-image.png", url: `/api/v1/files/${imageId}/content` },
			],
		},
		files: [
			{ type: "file", id: textId, name: "e2e-upload-context.txt", context: "full" },
			{ type: "image", id: imageId, name: "e2e-upload-image.png", url: `/api/v1/files/${imageId}/content` },
		],
		features: {},
		background_tasks: {},
	};
	await ctx.writeJson("openwebui-chat-request.json", payload);
	const response = await ctx.postJson(
		`${ctx.config.openWebUIBaseUrl}/api/chat/completions`,
		ctx.openWebUIHeaders(),
		payload,
		180_000,
	);
	await ctx.writeJson("openwebui-chat-response.json", response.body);
	return response;
}

async function writeSummary(ctx: E2EContext, error?: unknown): Promise<void> {
	await ctx.writeJson("summary.json", {
		runId: ctx.config.runId,
		artifactDir: ctx.config.artifactDir,
		realProjectDir: ctx.config.realProjectDir,
		checks: ctx.checks,
		...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }),
	});
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}
