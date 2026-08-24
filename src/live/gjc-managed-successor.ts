import { createHash } from "node:crypto";
import type { ManagedSdkAttachment, ManagedSdkRuntime, TenantSessionKey } from "../gjc/managed-sdk-runtime";
import { GjcTurnCancelledError, type ManagedTurnAuthority } from "../gjc/turn-runner";

export interface ManagedSuccessorInput {
	readonly source: ManagedTurnAuthority;
	/** Target tenancy, never a caller-supplied successor session or generation. */
	readonly target: Omit<ManagedTurnAuthority, "sessionId" | "generation">;
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
	/** Called only after the exact target generation is reconciled, fenced, and current. */
	readonly publish: (successor: ManagedSdkAttachment) => Promise<void> | void;
}

export interface ManagedSuccessorResult {
	readonly successor: ManagedSdkAttachment;
	readonly operationHash: string;
}

/**
 * The unwired managed fork path. It never changes the source mapping; callers
 * retain it until `publish` receives a proven target attachment.
 */
export interface ManagedSuccessorFlow {
	fork(input: ManagedSuccessorInput): Promise<ManagedSuccessorResult>;
}

export class ManagedSuccessorUncertainError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ManagedSuccessorUncertainError";
	}
}

export function createManagedSuccessorFlow(runtime: ManagedSdkRuntime): ManagedSuccessorFlow {
	return {
		async fork(input) {
			assertSuccessorAuthority(input.source, input.target);
			throwIfAborted(input.signal);
			const source = tenant(input.source);
			const operationHash = successorHash(source, input.target);
			let invoked = false;
			let acknowledged = false;
			let returnedTarget: TenantSessionKey | undefined;
			try {
				// Reconciliation plus acquire re-proves source registration, currentness, and tenant fencing.
				await runtime.reconcile();
				await runtime.acquireAttachment(source);
				throwIfAborted(input.signal);
				invoked = true;
				const outcome = unwrapOutcome(
					await runtime.forkLifecycleSession({
						actor: { namespace: "openwebui-gjc-adapter", id: input.source.principalId },
						capability: "session.fork",
						requestKey: input.source.requestKey,
						target: {
							sourceSessionId: source.sessionId,
							sourceGeneration: source.generation,
							operationHash,
						},
						timeoutMs: input.timeoutMs,
					} as never),
				);
				if (!isSuccess(outcome)) throw new Error("Managed session.fork failed.");
				acknowledged = true;
				returnedTarget = tenantFromFork(input.target, outcome);
				if (returnedTarget === undefined)
					throw new ManagedSuccessorUncertainError("Managed fork acknowledgement lacks a target identity.");
				// An abort after lifecycle invocation is ambiguous even when the fork later acknowledges.
				if (input.signal?.aborted) throw new GjcTurnCancelledError();
				const successor = await runtime.registerLifecycleTenant(returnedTarget);
				await proveTarget(runtime, returnedTarget);
				throwIfAborted(input.signal);
				await input.publish(successor);
				return { successor, operationHash };
			} catch (error) {
				if (!invoked) throw error;
				return await cleanupOrThrow(
					runtime,
					returnedTarget,
					input,
					error,
					!acknowledged || error instanceof GjcTurnCancelledError,
				);
			}
		},
	};
}

function tenant(
	authority: Pick<
		ManagedTurnAuthority,
		"principalId" | "projectId" | "canonicalWorkspace" | "chatId" | "sessionId" | "generation" | "leaseId" | "epoch"
	>,
): TenantSessionKey {
	return {
		principalId: authority.principalId,
		projectId: authority.projectId,
		canonicalWorkspace: authority.canonicalWorkspace,
		chatId: authority.chatId,
		sessionId: authority.sessionId,
		generation: authority.generation,
		leaseId: authority.leaseId,
		epoch: authority.epoch,
	};
}

function assertSuccessorAuthority(
	source: ManagedTurnAuthority,
	target: Omit<ManagedTurnAuthority, "sessionId" | "generation">,
): void {
	for (const authority of [source, target]) {
		if (
			!authority.principalId ||
			!authority.projectId ||
			!authority.canonicalWorkspace ||
			!authority.chatId ||
			!authority.leaseId ||
			!authority.epoch ||
			!authority.requestKey
		)
			throw new TypeError("Complete managed successor tenancy is required.");
	}
	if (!source.sessionId || !Number.isSafeInteger(source.generation) || source.generation <= 0)
		throw new TypeError("Managed successor source requires an exact positive generation.");
	for (const field of ["principalId", "projectId", "canonicalWorkspace", "chatId", "leaseId", "epoch"] as const) {
		if (source[field] !== target[field]) throw new Error("Managed successor crosses a tenant authority boundary.");
	}
}

async function proveTarget(runtime: ManagedSdkRuntime, target: TenantSessionKey): Promise<ManagedSdkAttachment> {
	await runtime.reconcile();
	const attachment = await runtime.acquireAttachment(target);
	if (attachment.generation !== target.generation || attachment.tenant.sessionId !== target.sessionId)
		throw new Error("Managed successor attachment is not the exact target generation.");
	const status = await runtime.generationStatus(target);
	if (status.status !== "current" || !attachment.attachment.isCurrent())
		throw new Error("Managed successor target generation is not current.");
	return attachment;
}

async function cleanupOrThrow(
	runtime: ManagedSdkRuntime,
	target: TenantSessionKey | undefined,
	input: ManagedSuccessorInput,
	cause: unknown,
	invocationUncertain: boolean,
): Promise<never> {
	if (target === undefined)
		throw new ManagedSuccessorUncertainError("Managed successor target is unknown; cleanup cannot be proven.", {
			cause,
		});
	try {
		await runtime.closeLifecycleSession({
			actor: { namespace: "openwebui-gjc-adapter", id: input.source.principalId },
			capability: "session.close",
			requestKey: input.source.requestKey,
			target: { sessionId: target.sessionId, endpointGeneration: target.generation },
			timeoutMs: input.timeoutMs,
		} as never);
		await runtime.reconcile();
		const status = await runtime.generationStatus(target);
		if (status.status === "retired") {
			runtime.unregisterTenant(target);
			if (invocationUncertain)
				throw new ManagedSuccessorUncertainError(
					"Managed successor invocation outcome is uncertain after cleanup.",
					{
						cause,
					},
				);
			throw cause;
		}
		throw new ManagedSuccessorUncertainError("Failed managed successor cleanup is not retired.", { cause });
	} catch (cleanup) {
		if (cleanup === cause) throw cleanup;
		throw new ManagedSuccessorUncertainError("Failed managed successor cleanup is uncertain.", {
			cause: new AggregateError([cause, cleanup]),
		});
	}
}

function unwrapOutcome(value: unknown): unknown {
	return isRecord(value) && value.kind === "result" && "outcome" in value ? value.outcome : value;
}

function isSuccess(value: unknown): boolean {
	return isRecord(value) && value.ok === true;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new GjcTurnCancelledError();
}

function successorHash(
	source: TenantSessionKey,
	target: Omit<ManagedTurnAuthority, "sessionId" | "generation">,
): string {
	return createHash("sha256").update(JSON.stringify({ source, target })).digest("hex");
}

function tenantFromFork(
	target: Omit<ManagedTurnAuthority, "sessionId" | "generation">,
	outcome: unknown,
): TenantSessionKey | undefined {
	if (!isRecord(outcome) || outcome.ok !== true || !isRecord(outcome.result)) return undefined;
	const sessionId = outcome.result.sessionId;
	const generation = outcome.result.endpointGeneration;
	if (
		typeof sessionId !== "string" ||
		sessionId.length === 0 ||
		typeof generation !== "number" ||
		!Number.isSafeInteger(generation) ||
		generation <= 0
	)
		return undefined;
	return tenant({ ...target, sessionId, generation });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
