import { classifySessionFrame } from "../gjc/session-frames";
import { normalizeModelSelection, type SessionMapping, type SessionMappingStore } from "../gjc/session-router";
import type { GjcTurnEvent } from "../gjc/turn-runner";
import type { OpenWebUIMessageEvent } from "../openwebui/events";
import { type ProjectableAgentFrame, projectAgentFrame } from "../projection/events";
import {
	type PendingWorkflowGate,
	pendingWorkflowGateFromEvent,
	projectPendingWorkflowGateMessage,
} from "../projection/workflow-gates";
import {
	type EnqueueProjectionOperationInput,
	hashCanonicalStream,
	type OutboxStore,
	ProjectionObsoleteError,
	type ProjectionOperation,
	streamCanonicalJson,
	streamEscapedJsonString,
	streamPlainJson,
} from "../state/outbox";
import type { ProjectionOperationApplier } from "../state/reconciler";
import { formatCanonicalModelId } from "./models";
import { sessionEventToProjectableFrame } from "./session-event-frames";

export function projectTurnEvents(
	events: readonly GjcTurnEvent[],
	canonicalModel?: string,
): readonly OpenWebUIMessageEvent[] {
	if (canonicalModel === undefined) return [];
	const projected: OpenWebUIMessageEvent[] = [];
	for (const [index, event] of events.entries()) {
		const frame = turnEventToProjectableFrame(event);
		if (frame === null) continue;
		const frameEvents = projectAgentFrame(frame, {
			id: `gjc-event-${index}`,
			created: 0,
			model: canonicalModel,
		}).events;
		projected.push(...frameEvents);
	}
	return projected;
}

export function buildSessionMappingPayloadHash(mapping: SessionMapping): string {
	// Stream the canonical serialization instead of materializing the mapped
	// event array (and its JSON.stringify(event.payload) strings) first: an
	// oversized record-level event array must not allocate event-sized or
	// document-sized strings on top of the parsed authority. The emitted bytes
	// are identical to buildProjectionPayloadHash of the previous object shape.
	return hashCanonicalStream(emit => {
		emit('{"activeLeaf":');
		emit(mapping.activeLeaf === undefined ? "null" : JSON.stringify(mapping.activeLeaf));
		emit(',"assistantText":');
		if (mapping.assistantText === undefined) emit("null");
		else {
			// A large persisted response must not materialize an assistant-sized
			// string on each hashing pass: emit the quoted and escaped value
			// incrementally, byte-identical to JSON.stringify(mapping.assistantText).
			emit('"');
			streamEscapedJsonString(mapping.assistantText, emit);
			emit('"');
		}
		emit(',"chatId":');
		emit(JSON.stringify(mapping.chatId));
		emit(',"eventCursor":');
		emit(String(mapping.eventCursor));
		emit(',"events":[');
		const events = mapping.events ?? [];
		for (let index = 0; index < events.length; index += 1) {
			if (index > 0) emit(",");
			const event = events[index]!;
			emit('{"id":');
			emit(event.id === undefined ? "null" : JSON.stringify(event.id));
			emit(',"payloadJson":');
			if (event.payload === undefined) emit("null");
			else {
				emit('"');
				// The payloadJson value is JSON.stringify(event.payload): emit that
				// serialization chunk by chunk and escape it in flight, so the whole
				// payload never exists as one eager string either.
				streamPlainJson(event.payload, chunk => streamEscapedJsonString(chunk, emit));
				emit('"');
			}
			emit(',"text":');
			emit(event.text === undefined ? "null" : JSON.stringify(event.text));
			emit(',"type":');
			emit(JSON.stringify(event.type));
			emit("}");
		}
		emit('],"modelSelection":');
		const modelSelection = normalizeModelSelection(mapping.modelSelection) ?? null;
		if (modelSelection === null) emit("null");
		else streamCanonicalJson(modelSelection, emit);
		emit(',"operationId":');
		emit(JSON.stringify(mapping.operationId));
		emit(',"projectId":');
		emit(JSON.stringify(mapping.projectId));
		emit(',"rawFrameCursor":');
		emit(String(mapping.rawFrameCursor));
		emit(',"sessionFile":');
		emit(mapping.sessionFile === undefined ? "null" : JSON.stringify(mapping.sessionFile));
		emit(',"sessionId":');
		emit(JSON.stringify(mapping.sessionId));
		emit("}");
	});
}

export function buildEventPayloadHash(events: readonly OpenWebUIMessageEvent[]): string {
	// The previous shape was { eventsJson: JSON.stringify(events) }: emit that
	// string value without ever materializing the whole events JSON — the array
	// serialization is streamed and escaped in flight, then wrapped in the
	// eventsJson key so stored hashes stay byte-identical.
	return hashCanonicalStream(emit => {
		emit('{"eventsJson":"');
		streamPlainJson(events, chunk => streamEscapedJsonString(chunk, emit));
		emit('"}');
	});
}

export function expectedProjectionRows(
	mapping: SessionMapping,
	ownerUserId: string,
	principalId: string | null | undefined = mapping.principalId,
): readonly EnqueueProjectionOperationInput[] {
	const events = projectedMappingEvents(mapping);
	const scopedPrincipalId = normalizePrincipalId(principalId === null ? undefined : principalId);
	return [
		{
			operationId: mapping.operationId,
			ownerUserId,
			...(scopedPrincipalId === undefined ? {} : { principalId: scopedPrincipalId }),
			projectId: mapping.projectId,
			chatId: mapping.chatId,
			kind: "session_mapping",
			payloadHash: buildSessionMappingPayloadHash(mapping),
		},
		{
			operationId: `${mapping.operationId}:event`,
			ownerUserId,
			...(scopedPrincipalId === undefined ? {} : { principalId: scopedPrincipalId }),
			projectId: mapping.projectId,
			chatId: mapping.chatId,
			kind: "event",
			payloadHash: buildEventPayloadHash(events),
		},
	];
}

export function ensureProjectionRows(
	outbox: OutboxStore | undefined,
	mapping: SessionMapping,
	ownerUserId: string,
	principalId: string | null | undefined = mapping.principalId,
): void {
	for (const row of expectedProjectionRows(mapping, ownerUserId, principalId)) outbox?.enqueue(row);
}
export function synthesizeProjectionRows(
	outbox: OutboxStore,
	mappings: SessionMappingStore,
	ownerUserId: string,
	adminPrincipalId?: string,
): void {
	const configuredAdmin = normalizePrincipalId(adminPrincipalId);
	for (const mapping of mappings.mappingRecords()) {
		const principalId = normalizePrincipalId(mapping.principalId);
		if (principalId === undefined && configuredAdmin === undefined) continue;
		// Reference-based operation state check: operation()/operationScoped()
		// deep-copy the record (recursively cloning large event payloads) and
		// then copy the result again, which for an oversized legacy record can
		// recreate the document-sized allocation this boot path avoids.
		const operation =
			principalId === undefined
				? (() => {
						const scoped =
							configuredAdmin === undefined
								? undefined
								: mappings.operationStateReferenceScoped(
										{ principalId: configuredAdmin, chatId: mapping.chatId },
										mapping.operationId,
									);
						return scoped ?? mappings.operationStateReference(mapping.chatId, mapping.operationId);
					})()
				: mappings.operationStateReferenceScoped({ principalId, chatId: mapping.chatId }, mapping.operationId);
		if (operation?.state !== "complete" || operation.resultOperationId !== mapping.operationId) continue;
		// Always enqueue: the outbox's assertSameEnqueueIdentity compares the
		// existing row's immutable owner/project/kind/payloadHash against the
		// freshly computed one, so a row left stale by a checkpoint mismatch
		// (authority and outbox restored from different points) is rejected
		// instead of silently accepted. The payload hash is computed with the
		// streaming canonical serializer (peak bounded by a single event), so
		// this does not recreate the oversized allocation the no-copy iterator
		// avoids.
		for (const row of expectedProjectionRows(mapping, principalId ?? ownerUserId, principalId)) outbox.enqueue(row);
	}
}

export interface PrincipalProjectionSynchronizerInput {
	readonly principalId: string;
	readonly ownerUserId: string;
	readonly mapping: SessionMapping;
	readonly operation: ProjectionOperation;
}

export interface ProjectionSessionSynchronizer {
	syncLinkedProject(projectId: string): Promise<unknown>;
	readonly syncPrincipalProjection?: (input: PrincipalProjectionSynchronizerInput) => Promise<unknown>;
}

export function createProjectionOperationApplier(
	mappings: SessionMappingStore,
	synchronizer: ProjectionSessionSynchronizer,
	adminPrincipalId?: string,
): ProjectionOperationApplier {
	return async (operation: ProjectionOperation) => {
		const mapping = projectionMapping(mappings, operation, normalizePrincipalId(adminPrincipalId));
		const principalId = normalizePrincipalId(operation.principalId);
		const expected = expectedProjectionRows(
			mapping,
			operation.ownerUserId,
			operation.principalId === undefined ? null : operation.principalId,
		).find(row => row.kind === operation.kind);
		if (
			expected === undefined ||
			expected.operationId !== operation.operationId ||
			expected.projectId !== operation.projectId ||
			expected.chatId !== operation.chatId ||
			expected.payloadHash !== operation.payloadHash
		) {
			throw new Error(`Projection operation ${operation.operationId} does not match a durable session mapping`);
		}
		if (
			principalId === normalizePrincipalId(adminPrincipalId) &&
			normalizePrincipalId(operation.ownerUserId) !== principalId
		)
			throw new Error(`Projection operation ${operation.operationId} has an invalid principal owner binding`);
		if (principalId === undefined || principalId === normalizePrincipalId(adminPrincipalId)) {
			try {
				await synchronizer.syncLinkedProject(mapping.projectId);
			} catch (error) {
				// A project that was unlinked after the row was enqueued has no
				// projection target; settle the row instead of retrying forever.
				if (error instanceof Error && error.message.includes("Linked project is unavailable")) {
					throw new ProjectionObsoleteError(
						`Projection operation ${operation.operationId} is for an unlinked project`,
					);
				}
				throw error;
			}
			return;
		}
		if (normalizePrincipalId(operation.ownerUserId) !== principalId)
			throw new Error(`Projection operation ${operation.operationId} has an invalid principal owner binding`);
		const syncPrincipalProjection = synchronizer.syncPrincipalProjection;
		if (syncPrincipalProjection === undefined)
			throw new Error(`Projection operation ${operation.operationId} has no principal projection capability`);
		await syncPrincipalProjection({
			principalId,
			ownerUserId: operation.ownerUserId,
			mapping,
			operation,
		});
	};
}

function projectionMapping(
	mappings: SessionMappingStore,
	operation: ProjectionOperation,
	adminPrincipalId: string | undefined,
): SessionMapping {
	const operationId =
		operation.kind === "event" ? operation.operationId.slice(0, -":event".length) : operation.operationId;
	const principalId = normalizePrincipalId(operation.principalId);
	const ownerIsConfiguredAdmin =
		adminPrincipalId !== undefined && normalizePrincipalId(operation.ownerUserId) === adminPrincipalId;
	if (principalId === undefined && !ownerIsConfiguredAdmin)
		throw new ProjectionObsoleteError(
			`Projection operation ${operation.operationId} has no configured-admin legacy scope`,
		);
	if (operation.principalId !== undefined && principalId === undefined)
		throw new ProjectionObsoleteError(`Projection operation ${operation.operationId} has an invalid principal scope`);
	let recorded: ReturnType<SessionMappingStore["operation"]>;
	if (principalId === undefined) {
		recorded =
			adminPrincipalId === undefined
				? undefined
				: mappings.operationScoped({ principalId: adminPrincipalId, chatId: operation.chatId }, operationId);
		if (recorded === undefined) recorded = mappings.operation(operation.chatId, operationId);
	} else {
		recorded = mappings.operationScoped({ principalId, chatId: operation.chatId }, operationId);
		if (recorded === undefined && principalId === adminPrincipalId && ownerIsConfiguredAdmin)
			recorded = mappings.operation(operation.chatId, operationId);
	}
	const currentMapping =
		principalId === undefined
			? (() => {
					const scoped =
						adminPrincipalId === undefined
							? undefined
							: mappings.getScoped({ principalId: adminPrincipalId, chatId: operation.chatId });
					return scoped ?? mappings.get(operation.chatId);
				})()
			: (() => {
					const scoped = mappings.getScoped({ principalId, chatId: operation.chatId });
					return (
						scoped ??
						(principalId === adminPrincipalId && ownerIsConfiguredAdmin
							? mappings.get(operation.chatId)
							: undefined)
					);
				})();
	if (recorded !== undefined) {
		if (
			recorded.state !== "complete" ||
			recorded.result === undefined ||
			recorded.result.mapping.operationId !== operationId
		)
			throw new Error(`Projection operation ${operation.operationId} has no completed durable result`);
		// Only the CURRENT operation's events are retained on the record; a
		// complete-but-superseded operation can no longer be reconstructed, so
		// settle its rows as obsolete (the transcript-driven project sync covers
		// final chat state).
		if (currentMapping === undefined || currentMapping.operationId !== operationId)
			throw new ProjectionObsoleteError(
				`Projection operation ${operation.operationId} is superseded and no longer retained in the session authority`,
			);
		const mapping = {
			...currentMapping,
			assistantText: recorded.result.assistantText,
		};
		assertProjectionMappingPrincipalBinding(mapping, principalId, adminPrincipalId, operation.operationId);
		return mapping;
	}
	const mapping = currentMapping;
	if (mapping === undefined || mapping.operationId !== operationId)
		throw new ProjectionObsoleteError(`Projection operation ${operation.operationId} has no durable session mapping`);
	if (principalId !== undefined && mapping.principalId !== undefined && mapping.principalId !== principalId)
		throw new ProjectionObsoleteError(
			`Projection operation ${operation.operationId} has an invalid principal binding`,
		);
	assertProjectionMappingPrincipalBinding(mapping, principalId, adminPrincipalId, operation.operationId);
	return mapping;
}

function assertProjectionMappingPrincipalBinding(
	mapping: SessionMapping,
	principalId: string | undefined,
	adminPrincipalId: string | undefined,
	operationId: string,
): void {
	const mappingPrincipalId = normalizePrincipalId(mapping.principalId);
	if (principalId !== undefined) {
		if (mappingPrincipalId !== principalId)
			throw new Error(`Projection operation ${operationId} has an invalid principal binding`);
		return;
	}
	if (mappingPrincipalId !== undefined && mappingPrincipalId !== adminPrincipalId)
		throw new Error(`Projection operation ${operationId} has an invalid legacy principal binding`);
}
function normalizePrincipalId(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized.length === 0 ? undefined : normalized;
}

function projectedMappingEvents(mapping: SessionMapping): readonly OpenWebUIMessageEvent[] {
	const selection = normalizeModelSelection(mapping.modelSelection);
	return projectTurnEvents(
		mapping.events ?? [],
		selection === undefined ? undefined : formatCanonicalModelId(selection),
	);
}

function turnEventToProjectableFrame(event: GjcTurnEvent): ProjectableAgentFrame | null {
	const classified = classifySessionFrame({ type: event.type, id: event.id, text: event.text });
	const sessionFrame = sessionEventToProjectableFrame(event);
	if (sessionFrame !== undefined) return sessionFrame;
	if (event.type === "message_update" || event.type === "assistant_text" || event.type === "assistant") return null;
	if (classified.kind === "workflow_gate" || event.type === "workflow_gate") {
		const pendingGate = pendingGateFromEvent(event);
		return {
			kind: "skill_progress",
			label: boundedText(projectPendingWorkflowGateMessage(pendingGate)),
			phase: "start",
			hidden: false,
			metadata: {
				eventType: boundedText(event.type),
				gateId: boundedNullableText(
					classified.kind === "workflow_gate" ? (classified.gateId ?? event.id ?? null) : (event.id ?? null),
				),
				workflow_gate: workflowGateStatusMetadata(pendingGate),
			},
		};
	}
	if (event.type.includes("mcp")) return progressFrame("mcp_progress", event);
	if (event.type.includes("skill") || event.type.includes("workflow")) return progressFrame("skill_progress", event);
	if (event.type.includes("tool")) return progressFrame("tool_progress", event);
	if (event.type.includes("agent")) return progressFrame("subagent_progress", event);
	if (event.type === "message_start") {
		return {
			kind: "unsupported",
			eventType: boundedText(event.type),
			id: boundedNullableText(event.id ?? null),
			textPresent: event.text !== undefined,
		};
	}
	return {
		kind: "unsupported",
	};
}

function progressFrame(
	kind: "tool_progress" | "mcp_progress" | "skill_progress" | "subagent_progress",
	event: GjcTurnEvent,
): ProjectableAgentFrame {
	return {
		kind,
		label: boundedText(event.type),
		phase: event.type.includes("end") || event.type.includes("complete") ? "end" : "progress",
		metadata: { eventType: boundedText(event.type), id: boundedNullableText(event.id ?? null) },
	};
}

function pendingGateFromEvent(event: GjcTurnEvent): PendingWorkflowGate {
	return (
		pendingWorkflowGateFromEvent(event) ?? {
			gateId: event.id ?? "unknown-gate",
			schemaHash: "unknown",
			idempotencyKey: event.id ?? "unknown-gate",
			boundUserMessageId: null,
			status: "pending",
			schema: { type: "string" },
		}
	);
}

function workflowGateStatusMetadata(gate: PendingWorkflowGate): Record<string, unknown> {
	return {
		gateId: gate.gateId,
		...(gate.stage === undefined ? {} : { stage: gate.stage }),
		...(gate.kind === undefined ? {} : { kind: gate.kind }),
		schemaHash: gate.schemaHash,
		...(gate.createdAt === undefined ? {} : { createdAt: gate.createdAt }),
		...(gate.required === undefined ? {} : { required: gate.required }),
		optionCount: gate.options?.length ?? 0,
	};
}

function boundedNullableText(value: string | null): string | null {
	return value === null ? null : boundedText(value);
}

function boundedText(value: string, maxLength = 80): string {
	return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}
