export interface RecordedPromptRequest {
	readonly method: string;
	readonly path: string;
	readonly authorization: string | null;
	readonly body: unknown;
}

export interface PromptRecord {
	readonly id: string;
	readonly command: string;
	readonly name: string;
	readonly content: string;
	readonly tags: readonly string[];
	readonly meta: Record<string, unknown>;
	readonly is_active: boolean;
}

export function startPromptServer(initialPrompts: readonly PromptRecord[]) {
	const requests: RecordedPromptRequest[] = [];
	const prompts: PromptRecord[] = initialPrompts.map(prompt => ({ ...prompt, tags: [...prompt.tags] }));
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const body: unknown = request.method === "GET" ? null : await request.json();
			requests.push({
				method: request.method,
				path: `${url.pathname}${url.search}`,
				authorization: request.headers.get("authorization"),
				body,
			});
			if (request.method === "GET" && url.pathname === "/api/v1/prompts/list") {
				const pageNumber = Number(url.searchParams.get("page") ?? "1");
				const pageIndex = Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber - 1 : 0;
				const start = pageIndex * 30;
				return Response.json({ items: prompts.slice(start, start + 30), total: prompts.length });
			}
			if (request.method === "POST" && url.pathname === "/api/v1/prompts/create") {
				const prompt = promptFromBody(`prompt-${prompts.length + 1}`, body);
				prompts.push(prompt);
				return Response.json(prompt);
			}
			const updateMatch = url.pathname.match(/^\/api\/v1\/prompts\/id\/([^/]+)\/update$/);
			if (request.method === "POST" && updateMatch !== null) {
				const promptId = updateMatch[1];
				const index = prompts.findIndex(prompt => prompt.id === promptId);
				if (index < 0) return Response.json({ detail: "not found" }, { status: 404 });
				const updated = promptFromBody(promptId, body);
				prompts.splice(index, 1, updated);
				return Response.json(updated);
			}
			const toggleMatch = url.pathname.match(/^\/api\/v1\/prompts\/id\/([^/]+)\/toggle$/);
			if (request.method === "POST" && toggleMatch !== null) {
				const promptId = toggleMatch[1];
				const index = prompts.findIndex(prompt => prompt.id === promptId);
				if (index < 0) return Response.json({ detail: "not found" }, { status: 404 });
				const existing = prompts[index];
				if (existing === undefined) return Response.json({ detail: "not found" }, { status: 404 });
				const updated = { ...existing, is_active: !existing.is_active };
				prompts.splice(index, 1, updated);
				return Response.json(updated);
			}
			return Response.json({ detail: "unexpected request" }, { status: 500 });
		},
	});
	return {
		baseUrl: `http://${server.hostname}:${server.port}`,
		requests,
		prompts,
		stop: () => server.stop(true),
	};
}

function promptFromBody(id: string, body: unknown): PromptRecord {
	if (!isRecord(body)) throw new Error("expected prompt body");
	return {
		id,
		command: stringField(body, "command"),
		name: stringField(body, "name"),
		content: stringField(body, "content"),
		tags: arrayOfStrings(body.tags),
		meta: isRecord(body.meta) ? body.meta : {},
		is_active: true,
	};
}

function stringField(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string") throw new Error(`expected string field ${key}`);
	return value;
}

function arrayOfStrings(value: unknown): readonly string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
