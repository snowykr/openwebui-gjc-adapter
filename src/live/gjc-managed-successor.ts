import { createHash } from "node:crypto";
import { managedEndpointReceiptFromResult } from "../gjc/managed-lifecycle-evidence";
import { ManagedOperationDeadline } from "../gjc/managed-operation-deadline";
import type { ManagedSdkAttachment, ManagedSdkRuntime, TenantSessionKey } from "../gjc/managed-sdk-runtime";
import { GjcTurnCancelledError, type ManagedEndpointReceipt, type ManagedTurnAuthority } from "../gjc/turn-runner";

export interface ManagedSuccessorInput {
	readonly source: ManagedTurnAuthority;
	/** Target tenancy, never a caller-supplied successor session or generation. */
	readonly target: Omit<ManagedTurnAuthority, "sessionId" | "generation">;
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
	readonly onInvoking?: () => Promise<void> | void;
	readonly lifecycleOperation?: {
		readonly operationId: string;
		readonly requestKey: string;
		readonly payloadHash: string;
	};
	/** Persists the assigned target before cancellation, registration, or attachment proof. */
	readonly onAcknowledged?: (
		authority: ManagedTurnAuthority,
		endpointReceipt?: ManagedEndpointReceipt,
	) => Promise<void> | void;
	/** Renewed caller authority, deliberately separate from passive durable receipt capture. */
	readonly beforeProof?: () => Promise<void> | void;
	/** Called only after the exact target generation is reconciled, fenced, and current. */
	readonly publish: (successor: ManagedSdkAttachment) => Promise<void> | void;
}

export interface ManagedSuccessorResult {
	readonly successor: ManagedSdkAttachment;
	/** Exact managed authority reconstructed from the source fence and lifecycle identity. */
	readonly managedAuthority: ManagedTurnAuthority;
	readonly operationHash: string;
}

/**
 * Public lifecycle managed fork path. It never changes the source mapping;
 * callers retain it until `publish` receives a proven target attachment.
 */
export interface ManagedSuccessorFlow {
	fork(input: ManagedSuccessorInput): Promise<ManagedSuccessorResult>;
}

export class ManagedSuccessorUncertainError extends Error {
	readonly acknowledgedAuthority: ManagedTurnAuthority | undefined;
	constructor(message: string, options?: ErrorOptions & { readonly acknowledgedAuthority?: ManagedTurnAuthority }) {
		super(message, options);
		this.name = "ManagedSuccessorUncertainError";
		this.acknowledgedAuthority =
			options?.acknowledgedAuthority === undefined ? undefined : { ...options.acknowledgedAuthority };
	}
}

export function createManagedSuccessorFlow(
	runtime: ManagedSdkRuntime,
	defaultTimeoutMs = 30_000,
): ManagedSuccessorFlow {
	return {
		async fork(input) {
			input = {
				...input,
				source: { ...input.source },
				target: { ...input.target },
				...(input.lifecycleOperation === undefined ? {} : { lifecycleOperation: { ...input.lifecycleOperation } }),
			};
			assertSuccessorAuthority(input.source, input.target);
			throwIfAborted(input.signal);
			const source = tenant(input.source);
			const operationHash = successorHash(source, input.target);
			const deadline = new ManagedOperationDeadline(input.timeoutMs ?? defaultTimeoutMs, "session.fork");
			const step = <T>(effect: () => Promise<T>): Promise<T> => {
				deadline.remaining();
				return deadline.wait(effect());
			};
			let invoked = false;
			let acknowledged = false;
			let returnedTarget: TenantSessionKey | undefined;
			let acknowledgedAuthority: ManagedTurnAuthority | undefined;
			let acknowledgementPending = false;
			let hasValidReceipt = false;
			let invalidAcknowledgement: unknown;
			let proofAdmissionPending = false;
			try {
				// Reconciliation plus acquire re-proves source registration, currentness, and tenant fencing.
				await step(() => runtime.reconcile(deadline.remaining()));
				assertExactAttachment(
					await step(() => runtime.acquireAttachment(source, deadline.remaining())),
					source,
					"source",
				);
				throwIfAborted(input.signal);
				await step(async () => input.onInvoking?.());
				throwIfAborted(input.signal);
				deadline.remaining();
				invoked = true;
				let outcomeObserved = false;
				const outcome = await step(() =>
					runtime.forkLifecycleSession(
						source,
						{
							actor: { namespace: "openwebui-gjc-adapter", id: input.source.principalId },
							capability: "session.fork",
							requestKey: input.source.requestKey,
							target: {
								sourceSessionId: source.sessionId,
								cwd: input.target.canonicalWorkspace,
							},
							timeoutMs: deadline.remaining(),
						},
						async outcome => {
							outcomeObserved = true;
							if (!outcome.ok || outcome.operation !== "session.fork") return;
							acknowledged = true;
							returnedTarget = tenantFromFork(input.target, outcome);
							if (returnedTarget === undefined) return;
							try {
								acknowledgedAuthority = managedSuccessorAuthority(input.source, returnedTarget);
							} catch (error) {
								invalidAcknowledgement = error;
								return;
							}
							const endpointReceipt = managedEndpointReceiptFromResult(outcome.result, acknowledgedAuthority);
							hasValidReceipt = endpointReceipt !== undefined;
							acknowledgementPending = true;
							await input.onAcknowledged?.(
								{ ...acknowledgedAuthority },
								endpointReceipt === undefined ? undefined : { ...endpointReceipt },
							);
							acknowledgementPending = false;
						},
					),
				);
				if (!outcome.ok || outcome.operation !== "session.fork") throw new Error("Managed session.fork failed.");
				if (invalidAcknowledgement !== undefined) throw invalidAcknowledgement;
				if (!outcomeObserved || returnedTarget === undefined || acknowledgedAuthority === undefined)
					throw new ManagedSuccessorUncertainError("Managed fork acknowledgement lacks a target identity.");
				if (!hasValidReceipt)
					throw new ManagedSuccessorUncertainError(
						"Managed fork acknowledgement lacks its original endpoint receipt.",
						{
							acknowledgedAuthority,
						},
					);
				// An abort after lifecycle invocation is ambiguous even when the fork later acknowledges.
				if (input.signal?.aborted) throw new GjcTurnCancelledError();
				proofAdmissionPending = true;
				await step(async () => input.beforeProof?.());
				proofAdmissionPending = false;
				if (input.lifecycleOperation === undefined)
					await step(() => runtime.registerLifecycleTenant(returnedTarget!, deadline.remaining()));
				const successor =
					input.lifecycleOperation === undefined
						? await proveTarget(runtime, returnedTarget, deadline)
						: await step(() =>
								runtime.proveLifecycleTenant(returnedTarget!, input.lifecycleOperation!, deadline.remaining()),
							);
				throwIfAborted(input.signal);
				await step(async () => input.publish(successor));
				return {
					successor,
					managedAuthority: acknowledgedAuthority,
					operationHash,
				};
			} catch (error) {
				if (!invoked) throw error;
				if (acknowledgementPending)
					throw new ManagedSuccessorUncertainError("Managed successor acknowledgement persistence is uncertain.", {
						cause: error,
						acknowledgedAuthority,
					});
				if (!hasValidReceipt && acknowledgedAuthority !== undefined)
					throw error instanceof ManagedSuccessorUncertainError
						? error
						: new ManagedSuccessorUncertainError(
								"Managed fork acknowledgement lacks its original endpoint receipt.",
								{
									cause: error,
									acknowledgedAuthority,
								},
							);
				if (proofAdmissionPending)
					throw new ManagedSuccessorUncertainError("Managed successor proof admission was denied.", {
						cause: error,
						acknowledgedAuthority,
					});
				return await cleanupOrThrow(
					runtime,
					returnedTarget,
					input,
					error,
					!acknowledged || error instanceof GjcTurnCancelledError,
					deadline,
				);
			} finally {
				deadline.close();
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
	if ("sessionId" in target || "generation" in target)
		throw new TypeError("Managed successor target identity is lifecycle-assigned.");
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
	if (source.requestKey !== target.requestKey) throw new Error("Managed successor request authority changed.");
}

async function proveTarget(
	runtime: ManagedSdkRuntime,
	target: TenantSessionKey,
	deadline: ManagedOperationDeadline,
): Promise<ManagedSdkAttachment> {
	await deadline.wait(runtime.reconcile(deadline.remaining()));
	const attachment = await deadline.wait(runtime.acquireAttachment(target, deadline.remaining()));
	assertExactAttachment(attachment, target, "target");
	const status = await deadline.wait(runtime.generationStatus(target, deadline.remaining()));
	if (status.status !== "current") throw new Error("Managed successor target generation is not current.");
	return attachment;
}

function assertExactAttachment(
	attachment: ManagedSdkAttachment,
	target: TenantSessionKey,
	role: "source" | "target",
): void {
	if (
		attachment.generation !== target.generation ||
		attachment.tenant.generation !== target.generation ||
		attachment.tenant.sessionId !== target.sessionId ||
		attachment.tenant.principalId !== target.principalId ||
		attachment.tenant.projectId !== target.projectId ||
		attachment.tenant.canonicalWorkspace !== target.canonicalWorkspace ||
		attachment.tenant.chatId !== target.chatId ||
		attachment.tenant.leaseId !== target.leaseId ||
		attachment.tenant.epoch !== target.epoch
	)
		throw new Error(`Managed successor ${role} attachment is not the exact target generation.`);
	if (!attachment.isCurrent()) throw new Error(`Managed successor ${role} attachment is not current.`);
}

function managedSuccessorAuthority(source: ManagedTurnAuthority, target: TenantSessionKey): ManagedTurnAuthority {
	if (
		target.principalId !== source.principalId ||
		target.projectId !== source.projectId ||
		target.canonicalWorkspace !== source.canonicalWorkspace ||
		target.chatId !== source.chatId ||
		target.leaseId !== source.leaseId ||
		target.epoch !== source.epoch ||
		target.sessionId === source.sessionId ||
		!Number.isSafeInteger(target.generation) ||
		target.generation <= 0
	)
		throw new Error("Managed successor crossed the source tenant authority boundary.");
	return { ...source, sessionId: target.sessionId, generation: target.generation };
}

async function cleanupOrThrow(
	runtime: ManagedSdkRuntime,
	target: TenantSessionKey | undefined,
	input: ManagedSuccessorInput,
	cause: unknown,
	invocationUncertain: boolean,
	deadline: ManagedOperationDeadline,
): Promise<never> {
	if (target?.sessionId === input.source.sessionId)
		throw new ManagedSuccessorUncertainError(
			"Managed successor returned the source session identity; source was retained.",
			{ cause },
		);
	if (target === undefined)
		throw new ManagedSuccessorUncertainError("Managed successor target is unknown; cleanup cannot be proven.", {
			cause,
		});
	try {
		const timeoutMs = deadline.remaining();
		const outcome = await deadline.wait(
			runtime.closeLifecycleSession(target, {
				actor: { namespace: "openwebui-gjc-adapter", id: input.source.principalId },
				capability: "session.close",
				requestKey: input.source.requestKey,
				target: { sessionId: target.sessionId, endpointGeneration: target.generation },
				timeoutMs,
			}),
		);
		if (!outcome.ok || outcome.operation !== "session.close" || outcome.result.sessionId !== target.sessionId)
			throw new Error("Managed successor cleanup lacks a matching successful close acknowledgement.");
		await deadline.wait(runtime.reconcile(deadline.remaining()));
		const status = await deadline.wait(runtime.generationStatus(target, deadline.remaining()));
		if (status.status !== "retired") throw new Error("Failed managed successor cleanup is not retired.");
		deadline.remaining();
		runtime.unregisterTenant(target);
	} catch (cleanup) {
		throw new ManagedSuccessorUncertainError("Failed managed successor cleanup is uncertain.", {
			cause: new AggregateError([cause, cleanup]),
			acknowledgedAuthority: managedSuccessorAuthority(input.source, target),
		});
	}
	if (invocationUncertain)
		throw new ManagedSuccessorUncertainError("Managed successor invocation outcome is uncertain after cleanup.", {
			cause,
			acknowledgedAuthority: managedSuccessorAuthority(input.source, target),
		});
	throw cause;
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
