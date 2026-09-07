import type { OpenWebUIControl } from "./chat-completions-types";

export function controlFromMetadata(metadata: Record<string, unknown> | undefined): OpenWebUIControl | undefined {
	const control = metadata?.gjc_control;
	if (control === undefined) return undefined;
	if (!isRecord(control)) return { operation: "unsupported", surface: "invalid" };

	const operation = control.operation;
	if (
		operation === "abort" ||
		operation === "steer" ||
		operation === "follow_up" ||
		operation === "abort_and_prompt"
	) {
		return typeof control.text === "string" ? { operation, text: control.text } : { operation };
	}
	if (operation === "action_reply" && typeof control.actionId === "string") {
		return { operation, actionId: control.actionId, answer: control.answer };
	}
	if (operation === "workflow.plan_approve") {
		return { operation, input: isRecord(control.input) ? control.input : {} };
	}
	if (operation === "branch" || operation === "session.new") return { operation };
	if (
		operation === "session.resume" &&
		typeof control.sessionId === "string" &&
		control.sessionId.length > 0 &&
		control.sessionId.trim() === control.sessionId &&
		!/[\x00-\x1f\x7f]/.test(control.sessionId) &&
		Object.keys(control).every(field => field === "operation" || field === "sessionId")
	) {
		return { operation, sessionId: control.sessionId };
	}
	return { operation: "unsupported", surface: typeof operation === "string" ? operation : "invalid" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
