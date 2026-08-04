import { closeIngressId, legacyCloseIngressId } from "../gjc/session-router";
import type { OpenWebUIPrincipal } from "../openwebui/auth";
import { jsonResponse } from "./openai-response-utils";
import type { AdapterRouteDependencies } from "./openai-routes";

export async function handleOpenAIChatCloseRequest(
	chatId: string,
	operationId: string,
	routes: AdapterRouteDependencies,
	principal?: OpenWebUIPrincipal,
): Promise<Response> {
	const principalId = principal?.userId.trim();
	if (principalId === undefined || principalId.length === 0) {
		return jsonResponse(
			{
				error: {
					message: "A non-empty principal is required to close a GJC session.",
					type: "authentication_error",
					code: "missing-forwarded-user",
				},
				operationId,
			},
			{ status: 401 },
		);
	}
	const scopedMapping = routes.mappings?.getScoped({ principalId, chatId });
	const mapping = scopedMapping?.principalId?.trim() === principalId ? scopedMapping : undefined;
	if (mapping === undefined) {
		return jsonResponse(
			{
				error: {
					message: "No GJC session is mapped to this chat.",
					type: "invalid_request_error",
					code: "chat_session_not_found",
				},
				operationId,
			},
			{ status: 404 },
		);
	}
	if (routes.closeSession === undefined)
		return jsonResponse(
			{ status: "unavailable", message: "GJC session close is unavailable.", operationId },
			{ status: 503 },
		);
	try {
		const ingressId = closeIngressId(`http:${operationId}`, mapping);
		const legacyIngressId = legacyCloseIngressId(operationId, mapping);
		const result = await routes.closeSession(mapping, {
			ingressId,
			ingressHash: ingressId,
			legacyIngress: { ingressId: legacyIngressId, ingressHash: legacyIngressId },
		});
		return jsonResponse(
			{ ...result, operationId },
			{ status: result.status === "closed" ? 200 : result.status === "unavailable" ? 503 : 202 },
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : "GJC session close acknowledgement was not received.";
		if (message.includes("conflicts")) {
			return jsonResponse(
				{ error: { message, type: "invalid_request_error", code: "chat_close_conflict" }, operationId },
				{ status: 409 },
			);
		}
		return jsonResponse({ status: "uncertain", message, operationId }, { status: 202 });
	}
}

export function chatIdFromClosePath(pathname: string): string | undefined {
	const match = /^\/v1\/chats\/([^/]+)\/close$/.exec(pathname);
	if (match === null) return undefined;
	try {
		return decodeURIComponent(match[1]);
	} catch {
		return undefined;
	}
}
