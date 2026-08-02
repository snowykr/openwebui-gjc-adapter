import { expect, test } from "bun:test";
import {
	assertVisualEvidence,
	isOpenWebUiEventFrame,
	matchesModelOption,
	modelSearchTerm,
	parseSocketIoFrame,
	sourceHashFromGitState,
} from "../scripts/gjc-openwebui-e2e";

test("parses and identifies v0.11 Socket.IO events frames", () => {
	expect(parseSocketIoFrame('42["chat-events",{"ok":true}]')).toEqual(["chat-events", { ok: true }]);
	expect(parseSocketIoFrame('42/chat,["events",{"ok":true}]')).toEqual(["events", { ok: true }]);
	expect(parseSocketIoFrame("2probe")).toBeUndefined();
	expect(isOpenWebUiEventFrame('42["events",{"ok":true}]')).toBe(true);
	expect(isOpenWebUiEventFrame('42["chat-events",{"ok":true}]')).toBe(false);
});
test("accepts OpenWebUI connection-prefixed model picker values", () => {
	expect(matchesModelOption("gjc/openai-codex/gpt-5.6-luna:low", "gjc/openai-codex/gpt-5.6-luna:low")).toBe(true);
	expect(matchesModelOption("0.gjc/openai-codex/gpt-5.6-luna:low", "gjc/openai-codex/gpt-5.6-luna:low")).toBe(true);
	expect(matchesModelOption("0.gjc/openai-codex/gpt-5.6-luna:low", "gjc/openai-codex/gpt-5.6-luna:medium")).toBe(
		false,
	);
});
test("accepts one connection prefix for submitted completion models", () => {
	expect(matchesModelOption("0.gjc/openai-codex/gpt-5.6-luna:low", "gjc/openai-codex/gpt-5.6-luna:low")).toBe(true);
});
test("searches v0.11 model picker by the model name instead of the canonical identifier punctuation", () => {
	expect(modelSearchTerm("gjc/openai-codex/gpt-5.6-luna:low")).toBe("gpt-5.6-luna");
	expect(modelSearchTerm("gjc/openai-codex/gpt%2F5:off")).toBe("gpt/5");
	expect(modelSearchTerm("invalid-model")).toBe("invalid-model");
});
test("binds browser evidence to the committed tree and both tracked diff states", () => {
	const clean = {
		head: "commit-a",
		indexTree: "tree-a",
		stagedDiff: "",
		unstagedDiff: "",
	};

	expect(sourceHashFromGitState(clean)).not.toBe(sourceHashFromGitState({ ...clean, head: "commit-b" }));
	expect(sourceHashFromGitState(clean)).not.toBe(sourceHashFromGitState({ ...clean, indexTree: "tree-b" }));
	expect(sourceHashFromGitState(clean)).not.toBe(sourceHashFromGitState({ ...clean, stagedDiff: "staged" }));
	expect(sourceHashFromGitState(clean)).not.toBe(sourceHashFromGitState({ ...clean, unstagedDiff: "unstaged" }));
});

test("requires a visible response and Socket.IO evidence for redesigned OpenWebUI", () => {
	expect(() =>
		assertVisualEvidence({
			text: "Tool read finished\nopenwebui-gjc-adapter",
			socketFrames: ['42["events",{"status":"complete"}]'],
			expectedResponseText: "openwebui-gjc-adapter",
		}),
	).not.toThrow();
	expect(() =>
		assertVisualEvidence({
			text: "Tool read finished",
			socketFrames: [],
			expectedResponseText: "openwebui-gjc-adapter",
		}),
	).toThrow("expected response");
	expect(() =>
		assertVisualEvidence({
			text: "openwebui-gjc-adapter",
			socketFrames: ['42["events",{"status":"complete"}]'],
			expectedResponseText: "openwebui-gjc-adapter",
		}),
	).toThrow("Tool read finished");
	expect(() =>
		assertVisualEvidence({
			text: "Tool read finished\nopenwebui-gjc-adapter",
			previousText: "Tool read finished\nopenwebui-gjc-adapter",
			socketFrames: ['42["events",{"status":"complete"}]'],
			expectedResponseText: "openwebui-gjc-adapter",
		}),
	).toThrow("new turn");
	expect(() =>
		assertVisualEvidence({
			text: "Open WebUI: Server Connection Error\nTool read finished\nopenwebui-gjc-adapter",
			socketFrames: ['42["events",{}]'],
			expectedResponseText: "openwebui-gjc-adapter",
		}),
	).toThrow("connection error");
});

test("retains visible tool-status checks when no response contract is configured", () => {
	expect(() =>
		assertVisualEvidence({
			text: "Thinking completed\nTool read started\nTool read finished",
			socketFrames: ['42["events",{"status":"complete"}]'],
		}),
	).not.toThrow();
});
