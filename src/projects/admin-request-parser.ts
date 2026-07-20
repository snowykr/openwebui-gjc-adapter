import { ProjectLinkError } from "./project-admission";

export interface ProjectAdminRouteResult {
	readonly status: number;
	readonly body: unknown;
}

export type ProjectAdminJsonResult =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false; readonly result: ProjectAdminRouteResult };

export type ProjectIdPathResult =
	| { readonly ok: true; readonly value: string }
	| { readonly ok: false; readonly result: ProjectAdminRouteResult };

export async function parseProjectAdminJsonRequest(request: Request): Promise<ProjectAdminJsonResult> {
	try {
		return { ok: true, value: await request.json() };
	} catch {
		return { ok: false, result: errorResult("Request body must be valid JSON.", "invalid_json", 400) };
	}
}

export function isProjectUnlinkPath(pathname: string): boolean {
	return pathname.startsWith("/admin/projects/") && pathname.endsWith("/unlink");
}

export function projectIdFromUnlinkPath(pathname: string): ProjectIdPathResult {
	try {
		return { ok: true, value: decodeURIComponent(pathname.slice("/admin/projects/".length, -"/unlink".length)) };
	} catch {
		return { ok: false, result: errorResult("Project id path segment is malformed.", "invalid_project_id", 400) };
	}
}

export function parseProjectLinkBody(body: unknown):
	| {
			readonly ok: true;
			readonly value: {
				readonly cwd: string;
				readonly name?: string;
				readonly sessionRoot?: string;
			};
	  }
	| { readonly ok: false; readonly message: string } {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return { ok: false, message: "Request body must be an object." };
	}
	const record = body as Record<string, unknown>;
	if (typeof record.cwd !== "string" || record.cwd.trim().length === 0) {
		return { ok: false, message: "cwd must be a non-empty string." };
	}
	return {
		ok: true,
		value: {
			cwd: record.cwd,
			...optionalStringField(record, "name"),
			...optionalStringField(record, "sessionRoot"),
		},
	};
}

function optionalStringField<T extends string>(
	record: Record<string, unknown>,
	key: T,
): { readonly [K in T]?: string } {
	const value = record[key];
	if (value === undefined) return {};
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new ProjectLinkError(`${key} must be a non-empty string when provided.`, "invalid_project_link");
	}
	return { [key]: value } as { readonly [K in T]?: string };
}

function errorResult(message: string, code: string, status: number): ProjectAdminRouteResult {
	return {
		status,
		body: { error: { message, type: "invalid_request_error", code } },
	};
}
