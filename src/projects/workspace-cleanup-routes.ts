import {
	WorkspaceCleanupConfirmationError,
	WorkspaceCleanupError,
	type WorkspaceCleanupService,
	WorkspaceCleanupUncertainError,
} from "../security/workspace-cleanup";

export async function previewWorkspaceCleanup(
	service: Pick<WorkspaceCleanupService, "preview">,
	userId: string,
): Promise<{ readonly status: number; readonly body: unknown }> {
	try {
		return { status: 200, body: await service.preview({ userId }) };
	} catch (error) {
		return cleanupErrorResponse(error);
	}
}

export async function runWorkspaceCleanup(
	service: Pick<WorkspaceCleanupService, "cleanup">,
	userId: string,
	request: Request,
): Promise<{ readonly status: number; readonly body: unknown }> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return {
			status: 400,
			body: { error: { code: "invalid_cleanup_request", message: "Cleanup request body must be valid JSON." } },
		};
	}
	if (!isRecord(body) || typeof body.confirmationToken !== "string") {
		return {
			status: 400,
			body: { error: { code: "invalid_cleanup_request", message: "Cleanup confirmation token is required." } },
		};
	}
	try {
		return { status: 200, body: await service.cleanup({ userId, confirmationToken: body.confirmationToken }) };
	} catch (error) {
		return cleanupErrorResponse(error);
	}
}

export function workspaceCleanupPath(
	pathname: string,
): { readonly userId: string; readonly operation: "preview" | "cleanup" } | undefined {
	const match = /^\/admin\/workspaces\/([^/]+)\/cleanup(?:\/(preview))?$/.exec(pathname);
	if (match === null) return undefined;
	try {
		const userId = decodeURIComponent(match[1]);
		return userId.trim().length === 0
			? undefined
			: { userId, operation: match[2] === "preview" ? "preview" : "cleanup" };
	} catch {
		return undefined;
	}
}

function cleanupErrorResponse(error: unknown): { readonly status: number; readonly body: unknown } {
	if (error instanceof WorkspaceCleanupConfirmationError) {
		return {
			status: 400,
			body: { error: { code: error.code, message: "Workspace cleanup confirmation is invalid or stale." } },
		};
	}
	if (error instanceof WorkspaceCleanupUncertainError) {
		return { status: 503, body: { error: { code: error.code, message: "Workspace cleanup remains pending." } } };
	}
	if (error instanceof WorkspaceCleanupError) {
		return {
			status: 409,
			body: { error: { code: error.code, message: "Workspace cleanup could not be completed." } },
		};
	}
	return {
		status: 503,
		body: { error: { code: "workspace_cleanup_unavailable", message: "Workspace cleanup is unavailable." } },
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
