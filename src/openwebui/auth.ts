import type { AdapterConfig } from "../config";

export type OpenWebUICredentialType = "api-token" | "admin-credentials" | "missing";

export interface OpenWebUIOwnerContext {
	readonly ownerUserId: string;
	readonly singleOwnerLocalMode: boolean;
}

export interface OpenWebUIPrincipal {
	readonly userId: string;
	readonly role: "admin" | "user";
}

export type OpenWebUIAdminPrincipal = OpenWebUIPrincipal & { readonly role: "admin" };

export interface OpenWebUIPrincipalWorkspaceContext {
	readonly safeKey: string;
	readonly root: string;
}

export interface OpenWebUIPrincipalContext {
	readonly principal: OpenWebUIPrincipal;
	readonly correlationId: string;
	readonly workspace?: OpenWebUIPrincipalWorkspaceContext;
}
/** @deprecated Use OpenWebUIPrincipalContext. */
export type PrincipalContext = OpenWebUIPrincipalContext;

export interface OpenWebUIAdminPrincipalContext extends OpenWebUIPrincipalContext {
	readonly principal: OpenWebUIAdminPrincipal;
}

/** @deprecated Use OpenWebUIAdminPrincipalContext. */
export type AdminPrincipalContext = OpenWebUIAdminPrincipalContext;

export class OpenWebUIPrincipalScopeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OpenWebUIPrincipalScopeError";
	}
}
export class OpenWebUIPrincipalProjectionError extends OpenWebUIPrincipalScopeError {
	readonly code = "openwebui_principal_projection_unavailable";

	constructor() {
		super(
			"Normal-principal OpenWebUI projection writes are unavailable: the OpenWebUI client has no principal-bound credential or supported owner impersonation operation. Refusing to use the configured administrator token.",
		);
		this.name = "OpenWebUIPrincipalProjectionError";
	}
}

export type OpenWebUIPrincipalResolution =
	| { ok: true; principal: OpenWebUIPrincipal }
	| { ok: false; reason: "missing-forwarded-user" };

export function createOpenWebUIPrincipalContext(input: {
	readonly principal: OpenWebUIPrincipal;
	readonly correlationId: string;
	readonly workspace?: OpenWebUIPrincipalWorkspaceContext;
}): OpenWebUIPrincipalContext {
	const principal = normalizePrincipal(input.principal);
	const correlationId = normalizeRequiredContextValue(input.correlationId, "correlation ID");
	const workspace =
		input.workspace === undefined
			? undefined
			: Object.freeze({
					safeKey: normalizeRequiredContextValue(input.workspace.safeKey, "workspace safe key"),
					root: normalizeRequiredContextValue(input.workspace.root, "workspace root"),
				});
	return Object.freeze({
		principal,
		correlationId,
		...(workspace === undefined ? {} : { workspace }),
	});
}

export function createOpenWebUIAdminPrincipalContext(input: {
	readonly principal: OpenWebUIPrincipal;
	readonly correlationId: string;
	readonly workspace?: OpenWebUIPrincipalWorkspaceContext;
}): OpenWebUIAdminPrincipalContext {
	const context = createOpenWebUIPrincipalContext(input);
	const principal = requireOpenWebUIAdminPrincipal(context.principal);
	return Object.freeze({ ...context, principal });
}

export function requireOpenWebUIAdminPrincipal(
	principal: OpenWebUIPrincipal,
	expectedOwnerUserId?: string | OpenWebUIOwnerContext,
): OpenWebUIAdminPrincipal {
	const normalized = normalizePrincipal(principal);
	if (normalized.role !== "admin") {
		throw new OpenWebUIPrincipalScopeError("OpenWebUI administrator privileges are required.");
	}
	if (expectedOwnerUserId !== undefined) {
		const ownerUserId = normalizeConfiguredOwnerUserId(
			typeof expectedOwnerUserId === "string" ? expectedOwnerUserId : expectedOwnerUserId.ownerUserId,
		);
		if (ownerUserId === null || normalized.userId !== ownerUserId) {
			throw new OpenWebUIPrincipalScopeError("OpenWebUI runtime administrator must be the configured owner.");
		}
	}
	return Object.freeze({ userId: normalized.userId, role: "admin" });
}

export function resolveForwardedPrincipal(
	owner: OpenWebUIOwnerContext,
	forwardedUserId: string | null | undefined,
): OpenWebUIPrincipalResolution {
	const userId = normalizeForwardedUserId(forwardedUserId);
	if (userId === null) return { ok: false, reason: "missing-forwarded-user" };
	const ownerUserId = normalizeConfiguredOwnerUserId(owner.ownerUserId);
	return {
		ok: true,
		principal: Object.freeze({
			userId,
			role: ownerUserId !== null && userId === ownerUserId ? "admin" : "user",
		}),
	};
}

export function isOpenWebUIAdmin(principal: OpenWebUIPrincipal): principal is OpenWebUIAdminPrincipal {
	return principal.role === "admin";
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
	const ownerUserId = normalizeConfiguredOwnerUserId(owner.ownerUserId);
	const forwarded = normalizeForwardedUserId(forwardedUserId);
	if (forwarded === null) {
		return owner.singleOwnerLocalMode && ownerUserId !== null
			? { ok: true, ownerUserId, forwardedUserId: null }
			: {
					ok: false,
					ownerUserId: ownerUserId ?? "",
					forwardedUserId: null,
					reason: "missing-forwarded-owner",
				};
	}
	if (ownerUserId === null || forwarded !== ownerUserId) {
		return {
			ok: false,
			ownerUserId: ownerUserId ?? "",
			forwardedUserId: forwarded,
			reason: "owner-mismatch",
		};
	}
	return { ok: true, ownerUserId, forwardedUserId: forwarded };
}

export function buildOpenWebUIAuthStartupDiagnostic(
	config: Pick<AdapterConfig, "openWebUIApiToken" | "openWebUIAdminEmail" | "openWebUIAdminPassword" | "ownerUserId">,
): OpenWebUIAuthStartupDiagnostic {
	const credentialType = detectOpenWebUICredentialType(config);
	const ownerConfigured = normalizeConfiguredOwnerUserId(config.ownerUserId) !== null;
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

function normalizePrincipal(principal: OpenWebUIPrincipal): OpenWebUIPrincipal {
	if (typeof principal !== "object" || principal === null || Array.isArray(principal)) {
		throw new Error("OpenWebUI principal is required.");
	}
	const userId = normalizeRequiredContextValue(principal.userId, "principal user ID");
	if (principal.role !== "admin" && principal.role !== "user") {
		throw new Error("OpenWebUI principal role is invalid.");
	}
	return Object.freeze({ userId, role: principal.role });
}

function normalizeRequiredContextValue(value: string, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`OpenWebUI ${label} must be non-empty.`);
	}
	return value.trim();
}

function normalizeForwardedUserId(value: string | null | undefined): string | null {
	if (value === undefined || value === null) {
		return null;
	}
	const trimmed = value.trim();
	if (trimmed.length === 0 || /\p{Cc}/u.test(trimmed) || /\{\{[^{}]*\}\}/u.test(trimmed)) {
		return null;
	}
	return trimmed;
}

function normalizeConfiguredOwnerUserId(value: string | null | undefined): string | null {
	return normalizeForwardedUserId(value);
}
