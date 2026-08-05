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
	buildProjectionPayloadHash,
	type EnqueueProjectionOperationInput,
	type OutboxStore,
	ProjectionObsoleteError,
	type ProjectionOperation,
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
	return buildProjectionPayloadHash({
		chatId: mapping.chatId,
		projectId: mapping.projectId,
		sessionId: mapping.sessionId,
		sessionFile: mapping.sessionFile ?? null,
		activeLeaf: mapping.activeLeaf ?? null,
		rawFrameCursor: mapping.rawFrameCursor,
		eventCursor: mapping.eventCursor,
		operationId: mapping.operationId,
		assistantText: mapping.assistantText ?? null,
		modelSelection: normalizeModelSelection(mapping.modelSelection) ?? null,
		events: (mapping.events ?? []).map(event => ({
			type: event.type,
			text: event.text ?? null,
			id: event.id ?? null,
			payloadJson: event.payload === undefined ? null : JSON.stringify(event.payload),
		})),
	});
}

export function buildEventPayloadHash(events: readonly OpenWebUIMessageEvent[]): string {
	return buildProjectionPayloadHash({ eventsJson: JSON.stringify(events) });
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
	for (const mapping of mappings.entries()) {
		const principalId = normalizePrincipalId(mapping.principalId);
		if (principalId === undefined && configuredAdmin === undefined) continue;
		const operation =
			principalId === undefined
				? (() => {
						const scoped =
							configuredAdmin === undefined
								? undefined
								: mappings.operationScoped(
										{ principalId: configuredAdmin, chatId: mapping.chatId },
										mapping.operationId,
									);
						return scoped ?? mappings.operation(mapping.chatId, mapping.operationId);
					})()
				: mappings.operationScoped({ principalId, chatId: mapping.chatId }, mapping.operationId);
		if (operation?.state !== "complete" || operation.result?.mapping.operationId !== mapping.operationId) continue;
		ensureProjectionRows(
			outbox,
			{
				...operation.result.mapping,
				assistantText: operation.result.assistantText,
				events: operation.result.events,
			},
			principalId ?? ownerUserId,
			principalId,
		);
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
	if (recorded !== undefined) {
		if (
			recorded.state !== "complete" ||
			recorded.result === undefined ||
			recorded.result.mapping.operationId !== operationId
		)
			throw new Error(`Projection operation ${operation.operationId} has no completed durable result`);
		const mapping = {
			...recorded.result.mapping,
			assistantText: recorded.result.assistantText,
			events: recorded.result.events,
		};
		assertProjectionMappingPrincipalBinding(mapping, principalId, adminPrincipalId, operation.operationId);
		return mapping;
	}
	const mapping =
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
