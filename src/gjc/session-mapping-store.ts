import {
	FileSessionAuthority,
	type ProvisionalSessionOperation,
	type SessionAttachmentProof,
	type SessionOperation,
	type SessionOperationResult,
	type SessionOperationState,
} from "./session-authority";
import type { NormalizedModelSelection } from "../contracts";
import type { GjcTurnEvent } from "./turn-runner";
import { copyAttachment, normalizeModelSelection, operationResult } from "./session-operation-codec";

export interface SessionMapping {
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

export class SessionMappingStore {
	readonly #mappings = new Map<string, SessionMapping>();
	readonly #operations = new Map<string, SessionOperation[]>();
	readonly #provisional = new Map<string, ProvisionalSessionOperation>();

	get(chatId: string): SessionMapping | undefined {
		const mapping = this.#mappings.get(chatId);
		return mapping === undefined ? undefined : copySessionMapping(mapping);
	}
	set(mapping: SessionMapping): SessionMapping {
		this.#mappings.set(mapping.chatId, copySessionMapping(mapping));
		return copySessionMapping(mapping);
	}
	upsert(mapping: SessionMapping): SessionMapping {
		const current = this.#mappings.get(mapping.chatId);
		const next = current === undefined ? mapping : { ...current, ...mapping };
		this.#mappings.set(mapping.chatId, copySessionMapping(next));
		return copySessionMapping(next);
	}
	entries(): readonly SessionMapping[] { return [...this.#mappings.values()].map(copySessionMapping); }
	operation(chatId: string, operationId: string): SessionOperation | undefined {
		return this.#operations.get(chatId)?.find(operation => operation.id === operationId || operation.ingressId === operationId);
	}
	beginOperation(chatId: string, operation: Omit<SessionOperation, "state" | "startedAt" | "completedAt">): void {
		const operations = this.#operations.get(chatId) ?? [];
		if (operations.some(candidate => candidate.id === operation.id || candidate.ingressId === operation.ingressId)) return;
		this.#operations.set(chatId, [...operations, { ...operation, state: "pending", startedAt: new Date().toISOString() }]);
	}
	transitionOperation(chatId: string, operationId: string, state: SessionOperationState, detail?: string, result?: SessionOperationResult): void {
		const operations = this.#operations.get(chatId);
		const index = operations?.findIndex(operation => operation.id === operationId || operation.ingressId === operationId) ?? -1;
		if (operations === undefined || index < 0) return;
		const current = operations[index]!;
		if (current.state === "complete" && state !== "complete") return;
		operations[index] = { ...current, state, ...(detail === undefined ? {} : { detail }), ...(result === undefined ? {} : { result }), ...(state === "complete" ? { completedAt: new Date().toISOString() } : {}) };
	}
	completeOperationWithMapping(chatId: string, operationId: string, detail: string, mapping: SessionMapping, kind: "turn" | "control" | "close"): SessionMapping {
		const published = this.upsert(mapping);
		this.transitionOperation(chatId, operationId, "complete", detail, operationResult(kind, published));
		return published;
	}
	provisionalOperation(chatId: string, ingressId: string): ProvisionalSessionOperation | undefined {
		const operation = this.#provisional.get(provisionalKey(chatId, ingressId));
		return operation === undefined ? undefined : { ...operation };
	}
	reserveProvisionalOperation(operation: Omit<ProvisionalSessionOperation, "state" | "startedAt" | "completedAt">): ProvisionalSessionOperation {
		const key = provisionalKey(operation.chatId, operation.ingressId ?? operation.id);
		const prior = this.#provisional.get(key);
		if (prior !== undefined) {
			if (prior.projectId !== operation.projectId || prior.detail !== operation.detail || prior.kind !== operation.kind) throw new Error(`GJC operation ${operation.ingressId ?? operation.id} conflicts with a different ingress payload.`);
			throw new Error(`GJC operation ${operation.ingressId ?? operation.id} requires reconciliation.`);
		}
		const next = { ...operation, state: "pending" as const, startedAt: new Date().toISOString() };
		this.#provisional.set(key, next);
		return { ...next };
	}
	publishProvisionalOperation(operation: Omit<ProvisionalSessionOperation, "state" | "startedAt" | "completedAt">, mapping: SessionMapping): SessionMapping {
		const key = provisionalKey(operation.chatId, operation.ingressId ?? operation.id);
		const reserved = this.#provisional.get(key);
		if (reserved === undefined || reserved.state !== "pending") throw new Error(`GJC operation ${operation.ingressId ?? operation.id} requires reconciliation.`);
		const published = this.upsert(mapping);
		const operations = this.#operations.get(operation.chatId) ?? [];
		this.#operations.set(operation.chatId, [...operations, { id: operation.id, kind: "prompt", state: "complete", ingressId: operation.ingressId, detail: operation.detail, startedAt: reserved.startedAt, completedAt: new Date().toISOString(), result: operationResult("turn", published) }]);
		this.#provisional.set(key, { ...reserved, state: "complete", completedAt: new Date().toISOString() });
		return published;
	}
	attachProvisionalOperation(chatId: string, ingressId: string, attachment: Pick<ProvisionalSessionOperation, "sessionId" | "sessionFile" | "attachment">): void {
		const key = provisionalKey(chatId, ingressId), current = this.#provisional.get(key);
		if (current === undefined || current.state !== "pending" || attachment.sessionId === undefined || attachment.sessionFile === undefined || attachment.attachment === undefined) throw new Error(`GJC operation ${ingressId} requires reconciliation.`);
		this.#provisional.set(key, { ...current, ...attachment });
	}
	transitionProvisionalOperation(chatId: string, ingressId: string, state: SessionOperationState, detail?: string): void {
		const key = provisionalKey(chatId, ingressId);
		const current = this.#provisional.get(key);
		if (current === undefined) return;
		if (current.state === "complete" && state !== "complete") throw new Error("Completed session operations are immutable.");
		this.#provisional.set(key, { ...current, state, ...(detail === undefined ? {} : { detail }) });
	}
}

export class FileBackedSessionMappingStore extends SessionMappingStore {
	readonly #authority: FileSessionAuthority;
	constructor(filePath: string) { super(); this.#authority = new FileSessionAuthority(filePath); }
	override get(chatId: string): SessionMapping | undefined { const mapping = this.#authority.get(chatId); return mapping === undefined ? undefined : copySessionMapping(mapping); }
	override set(mapping: SessionMapping): SessionMapping { return copySessionMapping(this.#authority.set(copySessionMapping(mapping))); }
	override upsert(mapping: SessionMapping): SessionMapping { return copySessionMapping(this.#authority.upsert(copySessionMapping(mapping))); }
	override entries(): readonly SessionMapping[] { return this.#authority.entries().map(copySessionMapping); }
	override operation(chatId: string, operationId: string): SessionOperation | undefined { return this.#authority.get(chatId)?.journal.find(operation => operation.id === operationId || operation.ingressId === operationId); }
	override beginOperation(chatId: string, operation: Omit<SessionOperation, "state" | "startedAt" | "completedAt">): void { this.#authority.beginOperation(chatId, operation); }
	override transitionOperation(chatId: string, operationId: string, state: SessionOperationState, detail?: string, result?: SessionOperationResult): void {
		if (this.operation(chatId, operationId)?.state === "complete" && state !== "complete") return;
		this.#authority.transitionOperation(chatId, operationId, state, detail, result);
	}
	override completeOperationWithMapping(chatId: string, operationId: string, detail: string, mapping: SessionMapping, kind: "turn" | "control" | "close"): SessionMapping {
		return copySessionMapping(this.#authority.completeOperationWithMapping(chatId, operationId, detail, copySessionMapping(mapping), operationResult(kind, mapping)));
	}
	override provisionalOperation(chatId: string, ingressId: string): ProvisionalSessionOperation | undefined { return this.#authority.provisionalOperation(chatId, ingressId); }
	override reserveProvisionalOperation(operation: Omit<ProvisionalSessionOperation, "state" | "startedAt" | "completedAt">): ProvisionalSessionOperation { return this.#authority.reserveProvisionalOperation(operation); }
	override publishProvisionalOperation(operation: Omit<ProvisionalSessionOperation, "state" | "startedAt" | "completedAt">, mapping: SessionMapping): SessionMapping { return copySessionMapping(this.#authority.publishProvisionalOperation(operation, mapping)); }
	override attachProvisionalOperation(chatId: string, ingressId: string, attachment: Pick<ProvisionalSessionOperation, "sessionId" | "sessionFile" | "attachment">): void { this.#authority.attachProvisionalOperation(chatId, ingressId, attachment); }
	override transitionProvisionalOperation(chatId: string, ingressId: string, state: SessionOperationState, detail?: string): void { this.#authority.transitionProvisionalOperation(chatId, ingressId, state, detail); }
}

export function copySessionMapping(mapping: SessionMapping): SessionMapping {
	return { chatId: mapping.chatId, projectId: mapping.projectId, sessionId: mapping.sessionId, ...(mapping.sessionFile === undefined ? {} : { sessionFile: mapping.sessionFile }), ...(mapping.activeLeaf === undefined ? {} : { activeLeaf: mapping.activeLeaf }), rawFrameCursor: mapping.rawFrameCursor, eventCursor: mapping.eventCursor, operationId: mapping.operationId, ...(mapping.assistantText === undefined ? {} : { assistantText: mapping.assistantText }), ...(mapping.events === undefined ? {} : { events: [...mapping.events] }), ...(normalizeModelSelection(mapping.modelSelection) === undefined ? {} : { modelSelection: normalizeModelSelection(mapping.modelSelection) }), ...(mapping.attachment === undefined ? {} : { attachment: copyAttachment(mapping.attachment) }) };
}
function provisionalKey(chatId: string, ingressId: string): string { return JSON.stringify([chatId, ingressId]); }
