import { ensureSdkSessionFile, validateSessionFile } from "./session-file";
import { resolveEffectiveGjcSessionRoot } from "./session-root";
import { type GjcTurnRunner, getProjectSessionRoot } from "./turn-runner";
import type { ProvisionalSessionOperation, SessionOperationResult } from "./session-authority";
import { copyAttachment, hashTurnIngress, normalizeModelSelection } from "./session-operation-codec";
import type { RouteGjcTurnInput, RouteGjcTurnResult } from "./session-router";

export async function routeGjcTurn(input: RouteGjcTurnInput): Promise<RouteGjcTurnResult> {
	const existing = input.mappings.get(input.chatId);
	const operationHash = hashTurnIngress({
		chatId: input.chatId,
		projectId: input.project.id,
		parentId: input.parentId,
		text: input.text,
		...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
	});
	const priorOperation = existing === undefined ? undefined : input.mappings.operation(input.chatId, input.userMessageId);
	if (priorOperation?.state === "complete") {
		if (priorOperation.detail !== operationHash)
			throw new Error(`GJC operation ${input.userMessageId} conflicts with a different ingress payload.`);
		const replayed = replayOperation(input.userMessageId, priorOperation.result);
		const sessionRoot = resolveEffectiveGjcSessionRoot(
			input.project.cwd,
			getProjectSessionRoot(input.project),
			input.runner.resolveSessionRoot,
		);
		return withLifecyclePublication(
			input.runner,
			{
				cwd: input.project.cwd,
				sessionRoot,
				projectId: replayed.mapping.projectId,
				chatId: replayed.mapping.chatId,
				sessionId: replayed.mapping.sessionId,
				sessionFile: replayed.mapping.sessionFile,
				recoveryAttachment: replayed.mapping.attachment,
			},
			async () => {
				input.afterPublish?.(replayed);
				return replayed;
			},
		);
	}
	if (priorOperation?.state === "pending") {
		throw new Error(`GJC operation ${input.userMessageId} is pending and cannot be replayed.`);
	}
	if (priorOperation?.state === "uncertain" || priorOperation?.state === "conflict") {
		throw new Error(`GJC operation ${input.userMessageId} requires reconciliation.`);
	}

	if (existing === undefined || existing.projectId !== input.project.id) {
		return startNewMappedSession(input);
	}

	const sessionRoot = resolveEffectiveGjcSessionRoot(
		input.project.cwd,
		getProjectSessionRoot(input.project),
		input.runner.resolveSessionRoot,
	);
	const existingSessionFile = await ensureSdkSessionFile(input.project, existing.sessionFile, sessionRoot);
	const address = {
		cwd: input.project.cwd,
		sessionRoot,
		projectId: input.project.id,
		sessionId: existing.sessionId,
		chatId: input.chatId,
	};
	return withLifecyclePublication(input.runner, { ...address, sessionFile: existingSessionFile, recoveryAttachment: existing.attachment }, async lifecycle => {
		const operation = beginDurableOperation(input);
		try {
			await input.runner.switchSession({ ...address, lifecycle, sessionFile: existingSessionFile, recoveryAttachment: existing.attachment });
			const state = await input.runner.getState({ ...address, lifecycle, sessionFile: existingSessionFile, recoveryAttachment: existing.attachment });
			const result = await input.runner.continueSession({
				...address,
				sessionFile: existingSessionFile,
				userMessageId: input.userMessageId,
				parentId: input.parentId,
				text: input.text,
				activeLeaf: state.activeLeaf,
				rawFrameCursor: state.rawFrameCursor,
				eventCursor: state.eventCursor,
				operationId: input.userMessageId,
				recoveryAttachment: existing.attachment,
				lifecycle,
				...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
			});
			const completedSelection =
				input.modelSelection === undefined ? undefined : normalizeModelSelection(result.modelSelection);
			if (input.modelSelection !== undefined && completedSelection === undefined)
				throw new TypeError("Missing selected GJC outcome");
			const sessionFile = [result.sessionFile, state.sessionFile, existingSessionFile].find(candidate => candidate !== undefined);
			const assistantText = input.projectAssistantText?.(result) ?? result.text;
			const nextMapping = {
				chatId: input.chatId,
				projectId: input.project.id,
				sessionId: existing.sessionId,
				sessionFile: sessionFile === undefined ? undefined : validateSessionFile(input.project, sessionFile, sessionRoot),
				activeLeaf: result.activeLeaf ?? state.activeLeaf,
				rawFrameCursor: result.rawFrameCursor,
				eventCursor: result.eventCursor,
				operationId: input.userMessageId,
				assistantText,
				events: result.events,
				...((result.attachment ?? state.attachment ?? existing.attachment) === undefined ? {} : { attachment: result.attachment ?? state.attachment ?? existing.attachment }),
				...(completedSelection === undefined ? {} : { modelSelection: completedSelection }),
			};
			const proof = result.attachment ?? state.attachment ?? existing.attachment;
			if (proof === undefined) throw new Error("GJC turn did not return a validated current attachment.");
			const mapping = await lifecycle.publish(proof, () => {
				const published = input.mappings.completeOperationWithMapping(input.chatId, operation.key, operation.hash, nextMapping, "turn");
				input.afterPublish?.({ assistantText, events: result.events, mapping: published });
				return published;
			});
			return { assistantText, events: result.events, mapping };
		} catch (error) {
			input.mappings.transitionOperation(input.chatId, operation.key, "uncertain", operation.hash);
			throw error;
		}
	});
}

async function startNewMappedSession(input: RouteGjcTurnInput): Promise<RouteGjcTurnResult> {
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
	const markUncertain = () => {
		if (!authorityCompleted)
			input.mappings.transitionProvisionalOperation(input.chatId, input.userMessageId, "uncertain", operation.detail);
	};
	try {
		const routed = await input.runner.startNewSession(
			{
				cwd: input.project.cwd,
				sessionRoot,
				projectId: input.project.id,
				chatId: input.chatId,
				userMessageId: input.userMessageId,
				parentId: input.parentId,
				text: input.text,
				...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
			},
			async (result, lifecycle) => {
				const completedSelection =
					input.modelSelection === undefined ? undefined : normalizeModelSelection(result.modelSelection);
				if (input.modelSelection !== undefined && completedSelection === undefined)
					throw new TypeError("Missing selected GJC outcome");
				if (result.attachment === undefined) throw new Error("New GJC session did not return a validated current attachment.");
				const assistantText = input.projectAssistantText?.(result) ?? result.text;
				const mapping = await lifecycle.publish(result.attachment, () => {
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
						attachment: result.attachment,
						...(completedSelection === undefined ? {} : { modelSelection: completedSelection }),
					});
					authorityCompleted = true;
					input.afterPublish?.({ assistantText, events: result.events, mapping: published });
					return published;
				});
				return { assistantText, events: result.events, mapping };
			},
			async (address, attachment) => { input.mappings.attachProvisionalOperation(input.chatId, input.userMessageId, { sessionId: address.sessionId, sessionFile: validateSessionFile(input.project, address.sessionFile, sessionRoot), attachment }); },
			async () => { markUncertain(); },
		);
		return routed;
	} catch (error) {
		markUncertain();
		throw error;
	}
}
function beginDurableOperation(input: RouteGjcTurnInput): { readonly key: string; readonly hash: string } {
	const key = input.userMessageId;
	const hash = hashTurnIngress({
		chatId: input.chatId,
		projectId: input.project.id,
		parentId: input.parentId,
		text: input.text,
		...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
	});
	input.mappings.beginOperation(input.chatId, { id: key, kind: "prompt", ingressId: key, detail: hash });
	return { key, hash };
}

async function withLifecyclePublication<T>(
	runner: GjcTurnRunner,
	address: import("./turn-runner").GjcLifecyclePublicationAddress,
	effect: (lifecycle: import("./turn-runner").GjcLifecycleTransaction) => Promise<T>,
): Promise<T> {
	if (runner.withLifecyclePublication === undefined)
		throw new Error("GJC runner must provide lifecycle publication for mutating operations.");
	return runner.withLifecyclePublication(address, effect);
}

function provisionalOperation(input: RouteGjcTurnInput): Omit<ProvisionalSessionOperation, "state" | "startedAt" | "completedAt"> {
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

export function replayOperation(operationId: string, result: SessionOperationResult | undefined): RouteGjcTurnResult {
	if (result === undefined || result.kind !== "turn" || result.mapping.operationId !== operationId)
		throw new Error(`GJC operation ${operationId} completed without a valid immutable result binding.`);
	return {
		assistantText: result.assistantText,
		events: result.events,
		mapping: {
			...result.mapping,
			...(result.mapping.attachment === undefined ? {} : { attachment: copyAttachment(result.mapping.attachment) }),
			operationId,
			assistantText: result.assistantText,
			events: result.events,
		},
	};
}
