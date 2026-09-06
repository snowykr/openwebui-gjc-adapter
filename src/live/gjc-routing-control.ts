import {
	createManagedLifecycleEvidence,
	lifecycleExactAuthority,
	lifecyclePreparedAuthority,
	transitionManagedLifecycleEvidence,
} from "../gjc/managed-lifecycle-evidence";
import { canTransitionManagedLifecycleState } from "../gjc/managed-lifecycle-state";
import { ManagedOperationDeadline } from "../gjc/managed-operation-deadline";
import type { ManagedSdkAttachment } from "../gjc/managed-sdk-runtime";
import { scopedSessionMappingStore } from "../gjc/scoped-session-mapping-store";
import type { routeGjcTurn, SessionMapping, SessionMappingStore } from "../gjc/session-router";
import {
	type GjcControlResult,
	GjcTurnCancelledError,
	type ManagedGenerationProof,
	type ManagedLifecycleControlOwner,
	type ManagedTurnAuthority,
} from "../gjc/turn-runner";
import type { OutboxStore } from "../state/outbox";
import type { LiveGatewayRunnerInput, LiveGatewayRunnerResult } from "./chat-completions";
import { OpenWebUIControlError } from "./chat-completions-types";
import type { ManagedSuccessorFlow } from "./gjc-managed-successor";
import { controlOperationHash, controlOperationKind, lifecycleControlRequestKey } from "./gjc-routing-publication";
import { withCanonicalModel } from "./gjc-routing-selection";
import { formatCanonicalModelId } from "./models";
import { ensureProjectionRows, projectTurnEvents } from "./workflow-gate-turns";
export interface RoutingControlDependencies {
	readonly turnRunner: Parameters<typeof routeGjcTurn>[0]["runner"];
	readonly mappings: SessionMappingStore;
	readonly outbox?: OutboxStore;
	readonly ownerUserId?: string;
	readonly turnTimeoutMs?: number;
}
export async function runRoutingControl(
	input: RoutingControlDependencies,
	turn: LiveGatewayRunnerInput,
	existing: SessionMapping,
): Promise<LiveGatewayRunnerResult & { readonly model?: string }> {
	const controlled = input.turnRunner;
	const control = turn.control;
	if (control === undefined) throw new Error("OpenWebUI control request was not supplied.");
	const principalId = principalIdForTurn(turn);
	const projectionOwnerUserId = principalId ?? input.ownerUserId ?? "openwebui-gjc-adapter";
	const mappings =
		principalId === undefined ? input.mappings : scopedSessionMappingStore(input.mappings, principalId, turn.chatId);
	const scopedInput = mappings === input.mappings ? input : { ...input, mappings };
	const hash = controlOperationHash(turn);
	if (!isManagedMapping(existing)) throw new Error("GJC controls require managed session authority.");
	if (control.operation === "branch")
		return runManagedBranch(scopedInput, turn, existing, hash, managedSuccessorFlow(controlled));
	throwIfAborted(turn.signal);
	const deadline = new ManagedOperationDeadline(input.turnTimeoutMs, "control");
	try {
		if (control.operation === "session.new" || control.operation === "session.resume")
			return await runManagedLifecycleControl(scopedInput, turn, existing, hash, deadline);
		if (controlled.runControl === undefined) throw new OpenWebUIControlError(control.operation);
		const runControl = controlled.runControl;
		if (controlled.withLifecyclePublication === undefined)
			throw new Error("GJC runner must provide lifecycle publication for controls.");
		const sessionRoot = turn.project.sessionRoot ?? `${turn.project.cwd}/.gjc/sessions`;
		const prepared = {
			id: turn.userMessageId,
			kind: controlOperationKind(control.operation),
			ingressId: turn.userMessageId,
			detail: hash,
		};
		deadline.remaining();
		mappings.beginOperation(turn.chatId, prepared);
		let dispatchFired = false;
		const current = () => {
			deadline.remaining();
			throwIfAborted(turn.signal);
			assertCurrentBranchPredecessor(mappings, turn.chatId, existing, turn.userMessageId);
		};
		let predecessor: { readonly applied: GjcControlResult; readonly mapping: SessionMapping };
		try {
			current();
			predecessor = await deadline.wait(
				controlled.withLifecyclePublication(
					{
						cwd: turn.project.cwd,
						sessionRoot,
						projectId: existing.projectId,
						chatId: existing.chatId,
						sessionId: existing.sessionId,
					},
					async lifecycle => {
						current();
						const applied = await deadline.wait(
							runControl.call(
								controlled,
								turn,
								existing,
								lifecycle,
								undefined,
								() => {
									dispatchFired = true;
								},
								undefined,
								{ timeoutMs: deadline.remaining(), beforeDispatch: current },
							),
						);
						current();
						return {
							applied,
							mapping: await deadline.wait(
								publishManagedControlMapping(
									mappings,
									lifecycle,
									turn,
									existing,
									applied,
									hash,
									mapping => ensureProjectionRows(input.outbox, mapping, projectionOwnerUserId, principalId),
									current,
								),
							),
						};
					},
				),
			);
		} catch (error) {
			try {
				if (mappings.operation(turn.chatId, turn.userMessageId)?.state !== "complete") {
					if (!dispatchFired) mappings.discardPendingOperation(turn.chatId, prepared);
					else mappings.transitionOperation(turn.chatId, turn.userMessageId, "uncertain", hash);
				}
			} catch (persistenceError) {
				throw new AggregateError([error, persistenceError], "Managed control failure could not be recorded.");
			}
			throw error;
		}
		const { applied, mapping } = predecessor;
		const result = applied.result;
		return withCanonicalModel(
			{
				content: result?.text ?? mapping.assistantText ?? "",
				...(result === undefined || result.events.length === 0
					? {}
					: {
							events: projectTurnEvents(
								result.events,
								mapping.modelSelection === undefined
									? undefined
									: formatCanonicalModelId(mapping.modelSelection),
							),
						}),
			},
			mapping.modelSelection,
		);
	} finally {
		deadline.close();
	}
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new GjcTurnCancelledError();
}

async function runManagedLifecycleControl(
	input: RoutingControlDependencies,
	turn: LiveGatewayRunnerInput,
	existing: SessionMapping,
	hash: string,
	deadline: ManagedOperationDeadline,
): Promise<LiveGatewayRunnerResult & { readonly model?: string }> {
	throwIfAborted(turn.signal);
	const control = turn.control!;
	const runner = input.turnRunner;
	if (runner.runControl === undefined || runner.withLifecyclePublication === undefined)
		throw new Error("Managed lifecycle control requires owned runner publication.");
	const predecessor = existing.managedAuthority!;
	const creating = control.operation === "session.new";
	if (!creating && (control.operation !== "session.resume" || control.sessionId !== predecessor.sessionId))
		throw new Error("Managed selected resume requires persisted exact target authority before invocation.");
	const operation = creating ? "session.create" : "session.resume";
	const source = {
		...predecessor,
		requestKey: lifecycleControlRequestKey(predecessor, operation, turn.userMessageId, hash),
	};
	const mappings = input.mappings;
	const prepared = {
		id: turn.userMessageId,
		kind: creating ? ("create" as const) : ("resume" as const),
		ingressId: turn.userMessageId,
		detail: hash,
	};
	mappings.beginOperation(turn.chatId, prepared);
	let finished = false;
	let evidence = createManagedLifecycleEvidence({
		operation,
		preparedAuthority: lifecyclePreparedAuthority(source),
		source: lifecycleExactAuthority(source),
		target: creating
			? { kind: "existing_path", path: source.canonicalWorkspace }
			: { sessionIdOrPrefix: source.sessionId, path: source.canonicalWorkspace },
		payloadHash: hash,
	});
	const record = (next: typeof evidence) => {
		mappings.recordLifecycleEvidence(turn.chatId, turn.userMessageId, hash, next);
		evidence = next;
	};
	const current = () => {
		deadline.remaining();
		if (finished) throw new Error("Managed lifecycle control ownership has ended.");
		assertCurrentBranchPredecessor(mappings, turn.chatId, existing, turn.userMessageId);
	};
	const owner: ManagedLifecycleControlOwner = {
		operation,
		source,
		preparedAuthority: lifecyclePreparedAuthority(source),
		lifecycleOperation: { operationId: turn.userMessageId, requestKey: source.requestKey, payloadHash: hash },
		onInvoking: () => {
			throwIfAborted(turn.signal);
			current();
			record(transitionManagedLifecycleEvidence(evidence, "invoking"));
		},
		onAcknowledged: authority => {
			assertManagedAuthority(authority, {
				...source,
				sessionId: creating ? authority.sessionId : source.sessionId,
				generation: creating ? authority.generation : source.generation,
			});
			if (creating && authority.sessionId === source.sessionId)
				throw new Error("Managed session.new returned the source session.");
			record(
				transitionManagedLifecycleEvidence(evidence, "acknowledged_unproven", {
					acknowledged: lifecycleExactAuthority(authority),
				}),
			);
			if (creating)
				mappings.recordAcknowledgedSuccessor(turn.chatId, turn.userMessageId, hash, {
					sessionId: authority.sessionId,
					managedAuthority: managedAuthorityCopy(authority),
				});
			current();
		},
	};
	const address = {
		cwd: turn.project.cwd,
		sessionRoot: turn.project.sessionRoot ?? `${turn.project.cwd}/.gjc/sessions`,
		projectId: existing.projectId,
		chatId: existing.chatId,
		sessionId: existing.sessionId,
	};
	try {
		record(evidence);
		current();
		const applied = await deadline.wait(
			runner.withLifecyclePublication(address, lifecycle => {
				current();
				return deadline.wait(
					runner.runControl!(turn, existing, lifecycle, undefined, undefined, owner, {
						timeoutMs: deadline.remaining(),
						beforeDispatch: current,
					}),
				);
			}),
		);
		throwIfAborted(turn.signal);
		current();
		const authority = applied.result?.managedAuthority;
		const proof = applied.result?.managedProof;
		if (
			evidence.state !== "acknowledged_unproven" ||
			evidence.acknowledged === undefined ||
			authority === undefined ||
			proof === undefined
		)
			throw new Error("Managed lifecycle control requires durable acknowledgement and returned generation proof.");
		assertManagedAuthority(authority, {
			...source,
			sessionId: evidence.acknowledged.sessionId,
			generation: evidence.acknowledged.generation,
		});
		if (applied.sessionId !== undefined && applied.sessionId !== authority.sessionId)
			throw new Error("Managed lifecycle control result identity changed.");
		assertManagedProof(proof, authority);
		record(transitionManagedLifecycleEvidence(evidence, "active_generation_proven", { proven: proof }));
		current();
		const mapping = await deadline.wait(
			runner.withLifecyclePublication({ ...address, sessionId: authority.sessionId }, async lifecycle => {
				current();
				await deadline.wait(
					runner.getState({
						...address,
						sessionId: authority.sessionId,
						lifecycle,
						managedAuthority: authority,
					}),
				);
				throwIfAborted(turn.signal);
				current();
				return deadline.wait(
					publishManagedControlMapping(
						mappings,
						lifecycle,
						turn,
						existing,
						applied,
						hash,
						mapping => ensureProjectionRows(input.outbox, mapping, source.principalId, source.principalId),
						current,
					),
				);
			}),
		);
		return withCanonicalModel(
			{
				content: applied.result!.text,
				...(applied.result!.events.length === 0
					? {}
					: { events: projectTurnEvents(applied.result!.events, undefined) }),
			},
			mapping.modelSelection,
		);
	} catch (error) {
		try {
			if (mappings.operation(turn.chatId, turn.userMessageId)?.state !== "complete") {
				if (evidence.state === "intent_prepared") mappings.discardPendingOperation(turn.chatId, prepared);
				else {
					if (canTransitionManagedLifecycleState(evidence.state, "uncertain"))
						record(transitionManagedLifecycleEvidence(evidence, "uncertain"));
					mappings.transitionOperation(turn.chatId, turn.userMessageId, "uncertain", hash);
				}
			}
		} catch (persistenceError) {
			throw new AggregateError(
				[error, persistenceError],
				"Managed lifecycle control failure could not be recorded.",
			);
		}
		throw error;
	} finally {
		finished = true;
	}
}

async function runManagedBranch(
	input: RoutingControlDependencies,
	turn: LiveGatewayRunnerInput,
	existing: SessionMapping,
	hash: string,
	flow: ManagedSuccessorFlow["fork"] | undefined,
): Promise<LiveGatewayRunnerResult & { readonly model?: string }> {
	const predecessor = existing.managedAuthority;
	if (predecessor === undefined) throw new Error("Managed branch requires persisted source authority.");
	throwIfAborted(turn.signal);
	if (flow === undefined) throw new Error("Managed branch requires the public successor flow.");
	const deadline = new ManagedOperationDeadline(input.turnTimeoutMs, "branch");
	const step = <T>(effect: () => Promise<T>): Promise<T> => {
		deadline.remaining();
		throwIfAborted(turn.signal);
		return deadline.wait(effect());
	};
	try {
		const source = {
			...predecessor,
			requestKey: lifecycleControlRequestKey(predecessor, "session.fork", turn.userMessageId, hash),
		};
		const mappings = input.mappings;
		mappings.beginOperation(turn.chatId, {
			id: turn.userMessageId,
			kind: "branch",
			ingressId: turn.userMessageId,
			detail: hash,
		});
		const { sessionId: _sessionId, generation: _generation, ...target } = source;
		let lifecycleEvidence = createManagedLifecycleEvidence({
			operation: "session.fork",
			preparedAuthority: lifecyclePreparedAuthority(target),
			source: lifecycleExactAuthority(source),
			target: { sourceSessionId: source.sessionId, cwd: source.canonicalWorkspace },
			payloadHash: hash,
		});
		const recordLifecycle = (next: typeof lifecycleEvidence) => {
			mappings.recordLifecycleEvidence(turn.chatId, turn.userMessageId, hash, next);
			lifecycleEvidence = next;
		};
		recordLifecycle(lifecycleEvidence);
		try {
			const forked = await step(() =>
				flow({
					source,
					target,
					timeoutMs: deadline.remaining(),
					signal: turn.signal,
					lifecycleOperation: {
						operationId: turn.userMessageId,
						requestKey: source.requestKey,
						payloadHash: hash,
					},
					onInvoking: () => {
						deadline.remaining();
						throwIfAborted(turn.signal);
						assertCurrentBranchPredecessor(mappings, turn.chatId, existing, turn.userMessageId);
						recordLifecycle(transitionManagedLifecycleEvidence(lifecycleEvidence, "invoking"));
					},
					onAcknowledged: authority => {
						assertManagedAuthority(authority, {
							...source,
							sessionId: authority.sessionId,
							generation: authority.generation,
						});
						if (
							authority.sessionId === source.sessionId ||
							!Number.isSafeInteger(authority.generation) ||
							authority.generation <= 0
						)
							throw new Error("Managed branch acknowledgement requires a distinct exact successor.");
						recordLifecycle(
							transitionManagedLifecycleEvidence(lifecycleEvidence, "acknowledged_unproven", {
								acknowledged: lifecycleExactAuthority(authority),
							}),
						);
						mappings.recordAcknowledgedSuccessor(turn.chatId, turn.userMessageId, hash, {
							sessionId: authority.sessionId,
							managedAuthority: managedAuthorityCopy(authority),
						});
						deadline.remaining();
						assertCurrentBranchPredecessor(mappings, turn.chatId, existing, turn.userMessageId);
					},
					publish: successor => {
						deadline.remaining();
						throwIfAborted(turn.signal);
						assertCurrentBranchPredecessor(mappings, turn.chatId, existing, turn.userMessageId);
						recordLifecycle(
							transitionManagedLifecycleEvidence(lifecycleEvidence, "active_generation_proven", {
								proven: {
									kind: "managed-generation",
									sessionId: successor.tenant.sessionId,
									generation: successor.generation,
									leaseId: source.leaseId,
									epoch: source.epoch,
								},
							}),
						);
					},
				}),
			);
			throwIfAborted(turn.signal);
			assertCurrentBranchPredecessor(mappings, turn.chatId, existing, turn.userMessageId);
			const authority = managedSuccessorAuthority(source, forked.successor);
			const acknowledged = mappings.operation(turn.chatId, turn.userMessageId)?.acknowledgedSuccessor;
			if (
				acknowledged === undefined ||
				!("managedAuthority" in acknowledged) ||
				acknowledged.managedAuthority === undefined
			)
				throw new Error("Managed branch successor acknowledgement was not persisted.");
			assertManagedAuthority(acknowledged.managedAuthority, authority);
			assertManagedAuthority(forked.managedAuthority, authority);
			const sessionRoot = turn.project.sessionRoot ?? `${turn.project.cwd}/.gjc/sessions`;
			if (input.turnRunner.withLifecyclePublication === undefined)
				throw new Error("Managed branch requires lifecycle publication.");
			const address = {
				cwd: turn.project.cwd,
				sessionRoot,
				projectId: existing.projectId,
				chatId: existing.chatId,
				sessionId: authority.sessionId,
			};
			return await step(() =>
				input.turnRunner.withLifecyclePublication!(address, async lifecycle => {
					deadline.remaining();
					throwIfAborted(turn.signal);
					assertCurrentBranchPredecessor(mappings, turn.chatId, existing, turn.userMessageId);
					const state = await step(() =>
						input.turnRunner.getState({
							...address,
							lifecycle,
							managedAuthority: authority,
						}),
					);
					const result = await step(() =>
						input.turnRunner.continueSession({
							...address,
							lifecycle,
							timeoutMs: deadline.remaining(),
							beforeDispatch: () => {
								deadline.remaining();
								throwIfAborted(turn.signal);
								assertCurrentBranchPredecessor(mappings, turn.chatId, existing, turn.userMessageId);
							},
							userMessageId: turn.userMessageId,
							parentId: turn.userMessageParentId ?? undefined,
							text: turn.prompt,
							activeLeaf: state.activeLeaf,
							rawFrameCursor: state.rawFrameCursor,
							eventCursor: state.eventCursor,
							operationId: turn.userMessageId,
							managedAuthority: authority,
							...(turn.signal === undefined ? {} : { signal: turn.signal }),
							...(turn.ownerUserId === undefined ? {} : { principalId: turn.ownerUserId }),
						}),
					);
					throwIfAborted(turn.signal);
					assertCurrentBranchPredecessor(mappings, turn.chatId, existing, turn.userMessageId);
					if (result.managedAuthority === undefined || result.managedProof === undefined)
						throw new Error("Managed branch successor did not return full generation authority.");
					assertManagedAuthority(result.managedAuthority, authority);
					const publishedAuthority = managedAuthorityCopy(authority);
					assertManagedProof(result.managedProof, publishedAuthority);
					if (publishedAuthority.sessionId !== authority.sessionId)
						throw new Error("Managed branch successor authority changed after fork proof.");
					if (lifecycle.publishManaged === undefined)
						throw new Error("Managed branch requires generation publication.");
					const mapping = await step(() =>
						lifecycle.publishManaged(result.managedProof!, () => {
							deadline.remaining();
							throwIfAborted(turn.signal);
							assertCurrentBranchPredecessor(mappings, turn.chatId, existing, turn.userMessageId);
							const published = mappings.completeOperationWithMapping(
								turn.chatId,
								turn.userMessageId,
								hash,
								{
									principalId: publishedAuthority.principalId,
									chatId: existing.chatId,
									projectId: existing.projectId,
									sessionId: publishedAuthority.sessionId,
									rawFrameCursor: result.rawFrameCursor,
									eventCursor: result.eventCursor,
									operationId: turn.userMessageId,
									assistantText: result.text,
									events: result.events,
									managedAuthority: publishedAuthority,
									modelSelection: result.modelSelection ?? existing.modelSelection,
								},
								"control",
							);
							ensureProjectionRows(
								input.outbox,
								published,
								publishedAuthority.principalId,
								publishedAuthority.principalId,
							);
							return published;
						}),
					);
					const events = projectTurnEvents(result.events, undefined);
					return withCanonicalModel(
						{
							content: result.text,
							...(events.length === 0 ? {} : { events }),
						},
						mapping.modelSelection,
					);
				}),
			);
		} catch (error) {
			try {
				if (canTransitionManagedLifecycleState(lifecycleEvidence.state, "uncertain"))
					recordLifecycle(transitionManagedLifecycleEvidence(lifecycleEvidence, "uncertain"));
				mappings.transitionOperation(turn.chatId, turn.userMessageId, "uncertain", hash);
			} catch (persistenceError) {
				throw new AggregateError([error, persistenceError], "Managed branch failure could not be recorded.");
			}
			throw error;
		}
	} finally {
		deadline.close();
	}
}

function managedSuccessorFlow(
	runner: RoutingControlDependencies["turnRunner"],
): ManagedSuccessorFlow["fork"] | undefined {
	const candidate = Reflect.get(runner as object, "forkManagedSuccessor");
	return typeof candidate === "function" ? (candidate as ManagedSuccessorFlow["fork"]) : undefined;
}

function managedSuccessorAuthority(
	source: ManagedTurnAuthority,
	successor: ManagedSdkAttachment,
): ManagedTurnAuthority {
	const tenant = successor.tenant;
	if (
		tenant.principalId !== source.principalId ||
		tenant.projectId !== source.projectId ||
		tenant.canonicalWorkspace !== source.canonicalWorkspace ||
		tenant.chatId !== source.chatId ||
		tenant.leaseId !== source.leaseId ||
		tenant.epoch !== source.epoch ||
		successor.generation !== tenant.generation
	)
		throw new Error("Managed branch successor crossed the source tenant authority boundary.");
	return {
		...source,
		sessionId: tenant.sessionId,
		generation: tenant.generation,
	};
}

function assertManagedProof(proof: ManagedGenerationProof, authority: ManagedTurnAuthority): void {
	if (
		proof.kind !== "managed-generation" ||
		proof.sessionId !== authority.sessionId ||
		proof.generation !== authority.generation ||
		proof.leaseId !== authority.leaseId ||
		proof.epoch !== authority.epoch
	)
		throw new Error("Managed branch successor generation proof changed.");
}

function assertManagedAuthority(actual: ManagedTurnAuthority, expected: ManagedTurnAuthority): void {
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
	] as const) {
		if (actual[field] !== expected[field])
			throw new Error("Managed branch successor authority changed after fork proof.");
	}
	if (
		(actual as ManagedTurnAuthority & { readonly authorityEpoch?: unknown }).authorityEpoch !==
		(expected as ManagedTurnAuthority & { readonly authorityEpoch?: unknown }).authorityEpoch
	)
		throw new Error("Managed branch successor authority epoch changed after fork proof.");
}

function managedAuthorityCopy(authority: ManagedTurnAuthority): ManagedTurnAuthority {
	const value = authority as ManagedTurnAuthority & { readonly authorityEpoch?: unknown };
	return {
		principalId: authority.principalId,
		projectId: authority.projectId,
		canonicalWorkspace: authority.canonicalWorkspace,
		chatId: authority.chatId,
		sessionId: authority.sessionId,
		generation: authority.generation,
		leaseId: authority.leaseId,
		epoch: authority.epoch,
		requestKey: authority.requestKey,
		...(typeof value.authorityEpoch === "string" ? { authorityEpoch: value.authorityEpoch } : {}),
	} as ManagedTurnAuthority;
}

async function publishManagedControlMapping(
	mappings: SessionMappingStore,
	lifecycle: import("../gjc/turn-runner").GjcLifecycleTransaction,
	turn: LiveGatewayRunnerInput,
	existing: SessionMapping,
	applied: GjcControlResult,
	hash: string,
	afterPublish: (mapping: SessionMapping) => void,
	beforePublish: () => void,
): Promise<SessionMapping> {
	const result = applied.result;
	const authority = result?.managedAuthority ?? existing.managedAuthority;
	const proof = result?.managedProof;
	if (authority === undefined || proof === undefined || lifecycle.publishManaged === undefined)
		throw new Error("GJC managed control did not return a generation proof.");
	if (existing.managedAuthority !== undefined) {
		if (turn.control?.operation === "session.new") {
			assertManagedAuthority(authority, {
				...existing.managedAuthority,
				sessionId: authority.sessionId,
				generation: authority.generation,
				requestKey: lifecycleControlRequestKey(
					existing.managedAuthority,
					"session.create",
					turn.userMessageId,
					hash,
				),
			});
			if (authority.sessionId === existing.sessionId)
				throw new Error("Managed session.new must assign a different session identity.");
		} else if (turn.control?.operation === "session.resume") {
			assertManagedAuthority(authority, {
				...existing.managedAuthority,
				requestKey: lifecycleControlRequestKey(
					existing.managedAuthority,
					"session.resume",
					turn.userMessageId,
					hash,
				),
			});
		} else assertManagedAuthority(authority, existing.managedAuthority);
	}
	const publishedAuthority = managedAuthorityCopy(authority);
	assertManagedProof(proof, publishedAuthority);
	beforePublish();
	return lifecycle.publishManaged(proof, () => {
		beforePublish();
		const published = mappings.completeOperationWithMapping(
			turn.chatId,
			turn.userMessageId,
			hash,
			{
				principalId: publishedAuthority.principalId,
				chatId: existing.chatId,
				projectId: existing.projectId,
				sessionId: publishedAuthority.sessionId,
				rawFrameCursor: result?.rawFrameCursor ?? existing.rawFrameCursor,
				eventCursor: result?.eventCursor ?? existing.eventCursor,
				operationId: turn.userMessageId,
				assistantText: result?.text ?? existing.assistantText ?? "",
				events: result?.events ?? existing.events,
				managedAuthority: publishedAuthority,
				...(existing.modelSelection === undefined ? {} : { modelSelection: existing.modelSelection }),
			},
			"control",
		);
		afterPublish(published);
		return published;
	});
}

function principalIdForTurn(turn: LiveGatewayRunnerInput): string | undefined {
	const ownerUserId = turn.ownerUserId;
	return typeof ownerUserId === "string" && ownerUserId.trim().length > 0 ? ownerUserId : undefined;
}

function isManagedMapping(mapping: SessionMapping): boolean {
	return (
		mapping.managedAuthority !== undefined && mapping.sessionFile === undefined && mapping.attachment === undefined
	);
}
function assertCurrentBranchPredecessor(
	mappings: SessionMappingStore,
	chatId: string,
	predecessor: SessionMapping,
	operationId: string,
): void {
	const current = mappings.get(chatId);
	const operation = mappings.operation(chatId, operationId);
	if (
		current === undefined ||
		current.projectId !== predecessor.projectId ||
		current.chatId !== predecessor.chatId ||
		current.sessionId !== predecessor.sessionId ||
		current.sessionFile !== predecessor.sessionFile ||
		operation?.state !== "pending"
	)
		throw new OpenWebUIControlError("branch_predecessor_replaced");
	if (current.managedAuthority === undefined || predecessor.managedAuthority === undefined)
		throw new OpenWebUIControlError("branch_predecessor_replaced");
	assertManagedAuthority(current.managedAuthority, predecessor.managedAuthority);
}
