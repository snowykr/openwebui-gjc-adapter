import { resolve } from "node:path";
import {
	createManagedLateCreateAcknowledgement,
	createManagedLifecycleEvidence,
	lifecycleExactAuthority,
	lifecyclePreparedAuthority,
	transitionManagedLifecycleEvidence,
} from "./managed-lifecycle-evidence";
import { canTransitionManagedLifecycleState } from "./managed-lifecycle-state";
import type { ProvisionalSessionOperation } from "./session-authority";
import { SESSION_AUTHORITY_V3_EPOCH } from "./session-authority-v3";
import { hashTurnIngress, normalizeModelSelection } from "./session-operation-codec";
import type { RouteGjcTurnInput, RouteGjcTurnResult } from "./session-turn-router-contract";
import {
	type GjcLifecycleTransaction,
	type GjcSessionAddress,
	GjcTurnCancelledError,
	type GjcTurnResult,
	getProjectSessionRoot,
	type ManagedEndpointReceipt,
	type ManagedGenerationProof,
	type ManagedPreparedTurnAuthority,
	type ManagedTurnAuthority,
} from "./turn-runner";

export async function startNewMappedSession(input: RouteGjcTurnInput): Promise<RouteGjcTurnResult> {
	input = {
		...input,
		project: { ...input.project },
		...(input.modelSelection === undefined ? {} : { modelSelection: { ...input.modelSelection } }),
	};
	throwIfAborted(input.signal);
	const prepared = preparedAuthorityFor(input);
	if (input.runner.startManagedSession === undefined)
		throw new Error("GJC runner must provide managed session startup for prepared managed authority.");
	const operation = provisionalOperation(input);
	const reserved = input.mappings.reserveProvisionalOperation(operation);
	if (reserved.state !== "pending") {
		throw new Error(
			reserved.state === "complete"
				? `GJC operation ${input.userMessageId} completed without a published session mapping.`
				: `GJC operation ${input.userMessageId} requires reconciliation.`,
		);
	}
	const sessionRoot = getProjectSessionRoot(input.project);
	let lifecycleEvidence = createManagedLifecycleEvidence({
		operation: "session.create",
		preparedAuthority: lifecyclePreparedAuthority(prepared),
		target: { kind: "existing_path", path: input.project.cwd },
		payloadHash: operation.detail!,
	});
	input.mappings.recordLifecycleEvidence(input.chatId, input.userMessageId, operation.detail!, lifecycleEvidence);
	const recordLifecycle = (next: typeof lifecycleEvidence) => {
		input.mappings.recordLifecycleEvidence(input.chatId, input.userMessageId, operation.detail!, next);
		lifecycleEvidence = next;
	};
	let boundAuthority: ManagedTurnAuthority | undefined;
	let authorityCompleted = false;
	let promptMayHaveDispatched = false;
	let admitted: ProvisionalSessionOperation | undefined;
	let passiveAcknowledgement = false;
	const markUncertain = () => {
		if (!authorityCompleted) {
			if (canTransitionManagedLifecycleState(lifecycleEvidence.state, "uncertain"))
				recordLifecycle(transitionManagedLifecycleEvidence(lifecycleEvidence, "uncertain"));
			input.mappings.transitionProvisionalOperation(
				input.chatId,
				input.userMessageId,
				"uncertain",
				operation.detail,
			);
		}
	};
	const publish = async (
		result: GjcSessionAddress & GjcTurnResult,
		lifecycle: GjcLifecycleTransaction,
	): Promise<RouteGjcTurnResult> => {
		throwIfAborted(input.signal);
		const completedSelection =
			input.modelSelection === undefined ? undefined : normalizeModelSelection(result.modelSelection);
		if (input.modelSelection !== undefined && completedSelection === undefined)
			throw new TypeError("Missing selected GJC outcome");
		assertManagedAddress(result, prepared);
		const proof = result.managedProof;
		const managedAuthority = managedAuthorityFor(prepared, proof, result.sessionId);
		if (boundAuthority === undefined) throw new Error("Managed GJC session was not bound before prompt dispatch.");
		assertSameManagedAuthority(managedAuthority, boundAuthority);
		if (result.managedAuthority !== undefined) assertSameManagedAuthority(result.managedAuthority, managedAuthority);
		if (proof === undefined || lifecycle.publishManaged === undefined)
			throw new Error("Lifecycle transaction cannot publish managed generation authority.");
		const assistantText = input.projectAssistantText?.(result) ?? result.text;
		const mapping = await lifecycle.publishManaged(proof, () => {
			throwIfAborted(input.signal);
			const published = input.mappings.publishProvisionalOperation(operation, {
				chatId: input.chatId,
				projectId: input.project.id,
				sessionId: result.sessionId,
				rawFrameCursor: result.rawFrameCursor,
				eventCursor: result.eventCursor,
				operationId: input.userMessageId,
				assistantText,
				events: result.events,
				managedAuthority,
				...(completedSelection === undefined ? {} : { modelSelection: completedSelection }),
			});
			authorityCompleted = true;
			input.afterPublish?.({ assistantText, events: result.events, mapping: published });
			return published;
		});
		return { assistantText, events: result.events, mapping };
	};
	const onFailure = async () => {
		promptMayHaveDispatched = true;
		markUncertain();
	};
	try {
		throwIfAborted(input.signal);
		const startInput = {
			cwd: input.project.cwd,
			sessionRoot,
			projectId: input.project.id,
			chatId: input.chatId,
			userMessageId: input.userMessageId,
			parentId: input.parentId,
			text: input.text,
			...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
			...(input.onObservedTurn === undefined ? {} : { observer: input.onObservedTurn }),
			...(input.signal === undefined ? {} : { signal: input.signal }),
			principalId: prepared.principalId,
			preparedManagedAuthority: { ...prepared },
			lifecycleOperation: {
				operationId: input.userMessageId,
				requestKey: prepared.requestKey,
				payloadHash: operation.detail!,
			},
			onLifecycleInvoking: () => {
				recordLifecycle(transitionManagedLifecycleEvidence(lifecycleEvidence, "invoking"));
				const reserved = input.mappings.provisionalOperation(input.chatId, input.userMessageId);
				if (reserved?.lifecycle?.state !== "invoking")
					throw new Error("Managed startup invocation lacks its durable provisional owner.");
				admitted = structuredClone(reserved);
			},
			onLifecycleAcknowledged: async (
				acknowledged: ManagedTurnAuthority,
				endpointReceipt?: ManagedEndpointReceipt,
			) => {
				const authority = managedAuthorityFor(
					prepared,
					{
						kind: "managed-generation",
						sessionId: acknowledged.sessionId,
						generation: acknowledged.generation,
						leaseId: acknowledged.leaseId,
						epoch: acknowledged.epoch,
					},
					acknowledged.sessionId,
				);
				assertSameManagedAuthority(authority, acknowledged);
				const retained = input.mappings.provisionalOperation(input.chatId, input.userMessageId);
				if (retained?.state === "uncertain" && retained.lifecycle?.state === "uncertain") {
					if (admitted === undefined) throw new Error("Managed startup lost its original invocation.");
					input.mappings.recordLateCreateAcknowledgement(
						input.chatId,
						admitted,
						createManagedLateCreateAcknowledgement(
							admitted,
							lifecycleExactAuthority(acknowledged),
							undefined,
							endpointReceipt,
						),
					);
					passiveAcknowledgement = true;
					return;
				}
				recordLifecycle(
					transitionManagedLifecycleEvidence(lifecycleEvidence, "acknowledged_unproven", {
						acknowledged: lifecycleExactAuthority(acknowledged),
						...(endpointReceipt === undefined ? {} : { endpointReceipt }),
					}),
				);
				input.mappings.attachProvisionalOperation(input.chatId, input.userMessageId, {
					sessionId: authority.sessionId,
					managedAuthority: authority,
				});
			},
			beforeLifecycleProof: () => {
				throwIfAborted(input.signal);
				if (passiveAcknowledgement || lifecycleEvidence.state !== "acknowledged_unproven")
					throw new Error("Passive create observation cannot authorize proof.");
			},
		} as const;
		return await input.runner.startManagedSession(
			startInput,
			publish,
			async (address, proof, lifecycle) => {
				throwIfAborted(input.signal);
				assertManagedAddress(address, prepared);
				const authority = managedAuthorityFor(prepared, proof, address.sessionId);
				if (boundAuthority !== undefined) assertSameManagedAuthority(authority, boundAuthority);
				if (lifecycleEvidence.state !== "acknowledged_unproven")
					throw new Error("Managed startup requires durable lifecycle acknowledgement before proof.");
				recordLifecycle(
					transitionManagedLifecycleEvidence(lifecycleEvidence, "active_generation_proven", { proven: proof }),
				);
				if (lifecycle.publishManaged === undefined)
					throw new Error("Lifecycle transaction cannot bind managed generation authority.");
				await lifecycle.publishManaged(proof, () => {
					throwIfAborted(input.signal);
					input.mappings.attachProvisionalOperation(input.chatId, input.userMessageId, {
						sessionId: address.sessionId,
						managedAuthority: authority,
					});
					boundAuthority = authority;
				});
			},
			onFailure,
		);
	} catch (error) {
		if (
			error instanceof GjcTurnCancelledError &&
			!promptMayHaveDispatched &&
			admitted === undefined &&
			lifecycleEvidence.state === "intent_prepared"
		) {
			try {
				input.mappings.discardPendingProvisionalOperation(input.chatId, operation);
			} catch (discardError) {
				try {
					markUncertain();
				} catch (transitionError) {
					throw new AggregateError(
						[error, discardError, transitionError],
						"pre-prompt cancellation provisional cleanup is uncertain",
					);
				}
				throw new AggregateError([error, discardError], "pre-prompt cancellation provisional cleanup is uncertain");
			}
			throw error;
		}
		markUncertain();
		throw error;
	}
}

function managedAuthorityFor(
	prepared: ManagedPreparedTurnAuthority,
	proof: ManagedGenerationProof | undefined,
	sessionId: string,
): ManagedTurnAuthority {
	if (
		proof === undefined ||
		proof.kind !== "managed-generation" ||
		!Number.isSafeInteger(proof.generation) ||
		proof.generation <= 0 ||
		typeof proof.sessionId !== "string" ||
		proof.sessionId.trim().length === 0
	)
		throw new Error("Managed GJC session did not return a positive generation proof.");
	if (proof.sessionId !== sessionId)
		throw new Error("Managed GJC generation proof session does not match the session address.");
	if (proof.leaseId !== prepared.leaseId || proof.epoch !== prepared.epoch)
		throw new Error("Managed GJC generation proof does not match the prepared authority.");
	return {
		principalId: prepared.principalId,
		projectId: prepared.projectId,
		canonicalWorkspace: prepared.canonicalWorkspace,
		chatId: prepared.chatId,
		sessionId: proof.sessionId,
		generation: proof.generation,
		leaseId: prepared.leaseId,
		epoch: proof.epoch,
		requestKey: prepared.requestKey,
		authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
	} as ManagedTurnAuthority & { readonly authorityEpoch: typeof SESSION_AUTHORITY_V3_EPOCH };
}

function preparedAuthorityFor(input: RouteGjcTurnInput): ManagedPreparedTurnAuthority {
	const prepared = input.preparedManagedAuthority;
	if (
		prepared === undefined ||
		![
			prepared.principalId,
			prepared.projectId,
			prepared.chatId,
			prepared.leaseId,
			prepared.epoch,
			prepared.requestKey,
		].every(value => typeof value === "string" && value.trim().length > 0) ||
		prepared.principalId !== input.principalId ||
		prepared.projectId !== input.project.id ||
		prepared.canonicalWorkspace !== resolve(input.project.cwd) ||
		prepared.chatId !== input.chatId ||
		prepared.requestKey !== input.userMessageId
	)
		throw new Error(
			"Prepared managed authority must match the exact principal, project, workspace, chat, and ingress.",
		);
	return { ...prepared };
}

function assertManagedAddress(address: GjcSessionAddress, prepared: ManagedPreparedTurnAuthority): void {
	if (
		address.projectId !== prepared.projectId ||
		address.chatId !== prepared.chatId ||
		resolve(address.cwd) !== prepared.canonicalWorkspace
	)
		throw new Error("Managed GJC session address does not match prepared authority.");
}

function assertSameManagedAuthority(actual: ManagedTurnAuthority, expected: ManagedTurnAuthority): void {
	for (const field of [
		"principalId",
		"projectId",
		"canonicalWorkspace",
		"chatId",
		"sessionId",
		"generation",
		"leaseId",
		"epoch",
		"requestKey",
	] as const)
		if (actual[field] !== expected[field])
			throw new Error("Managed GJC session authority changed before publication.");
	if (
		(actual as ManagedTurnAuthority & { readonly authorityEpoch?: unknown }).authorityEpoch !==
		(expected as ManagedTurnAuthority & { readonly authorityEpoch?: unknown }).authorityEpoch
	)
		throw new Error("Managed GJC session authority epoch changed before publication.");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new GjcTurnCancelledError();
}
function provisionalOperation(
	input: RouteGjcTurnInput,
): Omit<ProvisionalSessionOperation, "state" | "startedAt" | "completedAt"> {
	return {
		id: input.userMessageId,
		kind: "create",
		ingressId: input.userMessageId,
		chatId: input.chatId,
		projectId: input.project.id,
		detail: hashTurnIngress({
			chatId: input.chatId,
			projectId: input.project.id,
			parentId: input.parentId,
			text: input.text,
			...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
		}),
	};
}
