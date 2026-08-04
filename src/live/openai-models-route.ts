import { randomUUID } from "node:crypto";
import type { OpenWebUIPrincipal } from "../openwebui/auth";
import type { UserWorkspace } from "../security/user-workspace";
import type { WorkspaceLease } from "../security/workspace-lease";
import type { ModelReaderContext } from "./model-reader";
import { createModelSelectionPolicy } from "./model-selection-policy";
import { jsonResponse, modelSelectionErrorResponse } from "./openai-response-utils";
import type { AdapterRouteDependencies } from "./openai-routes";

const DEFAULT_MODELS_WORKSPACE_LEASE_DURATION_MS = 210_000;

export async function handleOpenAIModelsRequest(
	routes: AdapterRouteDependencies,
	principal?: OpenWebUIPrincipal,
): Promise<Response> {
	if (!isValidModelsPrincipal(principal)) return missingModelsPrincipalResponse();
	if (principal.role === "admin" && principal.userId !== routes.owner.ownerUserId)
		return adminModelsPrincipalRequiredResponse();
	try {
		if (routes.modelReaderFactory === undefined) throw new TypeError("GJC model reader is unavailable");
		if (principal.role === "admin")
			return jsonResponse(await createModelSelectionPolicy(routes.modelReaderFactory).listModels());

		let workspace: UserWorkspace | undefined;
		try {
			workspace = await routes.workspaceRegistry?.open(principal.userId);
		} catch {
			return modelsWorkspaceUnavailableResponse();
		}
		if (workspace === undefined || workspace.userId !== principal.userId) return modelsWorkspaceUnavailableResponse();
		if (routes.workspaceLeaseManager === undefined) return modelsWorkspaceLeaseErrorResponse();

		const leaseDurationMs = routes.workspaceLeaseDurationMs ?? DEFAULT_MODELS_WORKSPACE_LEASE_DURATION_MS;
		if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) return modelsWorkspaceLeaseErrorResponse();
		const heartbeatMs = routes.workspaceLeaseHeartbeatMs ?? Math.max(1, Math.floor(leaseDurationMs / 4));
		if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs <= 0 || heartbeatMs * 3 >= leaseDurationMs)
			return modelsWorkspaceLeaseErrorResponse();
		let lease: WorkspaceLease;
		try {
			lease = await routes.workspaceLeaseManager.acquire({
				safeKey: workspace.safeKey,
				holderId: `gjc-models-${process.pid}-${randomUUID()}`,
				operation: "turn",
				leaseMs: leaseDurationMs,
			});
		} catch {
			return modelsWorkspaceLeaseErrorResponse();
		}
		if (lease === undefined) return modelsWorkspaceLeaseErrorResponse();
		const admission = new ModelsWorkspaceLeaseAdmission(lease, leaseDurationMs, heartbeatMs);
		const context: ModelReaderContext = {
			principal,
			workspace,
			lease: { assertFence: () => admission.assertFence() },
			correlationId: `models:${randomUUID()}`,
		};
		const scopedModelReaderFactory = () => routes.modelReaderFactory!(context);
		let response: Response | undefined;
		let operationError: unknown;
		try {
			await assertModelsLeaseFence(admission);
			try {
				response = jsonResponse(await createModelSelectionPolicy(scopedModelReaderFactory).listModels());
			} catch (error) {
				operationError = error;
			}
			if (operationError === undefined) await assertModelsLeaseFence(admission);
		} catch (error) {
			operationError = error;
		}
		if (!(await admission.finish())) return modelsWorkspaceLeaseErrorResponse();
		if (operationError !== undefined) throw operationError;
		return response ?? modelsWorkspaceLeaseErrorResponse();
	} catch (error) {
		if (error instanceof ModelsWorkspaceLeaseError) return modelsWorkspaceLeaseErrorResponse();
		return modelSelectionErrorResponse(error);
	}
}

function isValidModelsPrincipal(principal: OpenWebUIPrincipal | undefined): principal is OpenWebUIPrincipal {
	return (
		typeof principal === "object" &&
		principal !== null &&
		!Array.isArray(principal) &&
		typeof principal.userId === "string" &&
		principal.userId.length > 0 &&
		principal.userId.trim() === principal.userId &&
		!/\p{Cc}/u.test(principal.userId) &&
		!/\{\{[^{}]*\}\}/u.test(principal.userId) &&
		(principal.role === "admin" || principal.role === "user")
	);
}

function missingModelsPrincipalResponse(): Response {
	return jsonResponse(
		{
			error: {
				message: "A non-empty OpenWebUI user identity is required.",
				type: "authentication_error",
				code: "missing-forwarded-user",
			},
		},
		{ status: 401 },
	);
}

function adminModelsPrincipalRequiredResponse(): Response {
	return jsonResponse(
		{
			error: {
				message: "OpenWebUI administrator privileges are required.",
				type: "authorization_error",
				code: "admin_required",
			},
		},
		{ status: 403 },
	);
}

function modelsWorkspaceUnavailableResponse(): Response {
	return jsonResponse(
		{
			error: {
				message: "Private OpenWebUI workspace could not be prepared.",
				type: "server_error",
				code: "workspace_unavailable",
			},
		},
		{ status: 503 },
	);
}

function modelsWorkspaceLeaseErrorResponse(): Response {
	return jsonResponse(
		{
			error: {
				message: "Workspace operation is temporarily unavailable.",
				type: "server_error",
				code: "workspace_lease_uncertain",
			},
		},
		{ status: 503 },
	);
}

class ModelsWorkspaceLeaseError extends Error {}

class ModelsWorkspaceLeaseAdmission {
	#lease: WorkspaceLease;
	readonly #durationMs: number;
	readonly #heartbeat: ReturnType<typeof setInterval>;
	#renewal: Promise<void> | undefined;
	#finishPromise: Promise<boolean> | undefined;
	#failure = false;
	#stopping = false;

	constructor(lease: WorkspaceLease, durationMs: number, heartbeatMs: number) {
		this.#lease = lease;
		this.#durationMs = durationMs;
		this.#heartbeat = setInterval(() => this.#scheduleRenewal(), heartbeatMs);
		(this.#heartbeat as unknown as { unref?: () => void }).unref?.();
	}

	async assertFence(): Promise<void> {
		if (this.#failure) throw new ModelsWorkspaceLeaseError();
		try {
			await this.#lease.assertFence();
		} catch {
			this.#markFailure();
			throw new ModelsWorkspaceLeaseError();
		}
		if (this.#failure) throw new ModelsWorkspaceLeaseError();
	}

	async finish(): Promise<boolean> {
		if (this.#finishPromise === undefined) this.#finishPromise = this.#finish();
		return this.#finishPromise;
	}

	async #finish(): Promise<boolean> {
		this.#stopping = true;
		clearInterval(this.#heartbeat);
		if (this.#renewal !== undefined) await this.#renewal;
		let healthy = true;
		try {
			await this.#lease.assertFence();
		} catch {
			this.#markFailure();
			healthy = false;
		}
		try {
			await this.#lease.release();
		} catch {
			healthy = false;
		}
		return healthy && !this.#failure;
	}

	#scheduleRenewal(): void {
		if (this.#stopping || this.#failure || this.#renewal !== undefined) return;
		const renewal = this.#renew();
		this.#renewal = renewal;
		void renewal.then(
			() => {
				if (this.#renewal === renewal) this.#renewal = undefined;
			},
			() => {
				if (this.#renewal === renewal) this.#renewal = undefined;
			},
		);
	}

	async #renew(): Promise<void> {
		try {
			this.#lease = await this.#lease.renew(this.#durationMs);
		} catch {
			this.#markFailure(true);
		}
	}

	#markFailure(finalize = false): void {
		if (this.#failure) return;
		this.#failure = true;
		if (finalize) void this.finish().catch(() => {});
	}
}

async function assertModelsLeaseFence(admission: ModelsWorkspaceLeaseAdmission): Promise<void> {
	try {
		await admission.assertFence();
	} catch {
		throw new ModelsWorkspaceLeaseError();
	}
}
