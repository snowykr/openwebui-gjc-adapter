import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { GJC_THINKING_LEVELS, type NormalizedModelSelection } from "../contracts";
import { copy, copyEvents, copySessionAuthorityBinding } from "./session-authority-copy";
import type {
	SessionAttachmentProof,
	SessionAuthorityBinding,
	SessionAuthorityInput,
	SessionAuthorityRecord,
	SessionOperation,
	SessionOperationGateBinding,
	SessionOperationResult,
} from "./session-authority-types";
import { isRecord } from "./session-authority-validation-primitives";
import type { GjcTurnEvent } from "./turn-runner";

export type SessionOperationMapping = SessionAuthorityBinding & {
	readonly chatId: string;
	readonly projectId: string;
	readonly sessionId: string;
	readonly sessionFile?: string;
	readonly activeLeaf?: string;
	readonly rawFrameCursor: number;
	readonly eventCursor: number;
	readonly operationId: string;
	readonly assistantText?: string;
	readonly events?: readonly GjcTurnEvent[];
	readonly modelSelection?: NormalizedModelSelection;
	readonly attachment?: SessionAttachmentProof;
};

export function hashTurnIngress(input: {
	readonly chatId: string;
	readonly projectId: string;
	readonly parentId?: string;
	readonly text: string;
	readonly modelSelection?: NormalizedModelSelection;
}): string {
	return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function closeIngressId(operationId: string, mapping: SessionOperationMapping): string {
	return `close:${createHash("sha256")
		.update(
			JSON.stringify({
				kind: "close",
				operationId,
				projectId: mapping.projectId,
				chatId: mapping.chatId,
				sessionId: mapping.sessionId,
				sessionFile: mapping.sessionFile,
				activeLeaf: mapping.activeLeaf,
				rawFrameCursor: mapping.rawFrameCursor,
				eventCursor: mapping.eventCursor,
				attachment: mapping.attachment,
			}),
		)
		.digest("hex")}`;
}
export function legacyCloseIngressId(operationId: string, mapping: SessionOperationMapping): string {
	return `close:${createHash("sha256")
		.update(
			JSON.stringify({
				kind: "close",
				operationId,
				projectId: mapping.projectId,
				chatId: mapping.chatId,
				sessionId: mapping.sessionId,
			}),
		)
		.digest("hex")}`;
}

/**
 * Builds the immutable result binding for a completed session operation.
 *
 * Replay evidence belongs to the operation, not just the replaceable current
 * mapping. Copy event payloads so later turns and caller mutations cannot
 * rewrite a completed operation's replay.
 */
export function operationResult(
	kind: "turn" | "control" | "close",
	mapping: SessionOperationMapping,
	gate?: SessionOperationGateBinding,
): SessionOperationResult {
	return {
		kind,
		assistantText: mapping.assistantText ?? "",
		events: copyEvents(mapping.events ?? []),
		mapping: {
			chatId: mapping.chatId,
			projectId: mapping.projectId,
			sessionId: mapping.sessionId,
			...(mapping.sessionFile === undefined ? {} : { sessionFile: mapping.sessionFile }),
			...(mapping.activeLeaf === undefined ? {} : { activeLeaf: mapping.activeLeaf }),
			rawFrameCursor: mapping.rawFrameCursor,
			eventCursor: mapping.eventCursor,
			operationId: mapping.operationId,
			...(mapping.modelSelection === undefined ? {} : { modelSelection: { ...mapping.modelSelection } }),
			...(mapping.attachment === undefined ? {} : { attachment: copyAttachment(mapping.attachment) }),
		},
		...copySessionAuthorityBinding(mapping),
		...(kind === "close" ? { correlation: { closeStatus: "closed" } } : {}),
		...(gate === undefined ? {} : { gate: { ...gate } }),
	};
}

export function copyAttachment(attachment: SessionAttachmentProof): SessionAttachmentProof {
	return { ...attachment, descriptorStat: { ...attachment.descriptorStat } };
}
export function operationIdentifiers(operation: Pick<SessionOperation, "id" | "ingressId">): readonly string[] {
	return operation.ingressId === undefined || operation.ingressId === operation.id
		? [operation.id]
		: [operation.id, operation.ingressId];
}

export function appendJournal(
	existing: readonly SessionOperation[],
	incoming: readonly SessionOperation[],
): SessionOperation[] {
	const journal = [...existing];
	for (const operation of incoming) {
		const duplicate = journal.find(candidate =>
			operationIdentifiers(candidate).some(identifier => operationIdentifiers(operation).includes(identifier)),
		);
		if (duplicate === undefined) {
			journal.push(operation);
			continue;
		}
		if (duplicate.id === operation.id && duplicate.ingressId === operation.ingressId) continue;
		throw new Error(`Session operation ${operation.id} conflicts with an existing operation.`);
	}
	return journal;
}

export function implicitOperation(operationId: string, startedAt: string): SessionOperation {
	return {
		id: operationId,
		kind: "prompt",
		state: "complete",
		ingressId: operationId,
		startedAt,
		completedAt: new Date().toISOString(),
	};
}

export function provisionalKey(chatId: string, ingressId: string): string {
	return JSON.stringify([chatId, ingressId]);
}
export function createAuthorityIdentity(input: SessionAuthorityInput): SessionAuthorityRecord {
	const { managedAuthority: _managedAuthority, historicalBinding: _historicalBinding, ...fields } = input;
	const createdAt = input.createdAt ?? new Date().toISOString();
	const journal = appendJournal([], input.journal ?? []);
	const operation = journal.find(
		candidate => candidate.id === input.operationId || candidate.ingressId === input.operationId,
	);
	if (input.historicalBinding !== undefined && input.journal === undefined)
		throw new Error("Historical session authority requires an explicit journal without synthesized operations.");
	return copy({
		...fields,
		...copySessionAuthorityBinding(input),
		version: 2,
		createdAt,
		header: input.header ?? {
			chatId: input.chatId,
			projectId: input.projectId,
			sessionId: input.sessionId,
		},
		journal:
			input.historicalBinding !== undefined
				? [...input.journal!]
				: operation === undefined
					? [...journal, implicitOperation(input.operationId, createdAt)]
					: journal,
	});
}

export function updateAuthorityIdentity(
	input: SessionAuthorityInput,
	existing: SessionAuthorityRecord,
): SessionAuthorityRecord {
	const { managedAuthority: _existingManaged, historicalBinding: _existingHistorical, ...existingFields } = existing;
	const { managedAuthority: _inputManaged, historicalBinding: _inputHistorical, ...inputFields } = input;
	if (
		existing.historicalBinding !== undefined &&
		(input.managedAuthority !== undefined ||
			(input.historicalBinding !== undefined &&
				!isDeepStrictEqual(input.historicalBinding, existing.historicalBinding)) ||
			input.chatId !== existing.chatId ||
			input.projectId !== existing.projectId ||
			input.sessionId !== existing.sessionId ||
			input.operationId !== existing.operationId ||
			input.attachment !== undefined)
	)
		throw new Error("Historical session authority requires an explicit proven binding transaction.");
	if (existing.managedAuthority !== undefined && input.historicalBinding !== undefined)
		throw new Error("Managed session authority cannot be replaced with unbound history.");
	if (
		existing.historicalBinding !== undefined &&
		(input.journal ?? []).some(operation => !existing.journal.some(prior => isDeepStrictEqual(prior, operation)))
	)
		throw new Error("Historical journal updates require explicit reconciliation.");
	const binding = input.managedAuthority === undefined && input.historicalBinding === undefined ? existing : input;
	const journal = appendJournal(existing.journal, input.journal ?? []);
	const operation = journal.find(
		candidate => candidate.id === input.operationId || candidate.ingressId === input.operationId,
	);
	if (input.historicalBinding !== undefined && existing.historicalBinding === undefined && operation === undefined)
		throw new Error("Historical session authority cannot synthesize a completed operation.");
	if (operation?.state === "conflict" || operation?.state === "uncertain") {
		throw new Error(`Session operation ${input.operationId} requires reconciliation.`);
	}
	return copy({
		...existingFields,
		...inputFields,
		...copySessionAuthorityBinding(binding),
		version: 2,
		createdAt: existing.createdAt,
		header: {
			chatId: input.chatId,
			projectId: input.projectId,
			sessionId: input.sessionId,
		},
		journal:
			existing.historicalBinding !== undefined
				? [...existing.journal]
				: operation === undefined
					? [...journal, implicitOperation(input.operationId, existing.createdAt)]
					: journal,
	});
}

export function replayCloseOperation(
	operationId: string,
	result: SessionOperationResult | undefined,
	mappingOperationId: string,
	legacyMappingCompatible = false,
): { readonly status: "closed" } {
	const resultMappingOperationId = result?.correlation?.mappingOperationId;
	if (
		result?.kind !== "close" ||
		result.correlation?.closeStatus !== "closed" ||
		(resultMappingOperationId !== mappingOperationId &&
			!(resultMappingOperationId === undefined && legacyMappingCompatible))
	)
		throw new Error(`GJC close ${operationId} completed without a valid immutable result binding.`);
	return { status: "closed" };
}

export const UNSAFE_MODEL_COMPONENT = /[\p{Cc}\p{White_Space}]|%[0-9a-f]{2}/iu;

export function normalizeModelSelection(value: unknown): NormalizedModelSelection | undefined {
	if (!isRecord(value) || !Object.keys(value).every(key => ["provider", "modelId", "thinkingLevel"].includes(key)))
		return undefined;
	const { provider, modelId, thinkingLevel } = value;
	if (!isSafeModelComponent(provider) || provider.includes("/") || !isSafeModelComponent(modelId)) return undefined;
	const normalizedThinkingLevel = GJC_THINKING_LEVELS.find(level => level === thinkingLevel);
	return normalizedThinkingLevel === undefined
		? undefined
		: { provider, modelId, thinkingLevel: normalizedThinkingLevel };
}

function isSafeModelComponent(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		!UNSAFE_MODEL_COMPONENT.test(value) &&
		!value.split("/").some(segment => segment === "." || segment === "..")
	);
}
