import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GjcRuntimeLocations, NormalizedModelSelection } from "../src/contracts";
import { FileBackedSessionMappingStore, SessionMappingStore } from "../src/gjc/session-router";
import type {
	GjcControlResult,
	GjcLifecyclePublicationAddress,
	GjcLifecycleTestBarrierHook,
	GjcLifecycleTransaction,
	GjcTurnRunner,
} from "../src/gjc/turn-runner";
import type { LiveGatewayRunnerInput } from "../src/live/chat-completions";
import { createGjcRoutingLiveGatewayRunner, createPublicSdkGjcTurnRunner } from "../src/live/gjc-routing-runner";
import { buildSessionMappingPayloadHash } from "../src/live/workflow-gate-turns";
import { InMemoryOutboxStore } from "../src/state/outbox";
import { FakeGjcTurnRunner, project } from "./gjc-routing-runner-fixtures";
import type { SdkFixtureScenario, SdkFixtureServer } from "./gjc-sdk-v3-fixture-types";
import { expectSdkRequest, startSdkFixtureServer } from "./gjc-sdk-v3-fixtures";
import { staticModelReaderFactory } from "./model-selection-fixtures";

describe("createGjcRoutingLiveGatewayRunner persistence", () => {
	test("persists mappings across file-backed store instances", () => {
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-mapping-")), "mappings.json");
		const first = new FileBackedSessionMappingStore(filePath);
		first.set({
			chatId: "chat-1",
			projectId: project.id,
			sessionId: "session-1",
			sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
			activeLeaf: "leaf-1",
			rawFrameCursor: 7,
			eventCursor: 3,
			operationId: "user-1",
			assistantText: "new:hello",
			events: [{ type: "assistant", text: "new:hello" }],
		});

		const second = new FileBackedSessionMappingStore(filePath);
		expect(second.get("chat-1")).toEqual(first.get("chat-1"));
	});

	test("serializes only exact normalized tuple keys", () => {
		withFileStore((store, filePath) => {
			const modelSelection = { ...mediumSelection };
			Reflect.set(modelSelection, "canonicalId", "gjc/anthropic/claude-sonnet-4:medium");
			store.set(mappingInput(modelSelection));
			const persisted = JSON.parse(readFileSync(filePath, "utf8"));
			expect(persisted).toMatchObject({ kind: "openwebui-gjc-session-authority", version: 2 });
			expect(persisted.mappings[0].modelSelection).toEqual(mediumSelection);
			expect(JSON.stringify(persisted)).not.toContain("gjc/anthropic");
		});
	});

	test("round-trips a normalized tuple through a file-backed reload", () => {
		withFileStore((store, filePath) => {
			store.set(mappingInput(mediumSelection));
			expect(new FileBackedSessionMappingStore(filePath).get("chat-1")?.modelSelection).toEqual(mediumSelection);
		});
	});

	test("includes the normalized tuple in the mapping payload hash", () => {
		withFileStore(store => {
			const mapping = store.set(mappingInput(mediumSelection));
			expect(buildSessionMappingPayloadHash(mapping)).not.toBe(
				buildSessionMappingPayloadHash({ ...mapping, modelSelection: undefined }),
			);
		});
	});

	test("quarantines legacy mappings when loading a file-backed mapping store", () => {
		withFileStore((store, filePath) => {
			const mapping = store.set(mappingInput(mediumSelection));
			writeFileSync(
				filePath,
				JSON.stringify({ mappings: [{ ...mapping, modelSelection: { ...mediumSelection, provider: "a%2Fb" } }] }),
			);
			expect(new FileBackedSessionMappingStore(filePath).get("chat-1")).toBeUndefined();
		});
	});

	test("strips slash-delimited providers before persisting a session mapping", () => {
		withFileStore((store, filePath) => {
			store.set(mappingInput({ ...mediumSelection, provider: "proxy/openai", modelId: "model:雪/preview" }));

			const persisted = JSON.parse(readFileSync(filePath, "utf8"));

			expect(persisted.mappings[0].modelSelection).toBeUndefined();
		});
	});
	test("fails closed on corrupt v2 authority records", () => {
		withFileStore((store, filePath) => {
			const mapping = store.set(mappingInput(mediumSelection));
			writeFileSync(
				filePath,
				JSON.stringify({
					kind: "openwebui-gjc-session-authority",
					version: 2,
					mappings: [
						{
							...mapping,
							rawFrameCursor: -1,
							modelSelection: { ...mediumSelection, thinkingLevel: "invalid" },
							journal: [{ id: "user-1", kind: "unknown", state: "complete", startedAt: "not-a-date" }],
						},
					],
				}),
			);
			expect(() => new FileBackedSessionMappingStore(filePath)).toThrow("not a valid v2 authority");
		});
	});
	test("fails closed when persisted attachment proof lacks descriptor identity", () => {
		withFileStore((store, filePath) => {
			const mapping = store.set(mappingInput(mediumSelection));
			writeFileSync(
				filePath,
				JSON.stringify({
					kind: "openwebui-gjc-session-authority",
					version: 2,
					mappings: [
						{
							...mapping,
							attachment: {
								descriptorPath: "/workspace/.gjc/endpoints/session-1.json",
								descriptorStat: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
								generation: 0,
								expectedSessionId: "session-1",
								expectedCwd: "/workspace",
							},
						},
					],
				}),
			);
			expect(() => new FileBackedSessionMappingStore(filePath)).toThrow("not a valid v2 authority");
		});
	});
	test("retains complete pane proof structurally but rejects partial pane proof", () => {
		withFileStore((_store, filePath) => {
			const valid = validAuthorityDocument();
			valid.mappings[0].attachment = {
				descriptorPath: "/workspace/.gjc/endpoints/session-1.json",
				descriptorStat: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
				payloadDigest: "0000000000000000000000000000000000000000000000000000000000000000",
				generation: 4,
				expectedSessionId: "session-1",
				expectedCwd: "/workspace",
				tmuxSocket: "default",
				tmuxPane: "%10",
				tmuxPanePid: 42,
				tmuxOwnershipTag: "gjc",
				ownedAt: "2026-01-01T00:00:00.000Z",
			};
			writeFileSync(filePath, JSON.stringify(valid));
			expect(new FileBackedSessionMappingStore(filePath).get("chat-1")?.attachment).toMatchObject({
				payloadDigest: "0000000000000000000000000000000000000000000000000000000000000000",
				tmuxPane: "%10",
				tmuxPanePid: 42,
				tmuxOwnershipTag: "gjc",
			});

			const missingDigest = validAuthorityDocument();
			missingDigest.mappings[0].attachment = { ...valid.mappings[0].attachment, payloadDigest: undefined };
			writeFileSync(filePath, JSON.stringify(missingDigest));
			expect(() => new FileBackedSessionMappingStore(filePath)).toThrow("not a valid v2 authority");

			const splitGeneration = validAuthorityDocument();
			splitGeneration.mappings[0].attachment = { ...valid.mappings[0].attachment, generation: 5 };
			writeFileSync(filePath, JSON.stringify(splitGeneration));
			expect(() => new FileBackedSessionMappingStore(filePath)).toThrow("not a valid v2 authority");
		});
	});
	test.each([
		[
			"document",
			(document: any) => {
				document.unexpected = true;
			},
		],
		[
			"mapping",
			(document: any) => {
				document.mappings[0].unexpected = true;
			},
		],
		[
			"header",
			(document: any) => {
				document.mappings[0].header.unexpected = true;
			},
		],
		[
			"event",
			(document: any) => {
				document.mappings[0].events[0].unexpected = true;
			},
		],
		[
			"selection",
			(document: any) => {
				document.mappings[0].modelSelection.unexpected = true;
			},
		],
		[
			"attachment",
			(document: any) => {
				document.mappings[0].attachment.unexpected = true;
			},
		],
		[
			"operation",
			(document: any) => {
				document.mappings[0].journal[0].unexpected = true;
			},
		],
		[
			"result",
			(document: any) => {
				document.mappings[0].journal[0].result.unexpected = true;
			},
		],
		[
			"provisional",
			(document: any) => {
				document.provisionalOperations[0].unexpected = true;
			},
		],
	] as const)("fails closed on an unknown key in the v2 %s", (_field, corrupt) => {
		withFileStore((_store, filePath) => {
			const document = validAuthorityDocument();
			corrupt(document);
			writeFileSync(filePath, JSON.stringify(document));
			expect(() => new FileBackedSessionMappingStore(filePath)).toThrow("not a valid v2 authority");
		});
	});
	test.each([
		[
			"event payload",
			(document: any) => {
				document.mappings[0].events[0].payload = [];
			},
		],
		[
			"selection enum",
			(document: any) => {
				document.mappings[0].modelSelection.thinkingLevel = "invalid";
			},
		],
		[
			"attachment stat",
			(document: any) => {
				document.mappings[0].attachment.descriptorStat.ino = -1;
			},
		],
		[
			"attachment digest missing",
			(document: any) => {
				delete document.mappings[0].attachment.payloadDigest;
			},
		],
		[
			"attachment digest malformed",
			(document: any) => {
				document.mappings[0].attachment.payloadDigest = "not-a-sha256-digest";
			},
		],
		[
			"operation completion",
			(document: any) => {
				document.mappings[0].journal[0].completedAt = "not-a-date";
			},
		],
		[
			"result cursor",
			(document: any) => {
				document.mappings[0].journal[0].result.mapping.eventCursor = -1;
			},
		],
		[
			"provisional timestamp",
			(document: any) => {
				document.provisionalOperations[0].startedAt = "not-a-date";
			},
		],
	] as const)("fails closed on corrupt v2 %s", (_field, corrupt) => {
		withFileStore((_store, filePath) => {
			const document = validAuthorityDocument();
			corrupt(document);
			writeFileSync(filePath, JSON.stringify(document));
			expect(() => new FileBackedSessionMappingStore(filePath)).toThrow("not a valid v2 authority");
		});
	});
	test("fails closed when an immutable operation attachment belongs to another session", () => {
		withFileStore((_store, filePath) => {
			const document = validAuthorityDocument();
			document.mappings[0].journal[0].result.mapping.attachment = {
				descriptorPath: "/workspace/.gjc/endpoints/session-other.json",
				descriptorStat: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
				payloadDigest: "0000000000000000000000000000000000000000000000000000000000000000",
				generation: 4,
				expectedSessionId: "session-other",
				expectedCwd: "/workspace",
			};
			writeFileSync(filePath, JSON.stringify(document));
			expect(() => new FileBackedSessionMappingStore(filePath)).toThrow("not a valid v2 authority");
		});
	});

	test("returns cached duplicate content after store reload without rerunning", async () => {
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-mapping-")), "mappings.json");
		const firstRunner = new FakeGjcTurnRunner();
		const firstStore = new FileBackedSessionMappingStore(filePath);
		const first = createGjcRoutingLiveGatewayRunner({ turnRunner: firstRunner, mappings: firstStore });
		expect(
			await first.run({
				project,
				prompt: "hello",
				chatId: "chat-1",
				messageId: "assistant-1",
				userMessageId: "user-1",
				userMessageParentId: null,
				continued: false,
			}),
		).toEqual({ content: "new:hello" });

		const secondRunner = new FakeGjcTurnRunner();
		const secondStore = new FileBackedSessionMappingStore(filePath);
		const second = createGjcRoutingLiveGatewayRunner({ turnRunner: secondRunner, mappings: secondStore });

		expect(
			await second.run({
				project,
				prompt: "hello",
				chatId: "chat-1",
				messageId: "assistant-1",
				userMessageId: "user-1",
				userMessageParentId: null,
				continued: false,
			}),
		).toEqual({ content: "new:hello" });
		expect(secondRunner.starts).toHaveLength(0);
		expect(secondRunner.switches).toHaveLength(0);
		expect(secondRunner.continues).toHaveLength(0);
	});
	test("replays an older persisted prompt after later completions without runner effects", async () => {
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-mapping-")), "mappings.json");
		const firstRunner = new FakeGjcTurnRunner();
		const first = createGjcRoutingLiveGatewayRunner({
			turnRunner: firstRunner,
			mappings: new FileBackedSessionMappingStore(filePath),
		});
		const firstTurn = {
			project,
			prompt: "first",
			chatId: "chat-1",
			messageId: "assistant-1",
			userMessageId: "user-1",
			userMessageParentId: null,
			continued: false,
		};
		expect(await first.run(firstTurn)).toEqual({ content: "new:first" });
		expect(
			await first.run({
				...firstTurn,
				prompt: "second",
				messageId: "assistant-2",
				userMessageId: "user-2",
				userMessageParentId: "assistant-1",
				continued: true,
			}),
		).toEqual({ content: "continued:second" });

		const replayRunner = new FakeGjcTurnRunner();
		const replay = createGjcRoutingLiveGatewayRunner({
			turnRunner: replayRunner,
			mappings: new FileBackedSessionMappingStore(filePath),
		});
		expect(await replay.run(firstTurn)).toEqual({ content: "new:first" });
		expect(replayRunner.starts).toHaveLength(0);
		expect(replayRunner.switches).toHaveLength(0);
		expect(replayRunner.states).toHaveLength(0);
		expect(replayRunner.continues).toHaveLength(0);
		expect(replayRunner.gateResponses).toHaveLength(0);
	});
	test("persists endpoint-backed provisional create authority before a transcript exists and reconciles it on restart", () => {
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-mapping-")), "mappings.json");
		const first = new FileBackedSessionMappingStore(filePath);
		first.reserveProvisionalOperation({
			id: "user-1",
			kind: "create",
			ingressId: "user-1",
			chatId: "chat-1",
			projectId: project.id,
			detail: "hash",
		});
		const attachment = {
			descriptorPath: "/workspace/project/.gjc/state/sdk/session-created.json",
			descriptorStat: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
			payloadDigest: "0000000000000000000000000000000000000000000000000000000000000000",
			generation: 4,
			expectedSessionId: "session-created",
			expectedCwd: "/workspace/project",
			tmuxSocket: "/tmp/tmux-1000/default",
			tmuxPane: "%42",
			tmuxPanePid: 42,
			tmuxOwnershipTag: "gjc:session-created",
			ownedAt: "2026-07-20T00:00:00.000Z",
		};
		first.attachProvisionalOperation("chat-1", "user-1", {
			sessionId: "session-created",
			attachment,
		});

		const second = new FileBackedSessionMappingStore(filePath);
		expect(second.get("chat-1")).toBeUndefined();
		expect(second.provisionalOperation("chat-1", "user-1")).toEqual({
			id: "user-1",
			kind: "create",
			ingressId: "user-1",
			chatId: "chat-1",
			projectId: project.id,
			detail: "hash",
			state: "uncertain",
			startedAt: expect.any(String),
			sessionId: "session-created",
			attachment,
		});
		expect(second.provisionalOperation("chat-1", "user-1")?.attachment?.expectedSessionId).toBe(
			second.provisionalOperation("chat-1", "user-1")?.sessionId,
		);
		expect(() =>
			second.reserveProvisionalOperation({
				id: "user-1",
				kind: "create",
				ingressId: "user-1",
				chatId: "chat-1",
				projectId: project.id,
				detail: "hash",
			}),
		).toThrow("requires reconciliation");
	});

	test("cold-resumes only the file-backed branch successor after restart", async () => {
		const root = mkdtempSync(join(tmpdir(), "gjc-branch-restart-"));
		const sessionRoot = join(root, ".gjc", "sessions");
		mkdirSync(sessionRoot, { recursive: true });
		const filePath = join(root, "mappings.json");
		const endpointRoot = join(root, ".gjc", "state", "sdk");
		const predecessorPath = join(sessionRoot, "predecessor.jsonl");
		const successorPath = join(sessionRoot, "successor.jsonl");
		writeFileSync(
			predecessorPath,
			`${JSON.stringify({ type: "session", version: 3, id: "predecessor", timestamp: "2026-01-01T00:00:00.000Z", cwd: root })}\n`,
		);
		class BranchFakeGjcTurnRunner extends FakeGjcTurnRunner {
			async runControl(
				_input: LiveGatewayRunnerInput,
				_mapping: Parameters<NonNullable<GjcTurnRunner["runControl"]>>[1],
				_lifecycle: Parameters<NonNullable<GjcTurnRunner["runControl"]>>[2],
			): Promise<GjcControlResult> {
				writeFileSync(
					successorPath,
					`${JSON.stringify({ type: "session", version: 3, id: "successor", timestamp: "2026-01-01T00:00:00.000Z", cwd: root })}\n`,
				);
				mkdirSync(endpointRoot, { recursive: true });
				const descriptorPath = join(endpointRoot, "successor.json");
				const descriptor = JSON.stringify({ version: 1, url: "ws://127.0.0.1:1", token: "successor-token" });
				writeFileSync(descriptorPath, descriptor);
				const descriptorStat = statSync(descriptorPath);
				const proof = {
					descriptorPath,
					descriptorStat: {
						dev: descriptorStat.dev,
						ino: descriptorStat.ino,
						size: descriptorStat.size,
						mtimeMs: descriptorStat.mtimeMs,
					},
					payloadDigest: createHash("sha256").update(descriptor).digest("hex"),
					generation: descriptorStat.mtimeMs,
					expectedSessionId: "successor",
					expectedCwd: root,
				};
				return {
					sessionId: "successor",
					sessionFile: successorPath,
					attachment: proof,
				};
			}
		}
		const branchRunner = new BranchFakeGjcTurnRunner();
		const branchProject = { ...project, cwd: root, sessionRoot };
		const firstStore = new FileBackedSessionMappingStore(filePath);
		firstStore.set({
			...mappingInput(mediumSelection),
			sessionId: "predecessor",
			sessionFile: predecessorPath,
			activeLeaf: "leaf-predecessor",
		});
		const first = createGjcRoutingLiveGatewayRunner({
			turnRunner: branchRunner,
			mappings: firstStore,
			ownerUserId: "owner-1",
		});

		await first.run({
			project: branchProject,
			prompt: "",
			chatId: "chat-1",
			messageId: "assistant-1",
			userMessageId: "branch-1",
			userMessageParentId: "assistant-1",
			continued: true,
			control: { operation: "branch" },
			messageMetadata: {
				gjc_adapter: {
					ownerUserId: "owner-1",
					projectId: project.id,
					gjcSessionId: "predecessor",
					gjcEntryId: "assistant-1",
				},
			},
		});

		expect(readFileSync(successorPath, "utf8")).toContain('"id":"successor"');
		const persisted = new FileBackedSessionMappingStore(filePath).get("chat-1");
		expect(persisted).toMatchObject({
			sessionId: "successor",
			sessionFile: successorPath,
			attachment: {
				expectedSessionId: "successor",
				expectedCwd: root,
			},
		});

		const coldRunner = new FakeGjcTurnRunner();
		coldRunner.state = {
			sessionFile: successorPath,
			activeLeaf: "leaf-successor",
			rawFrameCursor: 0,
			eventCursor: 0,
		};
		const cold = createGjcRoutingLiveGatewayRunner({
			turnRunner: coldRunner,
			mappings: new FileBackedSessionMappingStore(filePath),
		});
		await cold.run({
			project: branchProject,
			prompt: "continue successor",
			chatId: "chat-1",
			messageId: "assistant-2",
			userMessageId: "user-2",
			userMessageParentId: "assistant-1",
			continued: true,
		});
		expect(coldRunner.continues).toHaveLength(1);
		expect(coldRunner.switches).toHaveLength(1);
		expect(coldRunner.switches[0]).toMatchObject({ sessionId: "successor", sessionFile: successorPath });
		expect(coldRunner.switches[0]?.sessionFile).not.toBe(predecessorPath);
		expect(coldRunner.continues[0]).toMatchObject({ sessionId: "successor" });
	});

	test("enqueues a stable session_mapping outbox operation when provided", async () => {
		const turnRunner = new FakeGjcTurnRunner();
		const mappings = new SessionMappingStore();
		const outbox = new InMemoryOutboxStore();
		const runner = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings, outbox, ownerUserId: "owner-1" });

		await runner.run({
			project,
			prompt: "hello",
			chatId: "chat-1",
			messageId: "assistant-1",
			userMessageId: "user-1",
			userMessageParentId: null,
			continued: false,
		});

		const operations = outbox.listPending();
		const sessionMappingPayloadHash = operations[0]?.payloadHash;
		const eventPayloadHash = operations[1]?.payloadHash;
		expect(operations).toHaveLength(2);
		expect(operations).toMatchObject([
			{
				operationId: "user-1",
				ownerUserId: "owner-1",
				projectId: project.id,
				chatId: "chat-1",
				kind: "session_mapping",
				state: "pending",
				payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
			},
			{
				operationId: "user-1:event",
				ownerUserId: "owner-1",
				projectId: project.id,
				chatId: "chat-1",
				kind: "event",
				state: "pending",
				payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
			},
		]);
		expect(operations[0]?.operationId).not.toBe(operations[1]?.operationId);
		expect(outbox.get("user-1")?.payloadHash).toBe(sessionMappingPayloadHash);
		expect(outbox.get("user-1:event")?.payloadHash).toBe(eventPayloadHash);
	});

	test.each([
		["start", false],
		["continuation", true],
	] as const)("reports the returned %s selection instead of its requested alias", async (_label, continued) => {
		const turnRunner = new FakeGjcTurnRunner();
		turnRunner.startModelSelection = mediumSelection;
		turnRunner.continueModelSelection = mediumSelection;
		const mappings = new SessionMappingStore();
		if (continued) mappings.set(mappingInput(mediumSelection));
		const transcript: string[] = [];
		const runner = createGjcRoutingLiveGatewayRunner({
			turnRunner,
			mappings,
			requestedModelId: () => "foreign-callback-must-not-win",
			createNeutralModelReader: () => neutralReader(transcript),
		});

		const result = await runner.run({
			...turn(continued ? "chat-1" : "chat-neutral", "user-2", continued),
			requestedModelId: "gjc",
		});
		const selectedInput = continued ? turnRunner.continues[0] : turnRunner.starts[0];
		expect(transcript).toEqual(["catalog", "state", "stop"]);
		expect(selectedInput?.modelSelection).toEqual(lowSelection);
		if (continued) {
			expect(turnRunner.states).toHaveLength(1);
			expect(selectedInput).toMatchObject({
				activeLeaf: "leaf-1",
				rawFrameCursor: 7,
				eventCursor: 3,
			});
		}
		expect(mappings.get(continued ? "chat-1" : "chat-neutral")?.modelSelection).toEqual(mediumSelection);
		expect(result.model).toBe("gjc/anthropic/claude-sonnet-4:medium");
	});
	test("composes authenticated Q16 branch regeneration through public SDK persistence and restart", async () => {
		const fixture = await setupPublicSdkBranchFixture("branch_regenerate");
		try {
			const result = await fixture.runner.run(fixture.turn);
			expect(result).toMatchObject({ content: "successor assistant" });
			expectSdkRequest(fixture.server.frames, "query_request", "session.branch_candidates");
			const branch = expectSdkRequest(fixture.server.frames, "control_request", "session.branch");
			expect(branch.input).toEqual({ entryId: "entry-q16" });
			expect(fixture.server.persistenceObservedBeforePrompt).toBe(false);

			const ordered = fixture.server.frames.map(frame =>
				frame.type === "query_request" ? frame.query : frame.operation,
			);
			const branchIndex = ordered.indexOf("session.branch");
			const successorQ14Index = ordered.findIndex(
				(operation, index) => index > branchIndex && operation === "session.metadata",
			);
			expect(ordered.indexOf("session.branch_candidates")).toBeLessThan(branchIndex);
			expect(branchIndex).toBeLessThan(successorQ14Index);
			expect(successorQ14Index).toBeLessThan(ordered.indexOf("turn.prompt"));

			const persisted = new FileBackedSessionMappingStore(fixture.mappingFile).get("chat-q16");
			expect(persisted).toMatchObject({
				sessionId: "sdk-session-successor",
				sessionFile: fixture.successorPath,
				operationId: "branch-q16",
			});
			expect(persisted?.attachment).toMatchObject({
				descriptorPath: join(fixture.project.cwd, ".gjc", "state", "sdk", "sdk-session-successor.json"),
				expectedSessionId: "sdk-session-successor",
				expectedCwd: fixture.project.cwd,
			});
			expect(persisted?.attachment).not.toHaveProperty("tmuxPane");
			expect(persisted?.attachment).not.toHaveProperty("tmuxOwnershipTag");
			const restartedTurnRunner = createPublicSdkGjcTurnRunner(fixture.runnerInput);
			const restartAddress = {
				cwd: fixture.project.cwd,
				sessionRoot: fixture.project.sessionRoot ?? "",
				projectId: fixture.project.id,
				chatId: "chat-q16",
				sessionId: "sdk-session-successor",
				sessionFile: fixture.successorPath,
			};
			await withLifecyclePublication(restartedTurnRunner, restartAddress, lifecycle =>
				restartedTurnRunner.switchSession({ ...restartAddress, lifecycle }),
			);
			await withLifecyclePublication(restartedTurnRunner, restartAddress, lifecycle =>
				restartedTurnRunner.continueSession({
					...restartAddress,
					text: "restart successor",
					userMessageId: "restart-q16",
					rawFrameCursor: 0,
					eventCursor: 0,
					operationId: "restart-q16",
					lifecycle,
				}),
			);
			expect(
				fixture.server.frames.filter(
					frame => frame.type === "control_request" && frame.operation === "session.branch",
				),
			).toHaveLength(1);
			expect(
				fixture.server.frames.filter(
					frame => frame.type === "control_request" && frame.operation === "turn.prompt",
				),
			).toHaveLength(2);
		} finally {
			fixture.dispose();
		}
	});
	test("does not duplicate a branch after its successor descriptor becomes stale", async () => {
		let barrierHits = 0;
		const fixture = await setupPublicSdkBranchFixture("branch_regenerate", async (phase, evidence) => {
			expect(phase).toBe("between_branch_phases");
			expect(evidence).toMatchObject({ cwd: fixture.project.cwd, sessionId: "sdk-session-successor" });
			if (barrierHits === 0) {
				unlinkSync(join(evidence.cwd, ".gjc", "state", "sdk", `${evidence.sessionId}.json`));
			}
			barrierHits += 1;
		});
		try {
			await expect(fixture.runner.run(fixture.turn)).rejects.toThrow("endpoint descriptor");
			const restartedMappings = new FileBackedSessionMappingStore(fixture.mappingFile);
			expect(restartedMappings.operation("chat-q16", "branch-q16")).toMatchObject({
				id: "branch-q16",
				kind: "branch",
				state: "uncertain",
			});
			expect(restartedMappings.get("chat-q16")).toMatchObject({
				sessionId: "sdk-session-created",
				operationId: "predecessor-q16",
			});

			const restarted = createGjcRoutingLiveGatewayRunner({
				turnRunner: createPublicSdkGjcTurnRunner(fixture.runnerInput),
				mappings: restartedMappings,
				ownerUserId: "owner-q16",
			});
			await expect(restarted.run(fixture.turn)).rejects.toThrow("requires reconciliation");
			expect(barrierHits).toBe(1);
			expect(
				fixture.server.frames.filter(
					frame => frame.type === "control_request" && frame.operation === "session.branch",
				),
			).toHaveLength(1);
			expect(
				fixture.server.frames.filter(
					frame => frame.type === "control_request" && frame.operation === "turn.prompt",
				),
			).toHaveLength(0);
			expect(new FileBackedSessionMappingStore(fixture.mappingFile).get("chat-q16")).toMatchObject({
				sessionId: "sdk-session-created",
				operationId: "predecessor-q16",
			});
		} finally {
			fixture.dispose();
		}
	});

	test.each([
		["branch_candidate_absent", "branch_lineage_branch-candidate-absent"],
		["branch_candidate_duplicate", "duplicate entry id"],
		["branch_candidate_drift", "branch_lineage_branch-candidate-drift"],
	] as const)("does not prompt when Q16 candidate is %s", async (scenario, reason) => {
		const fixture = await setupPublicSdkBranchFixture(scenario);
		try {
			await expect(fixture.runner.run(fixture.turn)).rejects.toThrow(reason);
			expectSdkRequest(fixture.server.frames, "query_request", "session.branch_candidates");
			expect(
				fixture.server.frames.some(
					frame => frame.type === "control_request" && frame.operation === "session.branch",
				),
			).toBe(false);
			expect(
				fixture.server.frames.some(frame => frame.type === "control_request" && frame.operation === "turn.prompt"),
			).toBe(false);
		} finally {
			fixture.dispose();
		}
	});

	test("does not query Q16 or prompt when authenticated branch lineage mismatches", async () => {
		const fixture = await setupPublicSdkBranchFixture("branch_regenerate");
		try {
			await expect(
				fixture.runner.run({
					...fixture.turn,
					messageMetadata: {
						gjc_adapter: {
							ownerUserId: "owner-q16",
							projectId: fixture.project.id,
							gjcSessionId: "sdk-session-created",
							gjcEntryId: "entry-q16",
							openwebuiMessageId: "other-message",
						},
					},
				}),
			).rejects.toThrow("branch_lineage_message-entry-mismatch");
			expect(
				fixture.server.frames.some(
					frame => frame.type === "query_request" && frame.query === "session.branch_candidates",
				),
			).toBe(false);
			expect(
				fixture.server.frames.some(frame => frame.type === "control_request" && frame.operation === "turn.prompt"),
			).toBe(false);
		} finally {
			fixture.dispose();
		}
	});
});
test("reuses a live published endpoint from a file-backed restart without invoking the CLI", async () => {
	const root = mkdtempSync(join(tmpdir(), "gjc-endpoint-restart-"));
	const sessionRoot = join(root, ".gjc", "sessions");
	const endpointRoot = join(root, ".gjc", "state", "sdk");
	const sessionFile = join(sessionRoot, "session-live.jsonl");
	const mappingFile = join(root, "mappings.json");
	mkdirSync(sessionRoot, { recursive: true });
	mkdirSync(endpointRoot, { recursive: true });
	writeFileSync(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: "session-live", timestamp: "2026-01-01T00:00:00.000Z", cwd: root })}\n`,
	);
	let metadataQueries = 0;
	const server = Bun.serve({
		port: 0,
		fetch(request, bunServer) {
			return bunServer.upgrade(request) ? undefined : new Response("upgrade required", { status: 426 });
		},
		websocket: {
			open(socket) {
				socket.send(JSON.stringify({ type: "server_hello", protocolVersion: 3, connectionId: "restart-fixture" }));
			},
			message(socket, message) {
				const frame = JSON.parse(String(message)) as { type: string; id: string; query?: string };
				if (frame.type !== "query_request") return;
				if (frame.query === "session.metadata") {
					metadataQueries += 1;
					socket.send(
						JSON.stringify({
							type: "query_response",
							id: frame.id,
							ok: true,
							page: { items: [{ sessionId: "session-live", cwd: root }], complete: true },
						}),
					);
					return;
				}
				if (frame.query === "config.list/get") {
					socket.send(
						JSON.stringify({
							type: "query_response",
							id: frame.id,
							ok: true,
							page: {
								items: [
									{
										mode: "default",
										thinking: "medium",
										steeringMode: "all",
										followUpMode: "all",
										interruptMode: "all",
									},
								],
								complete: true,
							},
						}),
					);
					return;
				}
				if (frame.query === "models.list/current") {
					socket.send(
						JSON.stringify({
							type: "query_response",
							id: frame.id,
							ok: true,
							page: {
								items: [
									{
										provider: "anthropic",
										id: "claude-sonnet-4",
										current: true,
										currentThinkingLevel: "medium",
									},
								],
								complete: true,
							},
						}),
					);
				}
			},
		},
	});
	try {
		writeFileSync(
			join(endpointRoot, "session-live.json"),
			JSON.stringify({ version: 1, url: `ws://127.0.0.1:${server.port}`, token: "restart-token" }),
		);
		const first = new FileBackedSessionMappingStore(mappingFile);
		first.set({
			...mappingInput(mediumSelection),
			sessionId: "session-live",
			sessionFile,
		});
		const mapping = new FileBackedSessionMappingStore(mappingFile).get("chat-1");
		if (mapping === undefined) throw new Error("expected persisted mapping");
		const runner = createPublicSdkGjcTurnRunner({
			cliPath: join(root, "missing-gjc-cli"),
			runtimeLocations: {
				childEnvironment: {
					HOME: root,
					GJC_CONFIG_DIR: join(root, ".gjc"),
					GJC_CODING_AGENT_DIR: join(root, ".gjc"),
				},
			} as GjcRuntimeLocations,
			turnTimeoutMs: 1_000,
		});
		await withLifecyclePublication(
			runner,
			{
				cwd: root,
				sessionRoot,
				projectId: mapping.projectId,
				chatId: mapping.chatId,
				sessionId: mapping.sessionId,
				sessionFile: mapping.sessionFile,
			},
			lifecycle =>
				runner.switchSession({
					cwd: root,
					sessionRoot,
					projectId: mapping.projectId,
					chatId: mapping.chatId,
					sessionId: mapping.sessionId,
					sessionFile: mapping.sessionFile,
					lifecycle,
				}),
		);
		expect(metadataQueries).toBe(0);
	} finally {
		server.stop(true);
		rmSync(root, { recursive: true, force: true });
	}
});
test("refreshes a cached attachment when the same session ID endpoint is replaced without a proven close", async () => {
	const root = mkdtempSync(join(tmpdir(), "gjc-runner-cache-eviction-"));
	const sessionId = "sdk-session-created";
	const sessionRoot = join(root, ".gjc", "sessions");
	const endpointRoot = join(root, ".gjc", "state", "sdk");
	const sessionFile = join(sessionRoot, `${sessionId}.jsonl`);
	const firstServer = startSdkFixtureServer("turn_complete", root);
	const secondServer = startSdkFixtureServer("turn_complete", root);
	try {
		mkdirSync(endpointRoot, { recursive: true });
		mkdirSync(sessionRoot, { recursive: true });
		writeFileSync(
			sessionFile,
			`${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: root })}\n`,
		);
		writeFileSync(
			join(endpointRoot, `${sessionId}.json`),
			JSON.stringify({ version: 1, url: firstServer.url, token: firstServer.token }),
		);
		const runner = createPublicSdkGjcTurnRunner({
			cliPath: join(root, "missing-gjc-cli"),
			runtimeLocations: {
				childEnvironment: {
					HOME: root,
					GJC_CONFIG_DIR: join(root, ".gjc"),
					GJC_CODING_AGENT_DIR: join(root, ".gjc"),
				},
			} as GjcRuntimeLocations,
			turnTimeoutMs: 1_000,
		});
		const address = { cwd: root, sessionRoot, projectId: "project", chatId: "chat", sessionId, sessionFile };
		await withLifecyclePublication(runner, address, lifecycle => runner.switchSession({ ...address, lifecycle }));
		const first = await withLifecyclePublication(runner, address, lifecycle =>
			runner.continueSession({
				...address,
				text: "first",
				userMessageId: "first-message",
				rawFrameCursor: 0,
				eventCursor: 0,
				operationId: "first-message",
				lifecycle,
			}),
		);
		unlinkSync(join(endpointRoot, `${sessionId}.json`));
		writeFileSync(
			join(endpointRoot, `${sessionId}.json`),
			JSON.stringify({ version: 1, url: secondServer.url, token: secondServer.token }),
		);
		await withLifecyclePublication(runner, address, lifecycle => runner.switchSession({ ...address, lifecycle }));
		const second = await withLifecyclePublication(runner, address, lifecycle =>
			runner.continueSession({
				...address,
				text: "second",
				userMessageId: "second-message",
				rawFrameCursor: 0,
				eventCursor: 0,
				operationId: "second-message",
				lifecycle,
			}),
		);

		expectSdkRequest(firstServer.frames, "query_request", "session.metadata");
		expectSdkRequest(secondServer.frames, "query_request", "session.metadata");
		expect(first.attachment).toMatchObject({
			expectedSessionId: sessionId,
			expectedCwd: root,
			payloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		expect(second.attachment).toMatchObject({
			expectedSessionId: sessionId,
			expectedCwd: root,
			payloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		expect(second.attachment?.payloadDigest).not.toBe(first.attachment?.payloadDigest);
		expect(first.attachment).not.toHaveProperty("tmuxPane");
		expect(second.attachment).not.toHaveProperty("tmuxPane");
		expect(
			firstServer.frames.filter(frame => frame.type === "control_request" && frame.operation === "turn.prompt"),
		).toHaveLength(1);
		expect(
			secondServer.frames.filter(frame => frame.type === "control_request" && frame.operation === "turn.prompt"),
		).toHaveLength(1);
	} finally {
		firstServer.stop();
		secondServer.stop();
		rmSync(root, { recursive: true, force: true });
	}
});
test("keeps duplicate session IDs isolated across canonical project cwd values in the public SDK runner cache", async () => {
	const root = mkdtempSync(join(tmpdir(), "gjc-runner-cache-isolation-"));
	const firstCwd = join(root, "first");
	const secondCwd = join(root, "second");
	const sessionId = "sdk-session-created";
	const firstServer = startSdkFixtureServer("turn_complete", firstCwd);
	const secondServer = startSdkFixtureServer("turn_complete", secondCwd);
	try {
		for (const [cwd, server] of [
			[firstCwd, firstServer],
			[secondCwd, secondServer],
		] as const) {
			const sessionRoot = join(cwd, ".gjc", "sessions");
			mkdirSync(sessionRoot, { recursive: true });
			mkdirSync(join(cwd, ".gjc", "state", "sdk"), { recursive: true });
			writeFileSync(
				join(sessionRoot, `${sessionId}.jsonl`),
				`${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd })}\n`,
			);
			writeFileSync(
				join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`),
				JSON.stringify({ version: 1, url: server.url, token: server.token }),
			);
		}
		const runner = createPublicSdkGjcTurnRunner({
			cliPath: join(root, "missing-gjc-cli"),
			runtimeLocations: {
				childEnvironment: {
					HOME: root,
					GJC_CONFIG_DIR: join(root, ".gjc"),
					GJC_CODING_AGENT_DIR: join(root, ".gjc"),
				},
			} as GjcRuntimeLocations,
			turnTimeoutMs: 1_000,
		});
		const firstSessionRoot = join(firstCwd, ".gjc", "sessions");
		const secondSessionRoot = join(secondCwd, ".gjc", "sessions");
		const firstSessionFile = join(firstSessionRoot, `${sessionId}.jsonl`);
		const secondSessionFile = join(secondSessionRoot, `${sessionId}.jsonl`);
		const firstAddress = {
			cwd: firstCwd,
			sessionRoot: firstSessionRoot,
			projectId: "first",
			chatId: "first",
			sessionId,
			sessionFile: firstSessionFile,
		};
		await withLifecyclePublication(runner, firstAddress, lifecycle =>
			runner.switchSession({ ...firstAddress, lifecycle }),
		);
		const first = await withLifecyclePublication(runner, firstAddress, lifecycle =>
			runner.continueSession({
				...firstAddress,
				text: "first",
				userMessageId: "first-message",
				rawFrameCursor: 0,
				eventCursor: 0,
				operationId: "first-message",
				lifecycle,
			}),
		);
		const secondAddress = {
			cwd: secondCwd,
			sessionRoot: secondSessionRoot,
			projectId: "second",
			chatId: "second",
			sessionId,
			sessionFile: secondSessionFile,
		};
		await withLifecyclePublication(runner, secondAddress, lifecycle =>
			runner.switchSession({ ...secondAddress, lifecycle }),
		);
		const second = await withLifecyclePublication(runner, secondAddress, lifecycle =>
			runner.continueSession({
				...secondAddress,
				text: "second",
				userMessageId: "second-message",
				rawFrameCursor: 0,
				eventCursor: 0,
				operationId: "second-message",
				lifecycle,
			}),
		);
		expect(first.attachment?.expectedCwd).toBe(firstCwd);
		expect(second.attachment?.expectedCwd).toBe(secondCwd);
		expect(
			firstServer.frames.filter(frame => frame.type === "control_request" && frame.operation === "turn.prompt"),
		).toHaveLength(1);
		expect(
			secondServer.frames.filter(frame => frame.type === "control_request" && frame.operation === "turn.prompt"),
		).toHaveLength(1);
	} finally {
		firstServer.stop();
		secondServer.stop();
		rmSync(root, { recursive: true, force: true });
	}
});

test("retains a generation-bound persisted pane through a live restart and drops it when a same-ID endpoint is replaced", async () => {
	const root = mkdtempSync(join(tmpdir(), "gjc-pane-recovery-barrier-"));
	const sessionId = "same-id";
	const sessionRoot = join(root, ".gjc", "sessions");
	const endpointRoot = join(root, ".gjc", "state", "sdk");
	const sessionFile = join(sessionRoot, `${sessionId}.jsonl`);
	const mappingFile = join(root, "mappings.json");
	const socket = `gjc-barrier-${process.pid}-${Date.now()}`;
	const pane = tmux([
		"-L",
		socket,
		"new-session",
		"-d",
		"-P",
		"-F",
		"#{pane_id}|#{pane_pid}",
		"-s",
		"owned",
		"tail -f /dev/null",
	]);
	const [tmuxPane, panePid] = pane.split("|");
	const owner = "generation-bound-owner";
	const firstUrl = "ws://127.0.0.1:19001";
	const secondUrl = "ws://127.0.0.1:19002";
	try {
		if (tmuxPane === undefined || panePid === undefined) throw new Error("tmux did not return an owned pane");
		tmux(["-L", socket, "set-option", "-p", "-t", tmuxPane, "@openwebui_gjc_owner", owner]);
		mkdirSync(endpointRoot, { recursive: true });
		mkdirSync(sessionRoot, { recursive: true });
		writeFileSync(
			sessionFile,
			`${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: root })}\n`,
		);
		const descriptorPath = join(endpointRoot, `${sessionId}.json`);
		const firstDescriptor = JSON.stringify({ version: 1, url: firstUrl, token: "first", pid: Number(panePid) });
		writeFileSync(descriptorPath, firstDescriptor);
		const stat = await Bun.file(descriptorPath).stat();
		const mappings = new FileBackedSessionMappingStore(mappingFile);
		mappings.set({
			...mappingInput(mediumSelection),
			sessionId,
			sessionFile,
			attachment: {
				descriptorPath,
				descriptorStat: { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs },
				payloadDigest: createHash("sha256").update(firstDescriptor).digest("hex"),
				generation: stat.mtimeMs,
				expectedSessionId: sessionId,
				expectedCwd: root,
				tmuxSocket: socket,
				tmuxPane,
				tmuxPanePid: Number(panePid),
				tmuxOwnershipTag: owner,
				ownedAt: "2026-01-01T00:00:00.000Z",
			},
		});
		const runnerInput = {
			cliPath: join(root, "missing-gjc-cli"),
			runtimeLocations: {
				childEnvironment: {
					HOME: root,
					GJC_CONFIG_DIR: join(root, ".gjc"),
					GJC_CODING_AGENT_DIR: join(root, ".gjc"),
				},
			} as GjcRuntimeLocations,
			turnTimeoutMs: 1_000,
			sessionPortFactory: () =>
				({
					async attach() {},
					detach() {},
					async getState() {
						return {
							sessionId,
							model: { provider: "anthropic", id: "claude-sonnet-4" },
							thinkingLevel: "medium",
						};
					},
					async prompt() {
						return { events: [], finalizedAssistantText: "durable" };
					},
				}) as any,
		};
		const first = createGjcRoutingLiveGatewayRunner({
			turnRunner: createPublicSdkGjcTurnRunner(runnerInput),
			mappings,
		});
		await first.run({ ...turn("chat-1", "pane-first", true), project: { ...project, cwd: root, sessionRoot } });
		const retained = new FileBackedSessionMappingStore(mappingFile).get("chat-1")?.attachment;
		expect(retained).toMatchObject({
			tmuxPane,
			tmuxPanePid: Number(panePid),
			tmuxOwnershipTag: owner,
			payloadDigest: createHash("sha256").update(firstDescriptor).digest("hex"),
		});

		unlinkSync(descriptorPath);
		const secondDescriptor = JSON.stringify({
			version: 1,
			url: secondUrl,
			token: "second",
			pid: Number(panePid) + 1,
		});
		writeFileSync(descriptorPath, secondDescriptor);
		const restartedMappings = new FileBackedSessionMappingStore(mappingFile);
		const restarted = createGjcRoutingLiveGatewayRunner({
			turnRunner: createPublicSdkGjcTurnRunner(runnerInput),
			mappings: restartedMappings,
		});
		await restarted.run({ ...turn("chat-1", "pane-second", true), project: { ...project, cwd: root, sessionRoot } });
		const replaced = new FileBackedSessionMappingStore(mappingFile).get("chat-1")?.attachment;
		expect(replaced?.payloadDigest).toBe(createHash("sha256").update(secondDescriptor).digest("hex"));
		expect(replaced).not.toHaveProperty("tmuxPane");
		expect(replaced).not.toHaveProperty("tmuxPanePid");
		expect(replaced).not.toHaveProperty("tmuxOwnershipTag");
	} finally {
		tmux(["-L", socket, "kill-server"], false);
		rmSync(root, { recursive: true, force: true });
	}
});

test.each([
	"post_mutation_pre_proof",
	"pre_durable_publication",
] as const)("rejects stale public SDK work at %s without a durable result", async phase => {
	const fixture = setupPublicRunnerBarrierFixture(phase);
	try {
		await withLifecyclePublication(fixture.runner, fixture.address, lifecycle =>
			fixture.runner.switchSession({ ...fixture.address, lifecycle }),
		);
		const continued = withLifecyclePublication(fixture.runner, fixture.address, async lifecycle => {
			const result = await fixture.runner.continueSession({
				...fixture.address,
				text: phase,
				userMessageId: phase,
				rawFrameCursor: 0,
				eventCursor: 0,
				operationId: phase,
				lifecycle,
			});
			if (phase === "pre_durable_publication") {
				if (result.attachment === undefined)
					throw new Error("expected an attachment proof for durable publication");
				await lifecycle.publish(result.attachment, () => undefined);
			}
		});
		await expect(continued).rejects.toThrow("endpoint descriptor");
		expect(fixture.hits).toBe(1);
		expect(
			fixture.server.frames.filter(frame => frame.type === "control_request" && frame.operation === "turn.prompt"),
		).toHaveLength(1);
	} finally {
		fixture.dispose();
	}
});
test("rejects a close commit when its public SDK descriptor changes after proof", async () => {
	const fixture = setupPublicRunnerBarrierFixture("post_close_proof_pre_commit");
	try {
		await withLifecyclePublication(fixture.runner, fixture.address, lifecycle =>
			fixture.runner.switchSession({ ...fixture.address, lifecycle }),
		);
		const close = withLifecyclePublication(fixture.runner, fixture.address, async lifecycle => {
			const result = await fixture.runner.continueSession({
				...fixture.address,
				text: "close",
				userMessageId: "close",
				rawFrameCursor: 0,
				eventCursor: 0,
				operationId: "close",
				lifecycle,
			});
			if (result.attachment === undefined) throw new Error("expected a close attachment proof");
			await lifecycle.publishClosed(lifecycle.assertClosePreflight(result.attachment), () => undefined);
		});
		await expect(close).rejects.toThrow("Close preflight proof");
	} finally {
		fixture.dispose();
	}
});
test("applies released model selection responses across fresh and continuation turns", async () => {
	const root = mkdtempSync(join(tmpdir(), "gjc-first-turn-continuation-"));
	const sessionRoot = join(root, ".gjc", "sessions");
	const mappingFile = join(root, "mappings.json");
	const server = startSdkFixtureServer("model_catalog", root);
	try {
		writeFileSync(
			join(root, "gjc-sdk-fixture.json"),
			JSON.stringify({
				GJC_SDK_FIXTURE_CLI_TRANSCRIPT: join(root, "sdk-cli.jsonl"),
				GJC_SDK_FIXTURE_ENDPOINT_URL: server.url,
				GJC_SDK_FIXTURE_ENDPOINT_TOKEN: server.token,
				GJC_SDK_FIXTURE_DYNAMIC_AUTHORITY: "1",
			}),
		);
		const runner = createGjcRoutingLiveGatewayRunner({
			turnRunner: createPublicSdkGjcTurnRunner({
				cliPath: join(import.meta.dir, "fixtures", "gjc-sdk-interactive-cli-session-fixture.ts"),
				runtimeLocations: {
					childEnvironment: {
						HOME: root,
						GJC_CONFIG_DIR: join(root, ".gjc"),
						GJC_CODING_AGENT_DIR: join(root, ".gjc"),
					},
				} as GjcRuntimeLocations,
				turnTimeoutMs: 1_000,
			}),
			mappings: new FileBackedSessionMappingStore(mappingFile),
			requestedModelId: () => "gjc/anthropic/claude-sonnet-4:medium",
			modelReaderFactory: staticModelReaderFactory(),
		});
		const firstTurn = {
			project: { ...project, cwd: root, sessionRoot },
			prompt: "first",
			chatId: "same-session",
			messageId: "assistant-first",
			userMessageId: "user-first",
			userMessageParentId: null,
			continued: false,
		};
		await runner.run(firstTurn);
		const persisted = new FileBackedSessionMappingStore(mappingFile).get("same-session");
		expect(persisted?.sessionFile).toMatch(new RegExp(`^${sessionRoot}/[^/]+\\.jsonl$`));
		expect(persisted?.sessionFile).toBeDefined();
		await runner.run({
			...firstTurn,
			prompt: "second",
			messageId: "assistant-second",
			userMessageId: "user-second",
			userMessageParentId: "assistant-first",
			continued: true,
		});
		expect(
			server.frames.filter(frame => frame.type === "control_request" && frame.operation === "turn.prompt"),
		).toHaveLength(2);
		expect(
			server.frames.filter(frame => frame.type === "control_request" && frame.operation === "model.set"),
		).toHaveLength(2);
		expect(
			server.frames.filter(frame => frame.type === "control_request" && frame.operation === "thinking.set"),
		).toHaveLength(2);
		expect(
			server.frames.filter(frame => frame.type === "query_request" && frame.query === "models.list/current"),
		).toHaveLength(0);
		expect(readFileSync(join(root, "sdk-cli.jsonl"), "utf8")).toContain('"interactive":"create"');
	} finally {
		server.stop();
		rmSync(root, { recursive: true, force: true });
	}
});
test("fails closed when a newly published CLI endpoint disappears before public SDK binding", async () => {
	const root = mkdtempSync(join(tmpdir(), "gjc-post-cli-pre-bind-"));
	const sessionRoot = join(root, ".gjc", "sessions");
	const mappingFile = join(root, "mappings.json");
	const server = startSdkFixtureServer("turn_complete", root);
	let sessionId: string | undefined;
	let barrierHits = 0;
	let releaseBarrier: (() => void) | undefined;
	let barrierReached: (() => void) | undefined;
	const released = new Promise<void>(resolve => {
		releaseBarrier = resolve;
	});
	const reached = new Promise<void>(resolve => {
		barrierReached = resolve;
	});
	try {
		writeFileSync(
			join(root, "gjc-sdk-fixture.json"),
			JSON.stringify({
				GJC_SDK_FIXTURE_CLI_TRANSCRIPT: join(root, "sdk-cli.jsonl"),
				GJC_SDK_FIXTURE_ENDPOINT_URL: server.url,
				GJC_SDK_FIXTURE_ENDPOINT_TOKEN: server.token,
				GJC_SDK_FIXTURE_DYNAMIC_AUTHORITY: "1",
			}),
		);
		const publicRunner = createPublicSdkGjcTurnRunner({
			cliPath: join(import.meta.dir, "fixtures", "gjc-sdk-interactive-cli-session-fixture.ts"),
			runtimeLocations: {
				childEnvironment: {
					HOME: root,
					GJC_CONFIG_DIR: join(root, ".gjc"),
					GJC_CODING_AGENT_DIR: join(root, ".gjc"),
				},
			} as GjcRuntimeLocations,
			turnTimeoutMs: 1_000,
			testBarrierHook: async (phase, evidence) => {
				expect(phase).toBe("post_cli_pre_bind");
				barrierHits += 1;
				sessionId = evidence.sessionId;
				unlinkSync(join(evidence.cwd, ".gjc", "state", "sdk", `${evidence.sessionId}.json`));
				if (barrierReached === undefined) throw new Error("post-CLI barrier was not initialized");
				barrierReached();
				await released;
			},
		});
		const runner = createGjcRoutingLiveGatewayRunner({
			turnRunner: publicRunner,
			mappings: new FileBackedSessionMappingStore(mappingFile),
		});
		const started = runner.run({
			...turn("post-cli-pre-bind", "post-cli-pre-bind"),
			project: { ...project, cwd: root, sessionRoot },
		});
		await reached;
		if (releaseBarrier === undefined) throw new Error("post-CLI barrier release was not initialized");
		releaseBarrier();
		await expect(started).rejects.toThrow("endpoint descriptor");
		if (sessionId === undefined) throw new Error("post-CLI barrier did not report a session id");
		expect(barrierHits).toBe(1);
		expect(new FileBackedSessionMappingStore(mappingFile).get("post-cli-pre-bind")).toBeUndefined();
		expect(await Bun.file(join(root, ".gjc", "state", "sdk", `${sessionId}.json`)).exists()).toBe(false);
		expect(readFileSync(mappingFile, "utf8")).not.toContain("tmuxPane");
		expect(readFileSync(join(root, "sdk-cli.jsonl"), "utf8")).toContain('"interactive":"create"');
		expect(server.frames.some(frame => frame.type === "control_request" && frame.operation === "turn.prompt")).toBe(
			false,
		);
	} finally {
		server.stop();
		rmSync(root, { recursive: true, force: true });
	}
});

const lowSelection = { provider: "anthropic", modelId: "claude-sonnet-4", thinkingLevel: "low" } as const;
const mediumSelection = { ...lowSelection, thinkingLevel: "medium" } as const;

async function withLifecyclePublication<T>(
	runner: GjcTurnRunner,
	address: GjcLifecyclePublicationAddress,
	effect: (lifecycle: GjcLifecycleTransaction) => Promise<T>,
): Promise<T> {
	if (runner.withLifecyclePublication === undefined) throw new Error("GJC runner must provide lifecycle publication.");
	return runner.withLifecyclePublication(address, effect);
}
function mappingInput(modelSelection: NormalizedModelSelection) {
	return {
		chatId: "chat-1",
		projectId: project.id,
		sessionId: "session-1",
		sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
		rawFrameCursor: 0,
		eventCursor: 0,
		operationId: "user-1",
		modelSelection,
	};
}
function validAuthorityDocument(): any {
	const timestamp = "2026-01-01T00:00:00.000Z";
	const mapping = {
		version: 2,
		chatId: "chat-1",
		projectId: project.id,
		sessionId: "session-1",
		createdAt: timestamp,
		header: { chatId: "chat-1", projectId: project.id, sessionId: "session-1" },
		rawFrameCursor: 0,
		eventCursor: 0,
		operationId: "operation-1",
		events: [{ type: "assistant", text: "done", payload: { nested: ["value"] } }],
		modelSelection: { ...mediumSelection },
		attachment: {
			descriptorPath: "/workspace/.gjc/endpoints/session-1.json",
			descriptorStat: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
			payloadDigest: "0000000000000000000000000000000000000000000000000000000000000000",
			generation: 4,
			expectedSessionId: "session-1",
			expectedCwd: "/workspace",
		},
		journal: [
			{
				id: "operation-1",
				kind: "prompt",
				state: "complete",
				startedAt: timestamp,
				completedAt: timestamp,
				result: {
					kind: "turn",
					assistantText: "done",
					events: [{ type: "assistant", text: "done" }],
					mapping: {
						chatId: "chat-1",
						projectId: project.id,
						sessionId: "session-1",
						rawFrameCursor: 0,
						eventCursor: 0,
						operationId: "operation-1",
					},
				},
			},
		],
	};
	return {
		kind: "openwebui-gjc-session-authority",
		version: 2,
		mappings: [mapping],
		provisionalOperations: [
			{
				id: "operation-2",
				kind: "create",
				state: "pending",
				startedAt: timestamp,
				chatId: "chat-2",
				projectId: project.id,
			},
		],
	};
}

function withFileStore(run: (store: FileBackedSessionMappingStore, filePath: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "gjc-selection-mapping-"));
	const filePath = join(root, "mappings.json");
	try {
		run(new FileBackedSessionMappingStore(filePath), filePath);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function neutralReader(transcript: string[]) {
	return {
		async getAvailableModels() {
			transcript.push("catalog");
			return [
				{
					provider: "anthropic",
					id: "claude-sonnet-4",
					reasoning: true,
					thinking: { validLevels: ["off", "low", "medium"] },
				},
			];
		},
		async getState() {
			transcript.push("state");
			return { model: { provider: "anthropic", id: "claude-sonnet-4" }, thinkingLevel: "low" };
		},
		stop() {
			transcript.push("stop");
		},
	};
}

function turn(chatId: string, userMessageId: string, continued = false) {
	return {
		project,
		prompt: "hello",
		chatId,
		messageId: `assistant-${userMessageId}`,
		userMessageId,
		userMessageParentId: null,
		continued,
	};
}
function setupPublicSdkBranchFixture(scenario: SdkFixtureScenario, routingBarrierHook?: GjcLifecycleTestBarrierHook) {
	const root = mkdtempSync(join(tmpdir(), "gjc-public-sdk-branch-"));
	const sessionRoot = join(root, ".gjc", "sessions");
	const endpointRoot = join(root, ".gjc", "state", "sdk");
	const mappingFile = join(root, "mappings.json");
	const predecessorPath = join(sessionRoot, "sdk-session-created.jsonl");
	mkdirSync(sessionRoot, { recursive: true });
	mkdirSync(endpointRoot, { recursive: true });
	writeFileSync(
		predecessorPath,
		`${JSON.stringify({ type: "session", version: 3, id: "sdk-session-created", timestamp: "2026-01-01T00:00:00.000Z", cwd: root })}\n`,
	);
	const previousRoot = process.env.GJC_SDK_FIXTURE_BRANCH_ROOT;
	const previousMapping = process.env.GJC_SDK_FIXTURE_MAPPING_FILE;
	const previousCwd = process.env.GJC_SDK_FIXTURE_EXPECTED_CWD;
	process.env.GJC_SDK_FIXTURE_BRANCH_ROOT = root;
	process.env.GJC_SDK_FIXTURE_MAPPING_FILE = mappingFile;
	process.env.GJC_SDK_FIXTURE_EXPECTED_CWD = root;
	const server = startSdkFixtureServer(scenario);
	writeFileSync(
		join(endpointRoot, "sdk-session-created.json"),
		JSON.stringify({ version: 1, url: server.url, token: server.token }),
	);
	const branchProject = { ...project, cwd: root, sessionRoot };
	const mappings = new FileBackedSessionMappingStore(mappingFile);
	mappings.set({
		...mappingInput(mediumSelection),
		chatId: "chat-q16",
		projectId: branchProject.id,
		sessionId: "sdk-session-created",
		sessionFile: predecessorPath,
		operationId: "predecessor-q16",
		modelSelection: undefined,
	});
	const runnerInput = {
		cliPath: join(root, "missing-gjc-cli"),
		runtimeLocations: {
			childEnvironment: { HOME: root, GJC_CONFIG_DIR: join(root, ".gjc"), GJC_CODING_AGENT_DIR: join(root, ".gjc") },
		} as GjcRuntimeLocations,
		turnTimeoutMs: 1_000,
	};
	const runner = createGjcRoutingLiveGatewayRunner({
		turnRunner: createPublicSdkGjcTurnRunner(runnerInput),
		mappings,
		ownerUserId: "owner-q16",
		testBarrierHook: routingBarrierHook,
	});
	return {
		server,
		runner,
		runnerInput,
		mappingFile,
		project: branchProject,
		successorPath: join(sessionRoot, "sdk-session-successor.jsonl"),
		turn: {
			project: branchProject,
			prompt: "branch successor",
			chatId: "chat-q16",
			messageId: "assistant-q16",
			userMessageId: "branch-q16",
			userMessageParentId: "assistant-q16",
			continued: true,
			ownerUserId: "owner-q16",
			control: { operation: "branch" as const },
			messageMetadata: {
				gjc_adapter: {
					ownerUserId: "owner-q16",
					projectId: branchProject.id,
					gjcSessionId: "sdk-session-created",
					gjcEntryId: "entry-q16",
					openwebuiMessageId: "assistant-q16",
				},
			},
		},
		dispose() {
			server.stop();
			rmSync(root, { recursive: true, force: true });
			restoreEnv("GJC_SDK_FIXTURE_BRANCH_ROOT", previousRoot);
			restoreEnv("GJC_SDK_FIXTURE_MAPPING_FILE", previousMapping);
			restoreEnv("GJC_SDK_FIXTURE_EXPECTED_CWD", previousCwd);
		},
	};
}

function setupPublicRunnerBarrierFixture(
	phase: "post_mutation_pre_proof" | "pre_durable_publication" | "post_close_proof_pre_commit",
): {
	readonly runner: ReturnType<typeof createPublicSdkGjcTurnRunner>;
	readonly address: {
		readonly cwd: string;
		readonly sessionRoot: string;
		readonly projectId: string;
		readonly chatId: string;
		readonly sessionId: string;
		readonly sessionFile: string;
	};
	readonly server: SdkFixtureServer;
	readonly hits: number;
	readonly dispose: () => void;
} {
	const root = mkdtempSync(join(tmpdir(), "gjc-public-runner-barrier-"));
	const sessionId = "sdk-session-created";
	const sessionRoot = join(root, ".gjc", "sessions");
	const endpointRoot = join(root, ".gjc", "state", "sdk");
	const sessionFile = join(sessionRoot, `${sessionId}.jsonl`);
	const server = startSdkFixtureServer("turn_complete", root);
	let hits = 0;
	mkdirSync(endpointRoot, { recursive: true });
	mkdirSync(sessionRoot, { recursive: true });
	writeFileSync(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: root })}\n`,
	);
	writeFileSync(
		join(endpointRoot, `${sessionId}.json`),
		JSON.stringify({ version: 1, url: server.url, token: server.token }),
	);
	const runner = createPublicSdkGjcTurnRunner({
		cliPath: join(root, "missing-gjc-cli"),
		runtimeLocations: {
			childEnvironment: { HOME: root, GJC_CONFIG_DIR: join(root, ".gjc"), GJC_CODING_AGENT_DIR: join(root, ".gjc") },
		} as GjcRuntimeLocations,
		turnTimeoutMs: 1_000,
		testBarrierHook: observed => {
			if (observed !== phase) return;
			hits += 1;
			unlinkSync(join(root, ".gjc", "state", "sdk", `${sessionId}.json`));
		},
	});
	return {
		runner,
		address: { cwd: root, sessionRoot, projectId: "barrier", chatId: "barrier", sessionId, sessionFile },
		server,
		get hits() {
			return hits;
		},
		dispose() {
			server.stop();
			rmSync(root, { recursive: true, force: true });
		},
	};
}
function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}
function tmux(args: readonly string[], required = true): string {
	const result = Bun.spawnSync(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
	if (required && result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
	return new TextDecoder().decode(result.stdout).trim();
}
