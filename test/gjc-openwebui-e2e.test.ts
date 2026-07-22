import { expect, test } from "bun:test";
import { assertVisualEvidence, parseSocketIoFrame } from "../scripts/gjc-openwebui-e2e";

test("parses default and namespaced Socket.IO event frames", () => {
	expect(parseSocketIoFrame('42["chat-events",{"ok":true}]')).toEqual(["chat-events", { ok: true }]);
	expect(parseSocketIoFrame('42/chat,["chat-events",{"ok":true}]')).toEqual(["chat-events", { ok: true }]);
	expect(parseSocketIoFrame("2probe")).toBeUndefined();
});

test("requires the minimal visible thinking, tool, and Socket.IO evidence", () => {
	expect(() =>
		assertVisualEvidence({
			text: "Thinking completed\nTool read started\nTool read finished\npackage-name",
			socketFrames: ['42["chat-events",{"status":"complete"}]'],
		}),
	).not.toThrow();
	expect(() =>
		assertVisualEvidence({
			text: "Thinking completed\nTool read started\nTool read finished",
			socketFrames: [],
		}),
	).toThrow("Socket.IO");
	expect(() =>
		assertVisualEvidence({
			text: "Open WebUI: Server Connection Error\nThinking completed\nTool read started\nTool read finished",
			socketFrames: ['42["chat-events",{}]'],
		}),
	).toThrow("connection error");
});
