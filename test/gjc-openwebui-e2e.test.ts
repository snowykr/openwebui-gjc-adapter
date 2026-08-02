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
	const evidence = {
		text: "Tool read finished",
		socketFrames: ['42["events",{"status":"complete"}]'],
		completionResponses: [{ status: 200, body: "data: openwebui-gjc-adapter" }],
		expectedResponseText: "openwebui-gjc-adapter",
		previousToolReadFinishedCount: 0,
		toolReadFinishedCount: 1,
	};
	expect(() => assertVisualEvidence(evidence)).not.toThrow();
	expect(() =>
		assertVisualEvidence({ ...evidence, completionResponses: [{ status: 500, body: "openwebui-gjc-adapter" }] }),
	).toThrow("expected response");
	expect(() => assertVisualEvidence({ ...evidence, completionResponses: [{ status: 200, body: "" }] })).toThrow(
		"expected response",
	);
	expect(() => assertVisualEvidence({ ...evidence, toolReadFinishedCount: 0 })).toThrow("submitted turn");
	expect(() => assertVisualEvidence({ ...evidence, socketFrames: [] })).toThrow("post-submit");
	expect(() => assertVisualEvidence({ ...evidence, text: "Server Connection Error" })).toThrow("connection error");
});

test("does not accept status labels from an earlier turn", () => {
	expect(() =>
		assertVisualEvidence({
			text: "Tool read finished\nopenwebui-gjc-adapter",
			socketFrames: ['42["events",{"status":"complete"}]'],
			completionResponses: [{ status: 500, body: "request failed" }],
			expectedResponseText: "openwebui-gjc-adapter",
			previousToolReadFinishedCount: 1,
			toolReadFinishedCount: 1,
		}),
	).toThrow("expected response");
});
