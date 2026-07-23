import {
	type ProvisionalSessionOperation,
	SessionAuthority,
	type SessionOperation,
	type SessionOperationResult,
	type SessionOperationState,
} from "./session-authority";
import type { AcknowledgedSuccessor } from "./session-authority-types";
import { copySessionMapping } from "./session-mapping-copy";
import type { SessionMapping } from "./session-mapping-store";
import { operationResult } from "./session-operation-codec";

export class SessionMappingStore {
	constructor(private readonly authority: SessionAuthority = new SessionAuthority()) {}

	get(chatId: string): SessionMapping | undefined {
		const record = this.authority.get(chatId);
		return record === undefined ? undefined : mappingFromRecord(record);
	}
	set(mapping: SessionMapping): SessionMapping {
		return mappingFromRecord(this.authority.set(copySessionMapping(mapping)));
	}
	upsert(mapping: SessionMapping): SessionMapping {
		return mappingFromRecord(this.authority.upsert(copySessionMapping(mapping)));
	}
	reassignProjectAuthority(chatId: string, currentProjectId: string, nextProjectId: string): void {
		this.authority.reassignProject(chatId, currentProjectId, nextProjectId);
	}
	entries(): readonly SessionMapping[] {
		return this.authority.entries().map(mappingFromRecord);
	}
	operation(chatId: string, operationId: string): SessionOperation | undefined {
		return this.authority
			.get(chatId)
			?.journal.find(operation => operation.id === operationId || operation.ingressId === operationId);
	}
	beginOperation(chatId: string, operation: Omit<SessionOperation, "state" | "startedAt" | "completedAt">): void {
		this.authority.beginOperation(chatId, operation);
	}
	recordAcknowledgedSuccessor(
		chatId: string,
		operationId: string,
		operationHash: string,
		successor: AcknowledgedSuccessor,
	): SessionOperation {
		return this.authority.recordAcknowledgedSuccessor(chatId, operationId, operationHash, successor);
	}
	transitionOperation(
		chatId: string,
		operationId: string,
		state: SessionOperationState,
		detail?: string,
		result?: SessionOperationResult,
	): void {
		this.authority.transitionOperation(chatId, operationId, state, detail, result);
	}
	completeOperationWithMapping(
		chatId: string,
		operationId: string,
		detail: string,
		mapping: SessionMapping,
		kind: "turn" | "control" | "close",
	): SessionMapping {
		return mappingFromRecord(
			this.authority.completeOperationWithMapping(
				chatId,
				operationId,
				detail,
				copySessionMapping(mapping),
				operationResult(kind, { ...mapping, operationId }),
			),
		);
	}
	provisionalOperation(chatId: string, ingressId: string): ProvisionalSessionOperation | undefined {
		return this.authority.provisionalOperation(chatId, ingressId);
	}
	reserveProvisionalOperation(
		operation: Omit<ProvisionalSessionOperation, "state" | "startedAt" | "completedAt">,
	): ProvisionalSessionOperation {
		return this.authority.reserveProvisionalOperation(operation);
	}
	publishProvisionalOperation(
		operation: Omit<ProvisionalSessionOperation, "state" | "startedAt" | "completedAt">,
		mapping: SessionMapping,
	): SessionMapping {
		return mappingFromRecord(this.authority.publishProvisionalOperation(operation, copySessionMapping(mapping)));
	}
	attachProvisionalOperation(
		chatId: string,
		ingressId: string,
		attachment: Pick<ProvisionalSessionOperation, "sessionId" | "sessionFile" | "attachment">,
	): void {
		this.authority.attachProvisionalOperation(chatId, ingressId, attachment);
	}
	transitionProvisionalOperation(
		chatId: string,
		ingressId: string,
		state: SessionOperationState,
		detail?: string,
	): void {
		this.authority.transitionProvisionalOperation(chatId, ingressId, state, detail);
	}
}

function mappingFromRecord({
	version: _version,
	createdAt: _createdAt,
	header: _header,
	observations: _observations,
	journal: _journal,
	...mapping
}: import("./session-authority").SessionAuthorityRecord): SessionMapping {
	return copySessionMapping(mapping);
}
