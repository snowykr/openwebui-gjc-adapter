import type { SessionHeader, SessionMessageEntry } from "@gajae-code/coding-agent";

export async function writeSessionFile(
	filePath: string,
	input: {
		readonly header: Pick<SessionHeader, "id" | "title" | "cwd">;
		readonly entries: readonly SessionMessageEntry[];
	},
): Promise<void> {
	const header: SessionHeader = {
		type: "session",
		version: 3,
		id: input.header.id,
		title: input.header.title,
		timestamp: "2026-07-08T00:00:00.000Z",
		cwd: input.header.cwd,
	};
	await Bun.write(filePath, `${[header, ...input.entries].map(entry => JSON.stringify(entry)).join("\n")}\n`);
}

export function messageEntry(
	id: string,
	parentId: string | null,
	role: "user" | "assistant",
	content: string,
): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-07-08T00:00:00.000Z",
		message: agentMessage(role, content),
	};
}

function agentMessage(role: "user" | "assistant", content: string): SessionMessageEntry["message"] {
	if (role === "user") return { role, content, timestamp: 1 };
	return {
		role,
		content: [{ type: "text", text: content }],
		api: "openai-responses",
		provider: "gjc",
		model: "gjc-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}
