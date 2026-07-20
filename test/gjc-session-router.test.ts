import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedModelSelection } from "../src/contracts";
import {
	FileBackedSessionMappingStore,
	closeIngressId,
	type RouteGjcTurnInput,
	routeGjcSessionClose,
	routeGjcTurn,
	SessionFileBoundaryError,
	type SessionMapping,
	SessionMappingStore,
} from "../src/gjc/session-router";
import { GjcCloseReceipt } from "../src/gjc/turn-runner";
import type {
	GjcContinueSessionInput,
	GjcLifecyclePublicationAddress,
	GjcLifecycleTransaction,
	GjcSessionAddress,
	GjcSessionState,
	GjcSessionStateInput,
	GjcStartNewSessionInput,
	GjcSwitchSessionInput,
	GjcTurnResult,
	GjcTurnRunner,
} from "../src/gjc/turn-runner";
import type { RegisteredProject } from "../src/projects/registry";
import { attachmentProof, lifecycleFixture } from "./gjc-lifecycle-fixtures";

class FakeGjcTurnRunner implements GjcTurnRunner {
	readonly starts: GjcStartNewSessionInput[] = [];
	readonly continues: GjcContinueSessionInput[] = [];
	readonly switches: GjcSwitchSessionInput[] = [];
	readonly states: GjcSessionStateInput[] = [];

	state: GjcSessionState = {
		sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
		activeLeaf: "leaf-1",
		rawFrameCursor: 7,
		eventCursor: 3,
	};
	returnedSelection: NormalizedModelSelection | undefined;
	failPrompt = false;

	async startNewSession<T>(
		input: GjcStartNewSessionInput,
		publish: (result: GjcSessionAddress & GjcTurnResult, lifecycle: GjcLifecycleTransaction) => Promise<T>,
		beforePrompt: (
			address: GjcSessionAddress & { readonly sessionFile: string },
			attachment: ReturnType<typeof attachmentProof>,
			lifecycle: GjcLifecycleTransaction,
		) => Promise<void>,
		onFailure?: (lifecycle: GjcLifecycleTransaction, error: unknown) => Promise<void>,
	): Promise<T> {
		this.starts.push(input);
		const address = {
			cwd: input.cwd,
			sessionRoot: input.sessionRoot,
			projectId: input.projectId,
			chatId: input.chatId,
			sessionId: "session-1",
		};
		const lifecycle = lifecycleFixture(address);
		if (this.failPrompt) {
			await beforePrompt(
				{ ...address, sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl" },
				attachmentProof(address),
				lifecycle,
			);
			const error = new Error("prompt failed");
			await onFailure?.(lifecycle, error);
			throw error;
		}
		return publish(
			{
				...address,
				text: `new:${input.text}`,
				events: [{ type: "assistant", text: `new:${input.text}` }],
				sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
				activeLeaf: "leaf-1",
				rawFrameCursor: 7,
				eventCursor: 3,
				attachment: attachmentProof(address),
				...(this.returnedSelection === undefined ? {} : { modelSelection: this.returnedSelection }),
			},
			lifecycle,
		);
	}

	async continueSession(input: GjcContinueSessionInput): Promise<GjcTurnResult> {
		this.continues.push(input);
		if (this.failPrompt) throw new Error("prompt failed");
		return {
			text: `continued:${input.text}`,
			events: [{ type: "assistant", text: `continued:${input.text}` }],
			sessionFile: input.sessionFile,
			activeLeaf: "leaf-2",
			rawFrameCursor: input.rawFrameCursor + 5,
			eventCursor: input.eventCursor + 2,
			attachment: attachmentProof(input.lifecycle.address),
			...(this.returnedSelection === undefined ? {} : { modelSelection: this.returnedSelection }),
		};
	}

	async switchSession(input: GjcSwitchSessionInput): Promise<void> {
		this.switches.push(input);
	}
	async withLifecyclePublication<T>(
		address: GjcLifecyclePublicationAddress,
		effect: (lifecycle: GjcLifecycleTransaction) => Promise<T>,
	): Promise<T> {
		return effect(lifecycleFixture(address));
	}

	async getState(input: GjcSessionStateInput): Promise<GjcSessionState> {
		this.states.push(input);
		return { ...this.state, attachment: attachmentProof(input.lifecycle.address) };
	}
}

describe("routeGjcTurn", () => {
	test("starts a project-bound session when no chat mapping exists", async () => {
		const runner = new FakeGjcTurnRunner();
		const mappings = new SessionMappingStore();
		const project = createProject();

		const result = await routeGjcTurn(routeInput(runner, mappings, { project }));

		expect(runner.starts).toHaveLength(1);
		expect(runner.starts[0]).toMatchObject({
			cwd: project.cwd,
			sessionRoot: `${project.cwd}/.gjc/sessions`,
			projectId: project.id,
			chatId: "chat-1",
			userMessageId: "message-1",
			text: "hello",
		});
		expect(runner.switches).toHaveLength(0);
		expect(result.assistantText).toBe("new:hello");
		expect(result.mapping).toEqual({
			chatId: "chat-1",
			projectId: project.id,
			sessionId: "session-1",
			sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
			activeLeaf: "leaf-1",
			rawFrameCursor: 7,
			eventCursor: 3,
			operationId: "message-1",
			assistantText: "new:hello",
			events: [{ type: "assistant", text: "new:hello" }],
			attachment: attachmentProof({
				cwd: project.cwd,
				sessionRoot: `${project.cwd}/.gjc/sessions`,
				projectId: project.id,
				chatId: "chat-1",
				sessionId: "session-1",
			}),
		});
		expect(mappings.entries()).toHaveLength(1);
	});

	test("continues a mapped session after switching and reading state", async () => {
		const runner = new FakeGjcTurnRunner();
		const mappings = new SessionMappingStore();
		const project = createProject();
		mappings.set({
			chatId: "chat-1",
			projectId: project.id,
			sessionId: "session-1",
			sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
			activeLeaf: "leaf-0",
			rawFrameCursor: 2,
			eventCursor: 1,
			operationId: "message-1",
		});

		const result = await routeGjcTurn(
			routeInput(runner, mappings, {
				userMessageId: "message-2",
				parentId: "message-1",
				text: "again",
			}),
		);

		expect(runner.starts).toHaveLength(0);
		expect(runner.switches).toHaveLength(1);
		expect(runner.states).toHaveLength(1);
		expect(runner.continues).toHaveLength(1);
		expect(runner.continues[0]).toMatchObject({
			cwd: project.cwd,
			projectId: project.id,
			sessionId: "session-1",
			chatId: "chat-1",
			userMessageId: "message-2",
			parentId: "message-1",
			activeLeaf: "leaf-1",
			rawFrameCursor: 7,
			eventCursor: 3,
			operationId: "message-2",
		});
		expect(runner.switches[0]?.lifecycle).toBe(runner.states[0]?.lifecycle);
		expect(runner.continues[0]?.lifecycle).toBe(runner.states[0]?.lifecycle);
		expect(result.assistantText).toBe("continued:again");
		expect(result.mapping).toMatchObject({
			activeLeaf: "leaf-2",
			rawFrameCursor: 12,
			eventCursor: 5,
			operationId: "message-2",
		});
	});

	test("rejects persisted session files outside the project session root", async () => {
		const runner = new FakeGjcTurnRunner();
		const mappings = new SessionMappingStore();
		const project = createProject();
		mappings.set({
			chatId: "chat-1",
			projectId: project.id,
			sessionId: "session-1",
			sessionFile: "/tmp/outside-session.jsonl",
			rawFrameCursor: 2,
			eventCursor: 1,
			operationId: "message-1",
		});

		await expect(
			routeGjcTurn(
				routeInput(runner, mappings, {
					userMessageId: "message-2",
					text: "again",
				}),
			),
		).rejects.toBeInstanceOf(SessionFileBoundaryError);
		expect(runner.switches).toHaveLength(0);
	});

	test("keeps one mapping and does not rerun duplicate operations", async () => {
		const runner = new FakeGjcTurnRunner();
		const mappings = new SessionMappingStore();

		const first = await routeGjcTurn(routeInput(runner, mappings));
		const duplicate = await routeGjcTurn(routeInput(runner, mappings));

		expect(runner.starts).toHaveLength(1);
		expect(runner.continues).toHaveLength(0);
		expect(mappings.entries()).toHaveLength(1);
		expect(duplicate.mapping).toEqual(first.mapping);
		expect(duplicate.assistantText).toBe("new:hello");
		expect(duplicate.events).toEqual([{ type: "assistant", text: "new:hello" }]);
	});
	test("replays a completed create after restart without a second session effect", async () => {
		const directory = mkdtempSync(join(tmpdir(), "gjc-create-journal-"));
		const authorityPath = join(directory, "authority.json");
		try {
			const mappings = new FileBackedSessionMappingStore(authorityPath);
			const firstRunner = new FakeGjcTurnRunner();
			const first = await routeGjcTurn(routeInput(firstRunner, mappings));

			const restarted = new FileBackedSessionMappingStore(authorityPath);
			const replayRunner = new FakeGjcTurnRunner();
			const duplicate = await routeGjcTurn(routeInput(replayRunner, restarted));

			expect(firstRunner.starts).toHaveLength(1);
			expect(replayRunner.starts).toHaveLength(0);
			expect(replayRunner.continues).toHaveLength(0);
			expect(duplicate).toEqual(first);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	test("does not create a second session while a create reservation is pending", async () => {
		const runner = new FakeGjcTurnRunner();
		const mappings = new SessionMappingStore();
		const start = runner.startNewSession.bind(runner);
		let release: (() => void) | undefined;
		runner.startNewSession = async (input, publish, beforePrompt, onFailure) => {
			await new Promise<void>(resolve => {
				release = resolve;
			});
			return start(input, publish, beforePrompt, onFailure);
		};

		const first = routeGjcTurn(routeInput(runner, mappings));
		await Promise.resolve();
		await expect(routeGjcTurn(routeInput(runner, mappings))).rejects.toThrow("requires reconciliation");
		expect(runner.starts).toHaveLength(0);
		release?.();
		await first;
		expect(runner.starts).toHaveLength(1);
	});

	test("keeps the durable provisional create proof after a prompt failure and rejects replay or conflicting ingress", async () => {
		const runner = new FakeGjcTurnRunner();
		const mappings = new SessionMappingStore();
		runner.failPrompt = true;

		await expect(routeGjcTurn(routeInput(runner, mappings))).rejects.toThrow("prompt failed");
		expect(mappings.provisionalOperation("chat-1", "message-1")).toEqual({
			id: "message-1",
			kind: "create",
			ingressId: "message-1",
			chatId: "chat-1",
			projectId: "project",
			detail: expect.any(String),
			state: "uncertain",
			startedAt: expect.any(String),
			sessionId: "session-1",
			sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
			attachment: attachmentProof({
				cwd: "/workspace/project",
				sessionId: "session-1",
			}),
		});
		await expect(routeGjcTurn(routeInput(runner, mappings))).rejects.toThrow("requires reconciliation");
		await expect(routeGjcTurn(routeInput(runner, mappings, { text: "different" }))).rejects.toThrow("conflicts");
		expect(runner.starts).toHaveLength(1);
	});
	test("keeps a completed create authoritative when projection publication fails and repairs on replay", async () => {
		const runner = new FakeGjcTurnRunner();
		const mappings = new SessionMappingStore();
		const projectionError = new Error("outbox projection failed");
		let projections = 0;
		const afterPublish = () => {
			projections += 1;
			if (projections === 1) throw projectionError;
		};

		await expect(routeGjcTurn(routeInput(runner, mappings, { afterPublish }))).rejects.toBe(projectionError);
		expect(mappings.provisionalOperation("chat-1", "message-1")?.state).toBe("complete");
		expect(mappings.operation("chat-1", "message-1")?.state).toBe("complete");

		const replayed = await routeGjcTurn(routeInput(runner, mappings, { afterPublish }));
		expect(replayed.assistantText).toBe("new:hello");
		expect(projections).toBe(2);
		expect(runner.starts).toHaveLength(1);
	});
	test("rejects completed in-memory provisional downgrades", () => {
		const mappings = new SessionMappingStore();
		const operation = {
			id: "message-1",
			kind: "create" as const,
			ingressId: "message-1",
			chatId: "chat-1",
			projectId: "project",
			detail: "hash-1",
		};
		mappings.reserveProvisionalOperation(operation);
		mappings.publishProvisionalOperation(operation, {
			chatId: "chat-1",
			projectId: "project",
			sessionId: "session-1",
			rawFrameCursor: 0,
			eventCursor: 0,
			operationId: "message-1",
		});

		expect(() => mappings.transitionProvisionalOperation("chat-1", "message-1", "uncertain")).toThrow(
			"Completed session operations are immutable.",
		);
	});

	test("persists only the normalized selection returned by a successful selected operation", async () => {
		const runner = new FakeGjcTurnRunner();
		const mappings = new SessionMappingStore();
		const requested = selection("anthropic", "requested", "low");
		runner.returnedSelection = selection("anthropic", "normalized", "medium");

		const result = await routeGjcTurn(
			routeInput(runner, mappings, {
				chatId: "chat-selected",
				userMessageId: "message-selected",
				modelSelection: requested,
			}),
		);

		expect(runner.starts[0]?.modelSelection).toEqual(requested);
		expect(result.mapping.modelSelection).toEqual(runner.returnedSelection);
		expect(mappings.get("chat-selected")?.modelSelection).toEqual(runner.returnedSelection);
	});

	test("leaves an existing mapping unchanged when the selected prompt fails", async () => {
		const runner = new FakeGjcTurnRunner();
		const mappings = new SessionMappingStore();
		const originalSelection = selection("anthropic", "bound", "medium");
		mappings.set({
			chatId: "chat-1",
			projectId: "project",
			sessionId: "session-1",
			rawFrameCursor: 2,
			eventCursor: 1,
			operationId: "message-1",
			modelSelection: originalSelection,
		});
		runner.failPrompt = true;

		await expect(
			routeGjcTurn(
				routeInput(runner, mappings, {
					userMessageId: "message-2",
					text: "again",
					modelSelection: selection("openai", "new", "high"),
				}),
			),
		).rejects.toThrow("prompt failed");
		expect(mappings.get("chat-1")).toMatchObject({ operationId: "message-1", modelSelection: originalSelection });
	});
});
describe("routeGjcSessionClose", () => {
	test("replays a completed close without repeating its remote effect", async () => {
		const mappings = closeMappings();
		const mapping = mappings.get("chat-1")!;
		const attachment = mapping.attachment!;
		let calls = 0;
		let preflights = 0;
		let preflightReceipt: GjcCloseReceipt | undefined;
		const input = {
			mapping,
			mappings,
			ingressId: "close-1",
			ingressHash: "hash-1",
			lifecycle: closeLifecycle(mapping, receipt => {
				preflights += 1;
				preflightReceipt = receipt;
			}),
			close: async (receipt: GjcCloseReceipt) => {
				calls += 1;
				if (preflightReceipt === undefined) throw new Error("close receipt was not preflighted");
				expect(receipt).toBe(preflightReceipt);
				expect(receipt.proof).toEqual(attachment);
				expect(receipt.attachment).toEqual({
					sessionId: mapping.sessionId,
					cwd: "/workspace/project",
					endpoint: { url: "ws://127.0.0.1:9876", token: "fixture-token", pid: 42 },
					authority: attachment,
				});
				return { status: "closed" } as const;
			},
		};

		const first = await routeGjcSessionClose(input);
		const duplicate = await routeGjcSessionClose(input);

		expect(duplicate).toEqual(first);
		expect(calls).toBe(1);
		expect(preflights).toBe(1);
	});
	test("binds close operation identity to canonical mapping fields rather than bearer credentials", () => {
		const mapping = closeMappings().get("chat-1")!;
		expect(closeIngressId("operation-1", mapping)).toBe(closeIngressId("operation-1", mapping));
		expect(closeIngressId("operation-1", mapping)).not.toBe(closeIngressId("operation-2", mapping));
		expect(closeIngressId("Bearer secret-token", mapping)).not.toContain("secret-token");
		expect(closeIngressId("operation-1", { ...mapping, sessionId: "session-2" })).not.toBe(
			closeIngressId("operation-1", mapping),
		);
	});
	test("replays a close after restart without repeating its remote effect", async () => {
		const directory = mkdtempSync(join(tmpdir(), "gjc-close-journal-"));
		const authorityPath = join(directory, "authority.json");
		try {
			const mappings = new FileBackedSessionMappingStore(authorityPath);
			mappings.set(closeMappings().get("chat-1")!);
			const mapping = mappings.get("chat-1")!;
			const attachment = mapping.attachment!;
			let firstPreflights = 0;
			const input = {
				mapping,
				mappings,
				ingressId: "close-1",
				ingressHash: "hash-1",
				lifecycle: closeLifecycle(mapping, () => {
					firstPreflights += 1;
				}),
				close: async (receipt: GjcCloseReceipt) => {
					expect(receipt.proof).toEqual(attachment);
					return { status: "closed" } as const;
				},
			};
			const first = await routeGjcSessionClose(input);

			const restarted = new FileBackedSessionMappingStore(authorityPath);
			const restartedMapping = restarted.get("chat-1")!;
			let calls = 0;
			let replayPreflights = 0;
			const replay = await routeGjcSessionClose({
				...input,
				mappings: restarted,
				mapping: restartedMapping,
				lifecycle: closeLifecycle(restartedMapping, () => {
					replayPreflights += 1;
				}),
				close: async (_receipt: GjcCloseReceipt) => {
					calls += 1;
					return { status: "closed" } as const;
				},
			});

			expect(replay).toEqual(first);
			expect(calls).toBe(0);
			expect(firstPreflights).toBe(1);
			expect(replayPreflights).toBe(0);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	test("returns uncertain without invoking close for an endpoint-only mapping", async () => {
		const mappings = closeMappings();
		const mapping = mappings.get("chat-1")!;
		const endpointOnlyMapping: SessionMapping = {
			...mapping,
			attachment: attachmentProof({
				cwd: "/workspace/project",
				sessionRoot: "/workspace/project/.gjc/sessions",
				projectId: "project",
				chatId: "chat-1",
				sessionId: "session-1",
			}),
		};
		let preflights = 0;
		let calls = 0;

		const result = await routeGjcSessionClose({
			mapping: endpointOnlyMapping,
			mappings,
			ingressId: "close-1",
			ingressHash: "hash-1",
			lifecycle: closeLifecycle(mapping, () => {
				preflights += 1;
			}),
			close: async (_receipt: GjcCloseReceipt) => {
				calls += 1;
				return { status: "closed" };
			},
		});

		expect(result).toEqual({
			status: "uncertain",
			message: "GJC close requires a complete owned-pane attachment before acknowledgement.",
		});
		expect(preflights).toBe(0);
		expect(calls).toBe(0);
		expect(mappings.operation("chat-1", "close-1")).toMatchObject({ state: "conflict" });
	});

	test("allows a new operation ID after an unavailable close attempt", async () => {
		const mappings = closeMappings();
		const mapping = mappings.get("chat-1")!;
		const input = {
			mapping,
			mappings,
			ingressHash: "hash",
		};
		const unavailable = await routeGjcSessionClose({
			...input,
			ingressId: "close-unavailable",
			lifecycle: closeLifecycle(mapping),
			close: async () => ({ status: "unavailable", message: "authority refresh required" }),
		});
		let calls = 0;
		const retried = await routeGjcSessionClose({
			...input,
			ingressId: "close-retry",
			lifecycle: closeLifecycle(mapping),
			close: async () => {
				calls += 1;
				return { status: "closed" };
			},
		});

		expect(unavailable).toEqual({ status: "unavailable", message: "authority refresh required" });
		expect(retried).toEqual({ status: "closed" });
		expect(calls).toBe(1);
	});
	test("does not repeat an ambiguous close and rejects conflicting ingress", async () => {
		const mappings = closeMappings();
		const mapping = mappings.get("chat-1")!;
		const attachment = mapping.attachment!;
		let calls = 0;
		const input = {
			mapping,
			mappings,
			ingressId: "close-1",
			ingressHash: "hash-1",
			lifecycle: closeLifecycle(mapping),
			close: async (receipt: GjcCloseReceipt) => {
				calls += 1;
				expect(receipt.proof).toEqual(attachment);
				throw new Error("acknowledgement lost");
			},
		};

		await expect(routeGjcSessionClose(input)).rejects.toThrow("acknowledgement lost");
		await expect(routeGjcSessionClose(input)).rejects.toThrow("requires reconciliation");
		await expect(routeGjcSessionClose({ ...input, ingressHash: "different" })).rejects.toThrow("conflicts");
		expect(calls).toBe(1);
	});
});

function closeMappings(): SessionMappingStore {
	const mappings = new SessionMappingStore();
	mappings.set({
		chatId: "chat-1",
		projectId: "project",
		sessionId: "session-1",
		rawFrameCursor: 2,
		eventCursor: 1,
		operationId: "message-1",
		attachment: {
			...attachmentProof({
				cwd: "/workspace/project",
				sessionRoot: "/workspace/project/.gjc/sessions",
				projectId: "project",
				chatId: "chat-1",
				sessionId: "session-1",
			}),
			tmuxSocket: "/tmp/tmux-1000/default",
			tmuxPane: "%42",
			tmuxPanePid: 42,
			tmuxOwnershipTag: "gjc:session-1",
			ownedAt: "2026-07-19T00:00:00.000Z",
		},
	});
	return mappings;
}

function closeLifecycle(
	mapping: SessionMapping,
	onPreflight: (receipt: GjcCloseReceipt) => void = () => undefined,
): GjcLifecycleTransaction {
	if (mapping.attachment === undefined) throw new Error("close fixture requires a mapping attachment");
	const proof = mapping.attachment;
	const address: GjcLifecyclePublicationAddress = {
		cwd: "/workspace/project",
		sessionRoot: "/workspace/project/.gjc/sessions",
		projectId: mapping.projectId,
		chatId: mapping.chatId,
		sessionId: mapping.sessionId,
		recoveryAttachment: proof,
	};
	const receipt = GjcCloseReceipt.fromPreflight(address, proof, {
		sessionId: mapping.sessionId,
		cwd: address.cwd,
		endpoint: { url: "ws://127.0.0.1:9876", token: "fixture-token", pid: proof.tmuxPanePid },
		authority: proof,
	});
	let preflighted = false;
	return {
		owner: {},
		address,
		assertClosePreflight(candidate) {
			if (candidate !== proof) throw new Error("close fixture rejected a non-mapping attachment");
			if (preflighted) throw new Error("close fixture issued more than one receipt");
			preflighted = true;
			onPreflight(receipt);
			return receipt;
		},
		async publish(candidate, write) {
			if (candidate !== proof) throw new Error("close fixture rejected a non-mapping attachment");
			return write();
		},
		async publishClosed(candidate, write) {
			if (candidate !== receipt) throw new Error("close fixture rejected a non-preflight receipt");
			return write();
		},
		async handoff(_successor, candidate) {
			if (candidate !== proof) throw new Error("close fixture rejected a non-mapping attachment");
		},
	};
}

function selection(
	provider: string,
	modelId: string,
	thinkingLevel: NormalizedModelSelection["thinkingLevel"],
): NormalizedModelSelection {
	return { provider, modelId, thinkingLevel };
}

function routeInput(
	runner: GjcTurnRunner,
	mappings: SessionMappingStore,
	overrides: Partial<RouteGjcTurnInput> = {},
): RouteGjcTurnInput {
	return {
		project: createProject(),
		chatId: "chat-1",
		userMessageId: "message-1",
		text: "hello",
		runner,
		mappings,
		...overrides,
	};
}

function createProject(): RegisteredProject {
	return {
		id: "project",
		name: "Project",
		cwd: "/workspace/project",
		allowedRoot: "/workspace",
		createdAt: new Date("2026-07-08T00:00:00.000Z"),
	};
}
