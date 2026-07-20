import { createHash } from "node:crypto";
import { GJC_THINKING_LEVELS, type NormalizedModelSelection } from "../contracts";
import type { SessionAttachmentProof, SessionAuthorityInput, SessionAuthorityRecord, SessionOperation, SessionOperationResult } from "./session-authority-types";
import type { GjcTurnEvent } from "./turn-runner";
import { copy } from "./session-authority-copy";

export interface SessionOperationMapping {
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
}

export function hashTurnIngress(input: {
	readonly chatId: string;
	readonly projectId: string;
	readonly parentId?: string;
	readonly text: string;
	readonly modelSelection?: NormalizedModelSelection;
}): string {
	return createHash("sha256")
		.update(JSON.stringify(input))
		.digest("hex");
}

export function closeIngressId(operationId: string, mapping: SessionOperationMapping): string {
	return `close:${createHash("sha256").update(JSON.stringify({
		kind: "close",
		operationId,
		projectId: mapping.projectId,
		chatId: mapping.chatId,
		sessionId: mapping.sessionId,
	})).digest("hex")}`;
}

export function operationResult(kind: "turn" | "control" | "close", mapping: SessionOperationMapping): SessionOperationResult {
	return {
		kind,
		assistantText: mapping.assistantText ?? "",
		events: mapping.events ?? [],
		mapping: {
			chatId: mapping.chatId,
			projectId: mapping.projectId,
			sessionId: mapping.sessionId,
			...(mapping.sessionFile === undefined ? {} : { sessionFile: mapping.sessionFile }),
			...(mapping.activeLeaf === undefined ? {} : { activeLeaf: mapping.activeLeaf }),
			rawFrameCursor: mapping.rawFrameCursor,
			eventCursor: mapping.eventCursor,
			operationId: mapping.operationId,
			...(mapping.modelSelection === undefined ? {} : { modelSelection: mapping.modelSelection }),
			...(mapping.attachment === undefined
				? {}
				: { attachment: copyAttachment(mapping.attachment) }),
		},
		...(kind === "close" ? { correlation: { closeStatus: "closed" } } : {}),
	};
}

export function copyAttachment(attachment: SessionAttachmentProof): SessionAttachmentProof {
	return { ...attachment, descriptorStat: { ...attachment.descriptorStat } };
}
export function appendJournal(existing: readonly SessionOperation[], incoming: readonly SessionOperation[]): SessionOperation[] {
	const journal = [...existing];
	for (const operation of incoming) {
		const duplicate = journal.find(candidate =>
			candidate.id === operation.id ||
			(operation.ingressId !== undefined && candidate.ingressId === operation.ingressId));
		if (duplicate === undefined) journal.push(operation);
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
	const createdAt = input.createdAt ?? new Date().toISOString();
	const journal = input.journal ?? [];
	const operation = journal.find(candidate =>
		candidate.id === input.operationId ||
		candidate.ingressId === input.operationId);
	return copy({
		...input,
		version: 2,
		createdAt,
		header: input.header ?? {
			chatId: input.chatId,
			projectId: input.projectId,
			sessionId: input.sessionId,
		},
		journal: operation === undefined
			? [...journal, implicitOperation(input.operationId, createdAt)]
			: journal,
	});
}

export function updateAuthorityIdentity(input: SessionAuthorityInput, existing: SessionAuthorityRecord): SessionAuthorityRecord {
	const journal = appendJournal(existing.journal, input.journal ?? []);
	const operation = journal.find(candidate =>
		candidate.id === input.operationId ||
		candidate.ingressId === input.operationId);
	if (operation?.state === "conflict" || operation?.state === "uncertain") {
		throw new Error(`Session operation ${input.operationId} requires reconciliation.`);
	}
	return copy({
		...existing,
		...input,
		version: 2,
		createdAt: existing.createdAt,
		header: {
			chatId: input.chatId,
			projectId: input.projectId,
			sessionId: input.sessionId,
		},
		journal: operation === undefined
			? [...journal, implicitOperation(input.operationId, existing.createdAt)]
			: journal,
	});
}

export function replayCloseOperation(operationId: string, result: SessionOperationResult | undefined): { readonly status: "closed" } {
	if (result?.kind !== "close" || result.correlation?.closeStatus !== "closed")
		throw new Error(`GJC close ${operationId} completed without a valid immutable result binding.`);
	return { status: "closed" };
}

export const UNSAFE_MODEL_COMPONENT = /[\p{Cc}\p{White_Space}]|%[0-9a-f]{2}/iu;

export function normalizeModelSelection(value: unknown): NormalizedModelSelection | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const provider = Reflect.get(value, "provider");
	const modelId = Reflect.get(value, "modelId");
	const thinkingLevel = Reflect.get(value, "thinkingLevel");
	if (!isSafeModelComponent(provider) || provider.includes("/") || !isSafeModelComponent(modelId)) return undefined;
	const normalizedThinkingLevel = GJC_THINKING_LEVELS.find(level => level === thinkingLevel);
	return normalizedThinkingLevel === undefined ? undefined : { provider, modelId, thinkingLevel: normalizedThinkingLevel };
}

function isSafeModelComponent(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !UNSAFE_MODEL_COMPONENT.test(value) && !value.split("/").some(segment => segment === "." || segment === "..");
}
