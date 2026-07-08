import { describe, expect, it } from "bun:test";
import { classifyRpcFrame, type RawRpcFrame } from "../src/gjc/rpc-frames";

describe("RPC frame classification", () => {
	it("classifies ready frames", () => {
		expect(classifyRpcFrame({ type: "ready", seq: 1, frame_id: "ready-1" })).toMatchObject({
			kind: "ready",
			seq: 1,
			frameId: "ready-1",
		});
	});

	it("classifies response frames by id and result or error shape", () => {
		expect(classifyRpcFrame({ id: "cmd-1", result: { ok: true } })).toMatchObject({
			kind: "response",
			id: "cmd-1",
			result: { ok: true },
		});
		expect(classifyRpcFrame({ type: "response", id: 2, error: { message: "no" } })).toMatchObject({
			kind: "response",
			id: 2,
			error: { message: "no" },
		});
	});

	it("classifies canonical event frames and extracts event type and event", () => {
		const event = { type: "message_update", text: "hello" };
		expect(
			classifyRpcFrame({
				type: "event",
				seq: 3,
				payload: { event_type: "message_update", event },
			}),
		).toMatchObject({
			kind: "event",
			seq: 3,
			eventType: "message_update",
			event,
		});
	});

	it("classifies workflow gates", () => {
		expect(
			classifyRpcFrame({
				type: "workflow_gate",
				gate_id: "gate-1",
				stage: "approval",
				kind: "approval",
			}),
		).toMatchObject({ kind: "workflow_gate", gateId: "gate-1" });
	});

	it("classifies extension UI requests and extension errors", () => {
		expect(classifyRpcFrame({ type: "extension_ui_request", id: "ui-1", method: "open_url" })).toMatchObject({
			kind: "extension_ui_request",
			id: "ui-1",
			method: "open_url",
		});
		expect(classifyRpcFrame({ type: "extension_error", id: "ui-1", error: "failed" })).toMatchObject({
			kind: "extension_error",
			id: "ui-1",
			error: "failed",
		});
	});

	it("classifies host tool frames by type", () => {
		expect(classifyRpcFrame({ type: "host_tool_call", id: "tool-1", toolName: "read" })).toMatchObject({
			kind: "host_tool",
			rpcType: "host_tool_call",
			id: "tool-1",
		});
		expect(classifyRpcFrame({ type: "host_tool_result", id: "tool-1", result: { content: [] } })).toMatchObject({
			kind: "host_tool",
			rpcType: "host_tool_result",
		});
	});

	it("classifies host URI frames by type", () => {
		expect(classifyRpcFrame({ type: "host_uri_request", id: "uri-1", url: "file:///tmp/a" })).toMatchObject({
			kind: "host_uri",
			rpcType: "host_uri_request",
			id: "uri-1",
		});
		expect(classifyRpcFrame({ type: "host_uri_cancel", id: "uri-2", targetId: "uri-1" })).toMatchObject({
			kind: "host_uri",
			rpcType: "host_uri_cancel",
		});
	});

	it("returns bounded diagnostics for unsupported frames without dumping raw payloads", () => {
		const frame: RawRpcFrame = {
			type: "unsupported_frame_type_with_a_name_that_is_long_enough_to_require_bounding_in_the_diagnostic_message",
			frame_id: "raw-1",
			secret: "do not dump",
		};
		const classified = classifyRpcFrame(frame, 9);
		expect(classified).toMatchObject({
			kind: "unknown",
			seq: 9,
			frameId: "raw-1",
			diagnostic: { severity: "warn", rawRef: "raw-1" },
		});
		expect(classified.kind).toBe("unknown");
		if (classified.kind !== "unknown") {
			throw new Error(`Expected unknown frame, received ${classified.kind}`);
		}
		expect(classified.diagnostic.message.length).toBeLessThanOrEqual(110);
		expect(classified.diagnostic.message).not.toContain("do not dump");
	});
});
