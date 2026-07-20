import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const apiKey = "gjc-compat-hermetic-key";

export function providerResponse(request: Request): Promise<Response> {
	return respond(request);
}

async function respond(request: Request): Promise<Response> {
	if (request.headers.get("authorization") !== `Bearer ${apiKey}`)
		return Response.json({ error: "unauthorized" }, { status: 401 });
	const path = new URL(request.url).pathname;
	if (path === "/v1/models")
		return Response.json({
			object: "list",
			data: [{ id: "hermetic-model", object: "model", created: 0, owned_by: "gjc-compat" }],
		});
	if (path !== "/v1/chat/completions" || request.method !== "POST")
		return Response.json({ error: { message: "not found", type: "invalid_request_error" } }, { status: 404 });
	const input = (await request.json()) as { stream?: boolean; model?: string };
	if (input.model !== "hermetic-model")
		return Response.json({ error: { message: "unexpected model", type: "invalid_request_error" } }, { status: 400 });
	const created = Math.floor(Date.now() / 1000);
	const chunk = (delta: Record<string, unknown>, finishReason: string | null) =>
		`data: ${JSON.stringify({ id: "compat", object: "chat.completion.chunk", created, model: "hermetic-model", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
	const content = "compatibility-ok\n\nThere is nothing left to do.";
	if (input.stream)
		return new Response(
			`${chunk({ role: "assistant" }, null)}${chunk({ content }, null)}${chunk({}, "stop")}data: [DONE]\n\n`,
			{
				headers: { "content-type": "text/event-stream" },
			},
		);
	return Response.json({
		id: "compat",
		object: "chat.completion",
		created,
		model: "hermetic-model",
		choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
		usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
	});
}

export async function writeLocalProviderConfig(agentDirectory: string, baseUrl: string): Promise<void> {
	await mkdir(agentDirectory, { recursive: true });
	await writeFile(
		join(agentDirectory, "models.yml"),
		`providers:
  compat-local:
    baseUrl: ${baseUrl}/v1
    apiKeyEnv: GJC_COMPAT_LOCAL_API_KEY
    api: openai-completions
    auth: apiKey
    models:
      - id: hermetic-model
        name: Hermetic compatibility model
        api: openai-completions
        reasoning: false
        input: [text]
        output: [text]
        contextWindow: 8192
        maxTokens: 1024
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
`,
	);
	await writeFile(join(agentDirectory, "config.yml"), "compaction:\n  autoContinue: false\n");
}
