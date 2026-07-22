import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeSessionArtifactEvents } from "../src/live/gjc-public-sdk-session-ops";
import { projectSessionArtifactEvents } from "../src/live/gjc-session-artifact-events";

const prompt = "inspect the repository";
async function artifact(rows: readonly unknown[]): Promise<{ path: string; cleanup: () => Promise<void> }> {
	const directory = await mkdtemp(join(tmpdir(), "gjc-artifact-events-"));
	const path = join(directory, "session.jsonl");
	await writeFile(path, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`);
	return { path, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
const message = (value: unknown) => ({ type: "message", id: crypto.randomUUID(), message: value });
const user = (text: string) => message({ role: "user", content: text, timestamp: 1 });

describe("GJC session artifact event projection", () => {
	test("projects summary thinking and tool lifecycle without transcript payloads", async () => {
		const fixture = await artifact([
			user("prior prompt"),
			message({
				role: "assistant",
				content: [{ type: "toolCall", name: "write", arguments: { secret: "OLD_SECRET" } }],
			}),
			user(prompt),
			message({
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "RAW_THINKING_SECRET",
						thinkingSignature: "SIGNATURE_SECRET",
						provenance: "summary",
						summaryText: "Checking the file.",
					},
					{ type: "toolCall", name: "read", arguments: { path: "SECRET_PATH" } },
				],
			}),
			message({ role: "toolResult", toolName: "read", content: [{ type: "text", text: "SECRET_RESULT" }] }),
			message({ role: "assistant", content: [{ type: "text", text: "final answer must not duplicate" }] }),
		]);
		try {
			const events = await projectSessionArtifactEvents(fixture.path, prompt);
			expect(events).toEqual([
				{
					type: "message_update",
					payload: { assistantMessageEvent: { type: "thinking_start", text: "Checking the file." } },
				},
				{
					type: "message_update",
					payload: { assistantMessageEvent: { type: "thinking_end", text: "Checking the file." } },
				},
				{ type: "tool_execution_start", payload: { toolName: "read" } },
				{ type: "tool_execution_end", payload: { toolName: "read" } },
			]);
			expect(JSON.stringify(events)).not.toContain("SECRET");
			expect(JSON.stringify(events)).not.toContain("final answer");
			expect(JSON.stringify(events)).not.toContain("write");
		} finally {
			await fixture.cleanup();
		}
	});
	test("inserts reconstructed lifecycle before the terminal status", () => {
		const merged = mergeSessionArtifactEvents(
			{
				events: [{ type: "turn_stream", phase: "live" }, { type: "agent_end" }],
			},
			[
				{ type: "message_update", payload: { assistantMessageEvent: { type: "thinking_end" } } },
				{ type: "tool_execution_end", payload: { toolName: "read" } },
			],
		);

		expect(merged.events.map(event => event.type)).toEqual([
			"turn_stream",
			"message_update",
			"tool_execution_end",
			"agent_end",
		]);
	});
	test("keeps native lifecycle events without appending artifact duplicates", () => {
		const outcome = {
			events: [
				{
					type: "message_update",
					assistantMessageEvent: { type: "thinking", text: "native summary" },
				},
				{ type: "tool_execution_start", toolName: "read" },
				{ type: "agent_end" },
			],
		};

		expect(
			mergeSessionArtifactEvents(outcome, [
				{ type: "message_update", payload: { assistantMessageEvent: { type: "thinking_end" } } },
				{ type: "tool_execution_start", payload: { toolName: "read" } },
			]),
		).toBe(outcome);
	});
	test("keeps artifact lifecycle for text-only native updates", () => {
		const outcome = {
			events: [
				{
					type: "message_update",
					payload: { assistantMessageEvent: { type: "text_delta", delta: "live text" } },
				},
				{ type: "agent_end" },
			],
		};
		const merged = mergeSessionArtifactEvents(outcome, [
			{ type: "message_update", payload: { assistantMessageEvent: { type: "thinking_end" } } },
			{ type: "tool_execution_start", payload: { toolName: "read" } },
		]);

		expect(merged.events.map(event => event.type)).toEqual([
			"message_update",
			"message_update",
			"tool_execution_start",
			"agent_end",
		]);
	});
	test("fails closed for malformed, unknown, and oversized artifacts", async () => {
		const fixture = await artifact([
			user(prompt),
			message({ role: "assistant", content: [{ type: "unknown", secret: "SECRET" }] }),
		]);
		try {
			expect(await projectSessionArtifactEvents(fixture.path, prompt)).toEqual([]);
			await writeFile(fixture.path, '{"type":"message"}\nnot-json\n');
			expect(await projectSessionArtifactEvents(fixture.path, prompt)).toEqual([]);
			await writeFile(fixture.path, "x".repeat(256 * 1024 + 1));
			expect(await projectSessionArtifactEvents(fixture.path, prompt)).toEqual([]);
		} finally {
			await fixture.cleanup();
		}
	});
});
