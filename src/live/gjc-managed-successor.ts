import { createHash } from "node:crypto";
import type { ManagedSdkAttachment, ManagedSdkRuntime, TenantSessionKey } from "../gjc/managed-sdk-runtime";
import { GjcTurnCancelledError, type ManagedTurnAuthority } from "../gjc/turn-runner";

export interface ManagedSuccessorInput {
	readonly source: ManagedTurnAuthority;
	readonly target: ManagedTurnAuthority;
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
			const target = tenant(input.target);
			const operationHash = successorHash(source, target);
			let invoked = false;
			let acknowledged = false;
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
							targetSessionId: target.sessionId,
							endpointGeneration: target.generation,
							operationHash,
						},
						timeoutMs: input.timeoutMs,
					} as never),
				);
				if (!isSuccess(outcome)) throw new Error("Managed session.fork failed.");
				acknowledged = true;
				// An abort after lifecycle invocation is ambiguous even when the fork later acknowledges.
				if (input.signal?.aborted) throw new GjcTurnCancelledError();
				const successor = await proveTarget(runtime, target);
				throwIfAborted(input.signal);
				await input.publish(successor);
				return { successor, operationHash };
			} catch (error) {
				if (!invoked) throw error;
				return await cleanupOrThrow(
					runtime,
					target,
					input,
					error,
					!acknowledged || error instanceof GjcTurnCancelledError,
				);
			}
		},
	};
}

function tenant(authority: ManagedTurnAuthority): TenantSessionKey {
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

function assertSuccessorAuthority(source: ManagedTurnAuthority, target: ManagedTurnAuthority): void {
	for (const authority of [source, target]) {
		if (
			!authority.principalId ||
			!authority.projectId ||
			!authority.canonicalWorkspace ||
			!authority.chatId ||
			!authority.sessionId ||
			!authority.leaseId ||
			!authority.epoch ||
			!authority.requestKey ||
			!Number.isSafeInteger(authority.generation) ||
			authority.generation <= 0
		)
			throw new TypeError("Complete positive managed successor authority is required.");
	}
	if (source.sessionId === target.sessionId)
		throw new TypeError("Managed successor target must have a distinct session id.");
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
	target: TenantSessionKey,
	input: ManagedSuccessorInput,
	cause: unknown,
	invocationUncertain: boolean,
): Promise<never> {
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

function successorHash(source: TenantSessionKey, target: TenantSessionKey): string {
	return createHash("sha256").update(JSON.stringify({ source, target })).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
