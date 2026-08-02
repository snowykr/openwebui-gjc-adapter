import { expect, test } from "bun:test";
import {
	acceptedChatId,
	assertVisualEvidence,
	isOpenWebUiEventFrame,
	isOpenWebUiEventFrameForChat,
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
	expect(isOpenWebUiEventFrameForChat('42["events",{"chat_id":"chat-1"}]', "chat-1")).toBe(true);
	expect(isOpenWebUiEventFrameForChat('42["events",{"chat_id":"chat-2"}]', "chat-1")).toBe(false);
});
test("accepts exactly one OpenWebUI connection prefix", () => {
	const model = "gjc/openai-codex/gpt-5.6-luna:low";
	expect(matchesModelOption(model, model)).toBe(true);
	expect(matchesModelOption(`0.${model}`, model)).toBe(true);
	expect(matchesModelOption(`connection_id.${model}`, model)).toBe(true);
	expect(matchesModelOption(`a.b.${model}`, model)).toBe(false);
	expect(matchesModelOption(`.${model}`, model)).toBe(false);
	expect(matchesModelOption(`0.${model}`, "gjc/openai-codex/gpt-5.6-luna:medium")).toBe(false);
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

test("requires current-turn completion, tool status, and Socket.IO evidence", () => {
	const acceptedResponse = { status: 200, body: '{"status":true,"task_ids":["task-1"],"chat_id":"chat-1"}' };
	expect(acceptedChatId(acceptedResponse)).toBe("chat-1");
	expect(acceptedChatId({ status: 200, body: '{"status":true,"task_ids":[],"chat_id":"chat-1"}' })).toBeUndefined();
	const evidence = {
		text: "Tool read finished",
		socketFrames: ['42["events",{"chat_id":"chat-1","status":"complete"}]'],
		completionResponses: [acceptedResponse],
		chatId: "chat-1",
		currentAssistantText: "openwebui-gjc-adapter",
		expectedResponseText: "openwebui-gjc-adapter",
		toolReadFinishedCount: 1,
	};
	expect(() => assertVisualEvidence(evidence)).not.toThrow();
	expect(() => assertVisualEvidence({ ...evidence, completionResponses: [{ status: 500, body: "{}" }] })).toThrow(
		"did not accept",
	);
	expect(() => assertVisualEvidence({ ...evidence, currentAssistantText: "previous response" })).toThrow(
		"expected response",
	);
	expect(() => assertVisualEvidence({ ...evidence, toolReadFinishedCount: 0 })).toThrow("record Tool read finished");
	expect(() => assertVisualEvidence({ ...evidence, socketFrames: ['42["events",{"chat_id":"other"}]'] })).toThrow(
		"submitted chat",
	);
	expect(() => assertVisualEvidence({ ...evidence, text: "Server Connection Error" })).toThrow("connection error");
});
test("does not accept an earlier turn's matching text", () => {
	expect(() =>
		assertVisualEvidence({
			text: "Tool read finished\nopenwebui-gjc-adapter",
			socketFrames: ['42["events",{"chat_id":"chat-1"}]'],
			completionResponses: [{ status: 200, body: '{"status":true,"task_ids":["task-1"],"chat_id":"chat-1"}' }],
			chatId: "chat-1",
			currentAssistantText: "request failed",
			expectedResponseText: "openwebui-gjc-adapter",
			toolReadFinishedCount: 2,
		}),
	).toThrow("expected response");
});
