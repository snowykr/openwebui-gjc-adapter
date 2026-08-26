import type { ProvisionalSessionOperation } from "./session-authority";
import { SESSION_AUTHORITY_V3_EPOCH } from "./session-authority-v3";
import { validateSessionFile } from "./session-file";
import { hashTurnIngress, normalizeModelSelection } from "./session-operation-codec";
import { resolveEffectiveGjcSessionRoot } from "./session-root";
import type { RouteGjcTurnInput, RouteGjcTurnResult } from "./session-turn-router-contract";
import {
	type GjcLifecycleTransaction,
	type GjcSessionAddress,
	GjcTurnCancelledError,
	type GjcTurnResult,
	getProjectSessionRoot,
	type ManagedGenerationProof,
	type ManagedPreparedTurnAuthority,
	type ManagedTurnAuthority,
} from "./turn-runner";

export async function startNewMappedSession(input: RouteGjcTurnInput): Promise<RouteGjcTurnResult> {
	throwIfAborted(input.signal);
	const operation = provisionalOperation(input);
	const reserved = input.mappings.reserveProvisionalOperation(operation);
	if (reserved.state !== "pending") {
		throw new Error(
			reserved.state === "complete"
				? `GJC operation ${input.userMessageId} completed without a published session mapping.`
				: `GJC operation ${input.userMessageId} requires reconciliation.`,
		);
	}
	const sessionRoot = resolveEffectiveGjcSessionRoot(
		input.project.cwd,
		getProjectSessionRoot(input.project),
		input.runner.resolveSessionRoot,
	);
	let authorityCompleted = false;
	let promptMayHaveDispatched = false;
	const markUncertain = () => {
		if (!authorityCompleted)
			input.mappings.transitionProvisionalOperation(
				input.chatId,
				input.userMessageId,
				"uncertain",
				operation.detail,
			);
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
		const managedAuthority =
			input.preparedManagedAuthority === undefined
				? result.managedAuthority
				: managedAuthorityFor(input.preparedManagedAuthority, result.managedProof, result.sessionId);
		if (result.attachment === undefined && result.managedProof === undefined)
			throw new Error("New GJC session did not return validated generation authority.");
		const assistantText = input.projectAssistantText?.(result) ?? result.text;
		const transactionPublish =
			input.preparedManagedAuthority === undefined
				? result.managedProof === undefined
					? result.attachment === undefined
						? undefined
						: (write: () => import("./session-router").SessionMapping) =>
								lifecycle.publish(result.attachment!, write)
					: lifecycle.publishManaged === undefined
						? undefined
						: (write: () => import("./session-router").SessionMapping) =>
								lifecycle.publishManaged!(result.managedProof!, write)
				: result.managedProof === undefined || lifecycle.publishManaged === undefined
					? undefined
					: (write: () => import("./session-router").SessionMapping) =>
							lifecycle.publishManaged!(result.managedProof!, write);
		if (transactionPublish === undefined)
			throw new Error("Lifecycle transaction cannot publish managed generation authority.");
		const mapping = await transactionPublish(() => {
			throwIfAborted(input.signal);
			const published = input.mappings.publishProvisionalOperation(operation, {
				chatId: input.chatId,
				projectId: input.project.id,
				sessionId: result.sessionId,
				sessionFile: validateSessionFile(input.project, result.sessionFile, sessionRoot),
				activeLeaf: result.activeLeaf,
				rawFrameCursor: result.rawFrameCursor,
				eventCursor: result.eventCursor,
				operationId: input.userMessageId,
				assistantText,
				events: result.events,
				...(result.attachment === undefined ? {} : { attachment: result.attachment }),
				...(managedAuthority === undefined ? {} : { managedAuthority }),
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
			...(input.principalId === undefined ? {} : { principalId: input.principalId }),
			...(input.preparedManagedAuthority === undefined
				? {}
				: { preparedManagedAuthority: input.preparedManagedAuthority }),
		} as const;
		if (input.preparedManagedAuthority === undefined) {
			return await input.runner.startNewSession(
				startInput,
				publish,
				async (address, attachment) => {
					input.mappings.attachProvisionalOperation(input.chatId, input.userMessageId, {
						sessionId: address.sessionId,
						attachment,
					});
				},
				onFailure,
			);
		}
		if (input.runner.startManagedSession === undefined)
			throw new Error("GJC runner must provide managed session startup for prepared managed authority.");
		return await input.runner.startManagedSession(
			{ ...startInput, preparedManagedAuthority: input.preparedManagedAuthority },
			publish,
			async (address, proof) => {
				input.mappings.attachProvisionalOperation(input.chatId, input.userMessageId, {
					sessionId: address.sessionId,
					managedAuthority: managedAuthorityFor(input.preparedManagedAuthority!, proof, address.sessionId),
				});
			},
			onFailure,
		);
	} catch (error) {
		if (error instanceof GjcTurnCancelledError && !promptMayHaveDispatched) {
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
	if (proof === undefined) throw new Error("Managed GJC session did not return a generation proof.");
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
