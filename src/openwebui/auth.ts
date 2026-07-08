import type { AdapterConfig } from "../config";

export type OpenWebUICredentialType = "api-token" | "admin-credentials" | "missing";

export interface OpenWebUIOwnerContext {
	ownerUserId: string;
	singleOwnerLocalMode: boolean;
}

export type OpenWebUIOwnerValidationResult =
	| { ok: true; ownerUserId: string; forwardedUserId: string | null }
	| {
			ok: false;
			ownerUserId: string;
			forwardedUserId: string | null;
			reason: "owner-mismatch" | "missing-forwarded-owner";
	  };

export interface OpenWebUIAuthStartupDiagnostic {
	credentialType: OpenWebUICredentialType;
	ownerConfigured: boolean;
	singleOwnerLocalMode: boolean;
	status: "ok" | "degraded";
	messages: string[];
}

export function detectOpenWebUICredentialType(
	config: Pick<AdapterConfig, "openWebUIApiToken" | "openWebUIAdminEmail" | "openWebUIAdminPassword">,
): OpenWebUICredentialType {
	if (config.openWebUIApiToken !== undefined) {
		return "api-token";
	}
	if (config.openWebUIAdminEmail !== undefined && config.openWebUIAdminPassword !== undefined) {
		return "admin-credentials";
	}
	return "missing";
}

export function validateForwardedOwnerUserId(
	owner: OpenWebUIOwnerContext,
	forwardedUserId: string | null | undefined,
): OpenWebUIOwnerValidationResult {
	const forwarded = normalizeForwardedUserId(forwardedUserId);
	if (forwarded === null) {
		return owner.singleOwnerLocalMode
			? { ok: true, ownerUserId: owner.ownerUserId, forwardedUserId: null }
			: {
					ok: false,
					ownerUserId: owner.ownerUserId,
					forwardedUserId: null,
					reason: "missing-forwarded-owner",
				};
	}
	if (forwarded !== owner.ownerUserId) {
		return {
			ok: false,
			ownerUserId: owner.ownerUserId,
			forwardedUserId: forwarded,
			reason: "owner-mismatch",
		};
	}
	return { ok: true, ownerUserId: owner.ownerUserId, forwardedUserId: forwarded };
}

export function buildOpenWebUIAuthStartupDiagnostic(
	config: Pick<AdapterConfig, "openWebUIApiToken" | "openWebUIAdminEmail" | "openWebUIAdminPassword" | "ownerUserId">,
): OpenWebUIAuthStartupDiagnostic {
	const credentialType = detectOpenWebUICredentialType(config);
	const ownerConfigured = config.ownerUserId !== undefined;
	const singleOwnerLocalMode = ownerConfigured;
	const messages: string[] = [];
	if (credentialType === "missing") {
		messages.push("OpenWebUI credentials are not configured.");
	}
	if (!ownerConfigured) {
		messages.push("GJC_OPENWEBUI_OWNER_USER_ID is not configured; forwarded owner enforcement cannot be enabled.");
	}
	return {
		credentialType,
		ownerConfigured,
		singleOwnerLocalMode,
		status: credentialType === "missing" || !ownerConfigured ? "degraded" : "ok",
		messages,
	};
}

function normalizeForwardedUserId(value: string | null | undefined): string | null {
	if (value === undefined || value === null) {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}
