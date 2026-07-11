import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import {
	readRunnerConfig,
	requestJson,
	requireOnlyGjcModel,
	requireProjectListCompletion,
} from "./e2e-runner-openwebui-support";

const config = readRunnerConfig();
await mkdir(config.outputRoot, { recursive: true });
const headers = { authorization: `Bearer ${config.openWebUIToken}` };
const models = await requestJson(`${config.openWebUIBaseUrl}/api/models`, { headers });
if (models.status !== 200) throw new Error("E2E_MODELS_REQUEST_FAILED");
requireOnlyGjcModel(models.body);

const completion = await requestJson(`${config.openWebUIBaseUrl}/api/chat/completions`, {
	method: "POST",
	headers: { ...headers, "content-type": "application/json" },
	body: JSON.stringify({
		model: "gjc",
		stream: false,
		chat_id: `runner-e2e-${config.runId}`,
		messages: [
			{ role: "assistant", id: `assistant-${config.runId}`, content: "" },
			{
				role: "user",
				id: `user-${config.runId}`,
				parent_id: `assistant-${config.runId}`,
				content: "/gjc project list",
			},
		],
	}),
});
if (completion.status !== 200) throw new Error("E2E_COMPLETION_REQUEST_FAILED");
requireProjectListCompletion(completion.body);
await writeFile(
	path.join(config.outputRoot, "summary.json"),
	`${JSON.stringify({ runId: config.runId, phase: "provider-wire", modelsStatus: models.status, completionStatus: completion.status })}\n`,
);
console.log("Runner OpenWebUI E2E passed: provider-wire");
