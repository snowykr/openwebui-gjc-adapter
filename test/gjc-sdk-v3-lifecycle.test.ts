import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GjcRuntimeLocations } from "../src/contracts";
import type { PublicSdkGate, PublicSdkSessionAttachment, PublicSdkSessionPort } from "../src/gjc/public-sdk-contract";
import {
	attachmentFromPublishedSdkEndpoint,
	PublicSdkSessionClient,
	withPublicSdkSessionMutationCoordinator,
} from "../src/gjc/public-sdk-session-port";
import { createModelReaderFactory } from "../src/live/model-reader";

describe("public SDK lifecycle contract", () => {
	test("transport stop detaches without issuing remote session.close", async () => {
		const calls: string[] = [];
		const port = {
			async attach() {
				calls.push("attach");
			},
			detach() {
				calls.push("detach");
			},
			async getAvailableModels() {
				return [];
			},
			async getState() {
				return { sessionId: "session-1", model: { provider: "openai", id: "gpt-5" }, thinkingLevel: "off" };
			},
		} as unknown as PublicSdkSessionPort;
		const factory = createModelReaderFactory({
			cliPath: "/opt/gjc",
			runtimeLocations: {} as GjcRuntimeLocations,
			resolveAttachment: async () => attachment,
			sessionPortFactory: () => port,
		});

		const reader = await factory();
		await reader.stop();

		expect(calls).toEqual(["attach", "detach"]);
	});

	test("public close remains an explicit session-port operation", async () => {
		const calls: string[] = [];
		const port = {
			async closeSession() {
				calls.push("closeSession");
			},
		} as PublicSdkSessionPort;

		await port.closeSession("close-key");

		expect(calls).toEqual(["closeSession"]);
	});
	test("refuses close when its descriptor was replaced while identity query Q14 was pending", async () => {
		const root = mkdtempSync(join(tmpdir(), "gjc-sdk-descriptor-"));
		const descriptorPath = join(root, "session-1.json");
		writeFileSync(descriptorPath, "{}");
		const descriptorStat = await Bun.file(descriptorPath).stat();
		let closeControls = 0;
		let releaseMetadata: (() => void) | undefined;
		let metadataRequested: (() => void) | undefined;
		const metadataPending = new Promise<void>(resolve => {
			metadataRequested = resolve;
		});
		const metadataReleased = new Promise<void>(resolve => {
			releaseMetadata = resolve;
		});
		const server = Bun.serve({
			port: 0,
			fetch(request, bunServer) {
				return bunServer.upgrade(request, { data: undefined })
					? undefined
					: new Response("upgrade required", { status: 426 });
			},
			websocket: {
				open(socket) {
					socket.send(JSON.stringify({ type: "server_hello", protocolVersion: 3, connectionId: "test" }));
				},
				async message(socket, message) {
					const frame = JSON.parse(String(message)) as {
						type: string;
						id: string;
						query?: string;
						operation?: string;
					};
					if (frame.type === "query_request" && frame.query === "session.metadata") {
						metadataRequested?.();
						await metadataReleased;
						socket.send(
							JSON.stringify({
								type: "query_response",
								id: frame.id,
								ok: true,
								page: { items: [{ sessionId: "session-1", cwd: "/workspace" }], complete: true },
							}),
						);
					}
					if (frame.type === "control_request" && frame.operation === "session.close") closeControls += 1;
				},
			},
		});
		const client = new PublicSdkSessionClient();
		try {
			await client.attach({
				sessionId: "session-1",
				cwd: "/workspace",
				endpoint: { url: `ws://127.0.0.1:${server.port}`, token: "token" },
				authority: {
					descriptorPath,
					descriptorStat: {
						dev: descriptorStat.dev,
						ino: descriptorStat.ino,
						size: descriptorStat.size,
						mtimeMs: descriptorStat.mtimeMs,
					},
					payloadDigest: digest("{}"),
					generation: descriptorStat.mtimeMs,
					expectedSessionId: "session-1",
					expectedCwd: "/workspace",
				},
			});
			const close = client.closeSession(undefined, 1_000);
			await metadataPending;
			const replacement = join(root, "replacement.json");
			writeFileSync(replacement, '{"replaced":true}');
			renameSync(replacement, descriptorPath);
			releaseMetadata?.();
			await expect(close).rejects.toThrow("descriptor changed");
			expect(closeControls).toBe(0);
		} finally {
			client.detach();
			server.stop(true);
			rmSync(root, { recursive: true, force: true });
		}
	});
	test("refuses prompt when its descriptor is replaced while identity query Q14 is pending", async () => {
		await expectDescriptorReplacementBlocksControl(client => client.prompt("blocked prompt", 1_000));
	});
	test("refuses a representative gate reply when its descriptor is replaced while identity query Q14 is pending", async () => {
		const gate: PublicSdkGate = {
			gateId: "gate-1",
			correlation: { sessionId: "session-1", commandId: "command-1", turnId: "turn-1" },
			payload: {},
		};
		await expectDescriptorReplacementBlocksControl(client =>
			client.answerGate(gate, { approved: true }, undefined, 1_000),
		);
	});
	test("refuses abort and steer after their acknowledged control replaces the descriptor before final authority proof", async () => {
		await expectDescriptorReplacementAfterControl(client => client.abort("abort-key", 1_000), "turn.abort");
		await expectDescriptorReplacementAfterControl(
			client => client.steer("replacement-safe steer", "steer-key", 1_000),
			"turn.steer",
		);
	});
	test("coordinates three owners FIFO, permits owner reentry, and releases after a thrown effect", async () => {
		const scope = { cwd: "/workspace", sessionId: "coordinated-session" };
		const firstOwner = {};
		const secondOwner = {};
		const thirdOwner = {};
		const order: string[] = [];
		let releaseFirst: (() => void) | undefined;
		let releaseSecond: (() => void) | undefined;
		const firstHeld = new Promise<void>(resolve => {
			releaseFirst = resolve;
		});
		const secondHeld = new Promise<void>(resolve => {
			releaseSecond = resolve;
		});
		let firstStarted: (() => void) | undefined;
		let secondStarted: (() => void) | undefined;
		const firstStartedPromise = new Promise<void>(resolve => {
			firstStarted = resolve;
		});
		const secondStartedPromise = new Promise<void>(resolve => {
			secondStarted = resolve;
		});

		const first = withPublicSdkSessionMutationCoordinator(scope, firstOwner, async () => {
			order.push("first");
			firstStarted?.();
			await withPublicSdkSessionMutationCoordinator(scope, firstOwner, async () => {
				order.push("first-reentry");
			});
			await firstHeld;
		});
		await firstStartedPromise;
		const second = withPublicSdkSessionMutationCoordinator(scope, secondOwner, async () => {
			order.push("second");
			secondStarted?.();
			await secondHeld;
		});
		const third = withPublicSdkSessionMutationCoordinator(scope, thirdOwner, async () => {
			order.push("third");
		});

		expect(order).toEqual(["first", "first-reentry"]);
		releaseFirst?.();
		await secondStartedPromise;
		expect(order).toEqual(["first", "first-reentry", "second"]);
		releaseSecond?.();
		await Promise.all([first, second, third]);
		expect(order).toEqual(["first", "first-reentry", "second", "third"]);

		await expect(
			withPublicSdkSessionMutationCoordinator(scope, firstOwner, async () => {
				throw new Error("effect failed");
			}),
		).rejects.toThrow("effect failed");
		await withPublicSdkSessionMutationCoordinator(scope, secondOwner, async () => {
			order.push("after-throw");
		});
		expect(order.at(-1)).toBe("after-throw");
	});
	test("sends the transcript path in the released resume and switch id wire field", async () => {
		await expectLifecycleWireInput("session.resume", "resumed");
		await expectLifecycleWireInput("session.switch", "switched");
	});
	test("fails closed when a lifecycle target endpoint generation is unchanged after acknowledgement", async () => {
		await expectLifecycleWireInput("session.resume", "resumed", "unchanged");
		await expectLifecycleWireInput("session.switch", "switched", "unchanged");
	});
	test("rejects missing lifecycle session identity or transcript path before issuing a control", async () => {
		await expectMissingLifecycleTargetBlocksControl("session.resume");
		await expectMissingLifecycleTargetBlocksControl("session.switch");
	});
	test("fails closed when a lifecycle successor metadata identity differs from the expected target", async () => {
		await expectLifecycleSuccessorMismatch("session.resume", "resumed");
		await expectLifecycleSuccessorMismatch("session.switch", "switched");
	});
});

const attachment: PublicSdkSessionAttachment = {
	sessionId: "session-1",
	cwd: "/workspace",
	endpoint: { url: "ws://127.0.0.1:3000", token: "token" },
};
async function expectDescriptorReplacementBlocksControl(
	invoke: (client: PublicSdkSessionClient) => Promise<unknown>,
): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "gjc-sdk-descriptor-"));
	const descriptorPath = join(root, "session-1.json");
	writeFileSync(descriptorPath, "{}");
	const descriptorStat = await Bun.file(descriptorPath).stat();
	let controls = 0;
	let releaseMetadata: (() => void) | undefined;
	let metadataRequested: (() => void) | undefined;
	const metadataPending = new Promise<void>(resolve => {
		metadataRequested = resolve;
	});
	const metadataReleased = new Promise<void>(resolve => {
		releaseMetadata = resolve;
	});
	const server = Bun.serve({
		port: 0,
		fetch(request, bunServer) {
			return bunServer.upgrade(request, { data: undefined })
				? undefined
				: new Response("upgrade required", { status: 426 });
		},
		websocket: {
			open(socket) {
				socket.send(JSON.stringify({ type: "server_hello", protocolVersion: 3, connectionId: "test" }));
			},
			async message(socket, message) {
				const frame = JSON.parse(String(message)) as { type: string; id: string; query?: string };
				if (frame.type === "query_request" && frame.query === "workflow.gates.list") {
					socket.send(
						JSON.stringify({
							type: "query_response",
							id: frame.id,
							ok: true,
							page: { items: [], complete: true },
						}),
					);
				}
				if (frame.type === "query_request" && frame.query === "session.metadata") {
					metadataRequested?.();
					await metadataReleased;
					socket.send(
						JSON.stringify({
							type: "query_response",
							id: frame.id,
							ok: true,
							page: { items: [{ sessionId: "session-1", cwd: "/workspace" }], complete: true },
						}),
					);
				}
				if (frame.type === "control_request") controls += 1;
			},
		},
	});
	const client = new PublicSdkSessionClient();
	try {
		await client.attach({
			sessionId: "session-1",
			cwd: "/workspace",
			endpoint: { url: `ws://127.0.0.1:${server.port}`, token: "token" },
			authority: {
				descriptorPath,
				descriptorStat: {
					dev: descriptorStat.dev,
					ino: descriptorStat.ino,
					size: descriptorStat.size,
					mtimeMs: descriptorStat.mtimeMs,
				},
				payloadDigest: digest("{}"),
				generation: descriptorStat.mtimeMs,
				expectedSessionId: "session-1",
				expectedCwd: "/workspace",
			},
		});
		const mutation = invoke(client);
		await metadataPending;
		const replacement = join(root, "replacement.json");
		writeFileSync(replacement, '{"replaced":true}');
		renameSync(replacement, descriptorPath);
		releaseMetadata?.();
		await expect(mutation).rejects.toThrow("descriptor changed");
		expect(controls).toBe(0);
	} finally {
		client.detach();
		server.stop(true);
		rmSync(root, { recursive: true, force: true });
	}
}
async function expectDescriptorReplacementAfterControl(
	invoke: (client: PublicSdkSessionClient) => Promise<unknown>,
	operation: string,
): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "gjc-sdk-post-control-descriptor-"));
	const descriptorPath = join(root, "session-1.json");
	writeFileSync(descriptorPath, "{}");
	const descriptorStat = await Bun.file(descriptorPath).stat();
	const controls: string[] = [];
	const server = Bun.serve({
		port: 0,
		fetch(request, bunServer) {
			return bunServer.upgrade(request, { data: undefined })
				? undefined
				: new Response("upgrade required", { status: 426 });
		},
		websocket: {
			open(socket) {
				socket.send(JSON.stringify({ type: "server_hello", protocolVersion: 3, connectionId: "test" }));
			},
			message(socket, message) {
				const frame = JSON.parse(String(message)) as {
					type: string;
					id: string;
					query?: string;
					operation?: string;
				};
				if (frame.type === "query_request" && frame.query === "session.metadata") {
					socket.send(
						JSON.stringify({
							type: "query_response",
							id: frame.id,
							ok: true,
							page: { items: [{ sessionId: "session-1", cwd: "/workspace" }], complete: true },
						}),
					);
					return;
				}
				if (frame.type === "control_request") {
					controls.push(frame.operation ?? "");
					const replacement = join(root, "replacement.json");
					writeFileSync(replacement, '{"replaced":true}');
					renameSync(replacement, descriptorPath);
					socket.send(
						JSON.stringify({ type: "control_response", id: frame.id, ok: true, result: { accepted: true } }),
					);
				}
			},
		},
	});
	const client = new PublicSdkSessionClient();
	try {
		await client.attach({
			sessionId: "session-1",
			cwd: "/workspace",
			endpoint: { url: `ws://127.0.0.1:${server.port}`, token: "token" },
			authority: {
				descriptorPath,
				descriptorStat: {
					dev: descriptorStat.dev,
					ino: descriptorStat.ino,
					size: descriptorStat.size,
					mtimeMs: descriptorStat.mtimeMs,
				},
				payloadDigest: digest("{}"),
				generation: descriptorStat.mtimeMs,
				expectedSessionId: "session-1",
				expectedCwd: "/workspace",
			},
		});
		await expect(invoke(client)).rejects.toThrow("descriptor changed");
		expect(controls).toEqual([operation]);
	} finally {
		client.detach();
		server.stop(true);
		rmSync(root, { recursive: true, force: true });
	}
}
async function expectLifecycleWireInput(
	operation: "session.resume" | "session.switch",
	acknowledgement: "resumed" | "switched",
	outcome: "success" | "mismatch" | "unchanged" = "success",
): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "gjc-sdk-lifecycle-wire-"));
	const stateDirectory = join(root, ".gjc", "state", "sdk");
	mkdirSync(stateDirectory, { recursive: true });
	const sourceSessionId = "source-session";
	const targetSessionId = "target-session";
	const targetSessionPath = join(root, "sessions", `${targetSessionId}.jsonl`);
	mkdirSync(join(root, "sessions"), { recursive: true });
	writeFileSync(targetSessionPath, JSON.stringify({ id: targetSessionId }));
	let receivedInput: unknown;
	const targetServer = Bun.serve({
		port: 0,
		fetch(request, server) {
			return server.upgrade(request, { data: undefined })
				? undefined
				: new Response("upgrade required", { status: 426 });
		},
		websocket: {
			open(socket) {
				socket.send(JSON.stringify({ type: "server_hello", protocolVersion: 3, connectionId: "target" }));
			},
			message(socket, message) {
				const frame = JSON.parse(String(message)) as { type: string; id: string; query?: string };
				if (frame.type === "query_request" && frame.query === "session.metadata")
					socket.send(
						JSON.stringify({
							type: "query_response",
							id: frame.id,
							ok: true,
							page: {
								items: [{ sessionId: outcome === "mismatch" ? "wrong-session" : targetSessionId, cwd: root }],
								complete: true,
							},
						}),
					);
			},
		},
	});
	const targetDescriptor = join(stateDirectory, `${targetSessionId}.json`);
	writeFileSync(
		targetDescriptor,
		JSON.stringify({
			sessionId: targetSessionId,
			url: `ws://127.0.0.1:${targetServer.port}`,
			token: "target-token-baseline",
		}),
	);
	const targetDescriptorStat = await Bun.file(targetDescriptor).stat();
	const sourceServer = Bun.serve({
		port: 0,
		fetch(request, server) {
			return server.upgrade(request, { data: undefined })
				? undefined
				: new Response("upgrade required", { status: 426 });
		},
		websocket: {
			open(socket) {
				socket.send(JSON.stringify({ type: "server_hello", protocolVersion: 3, connectionId: "source" }));
			},
			message(socket, message) {
				const frame = JSON.parse(String(message)) as {
					type: string;
					id: string;
					query?: string;
					operation?: string;
					input?: unknown;
				};
				if (frame.type === "query_request" && frame.query === "session.metadata") {
					socket.send(
						JSON.stringify({
							type: "query_response",
							id: frame.id,
							ok: true,
							page: { items: [{ sessionId: sourceSessionId, cwd: root }], complete: true },
						}),
					);
				} else if (frame.type === "control_request" && frame.operation === operation) {
					receivedInput = frame.input;
					socket.send(
						JSON.stringify({
							type: "control_response",
							id: frame.id,
							ok: true,
							result: { [acknowledgement]: true },
						}),
					);
					if (outcome !== "unchanged") {
						const replacement = join(stateDirectory, `${targetSessionId}.replacement.json`);
						writeFileSync(
							replacement,
							JSON.stringify({
								sessionId: targetSessionId,
								url: `ws://127.0.0.1:${targetServer.port}`,
								token: "target-token-successor",
							}),
						);
						renameSync(replacement, targetDescriptor);
					}
				}
			},
		},
	});
	const sourceDescriptor = join(stateDirectory, `${sourceSessionId}.json`);
	writeFileSync(
		sourceDescriptor,
		JSON.stringify({ sessionId: sourceSessionId, url: `ws://127.0.0.1:${sourceServer.port}`, token: "source-token" }),
	);
	const stat = await Bun.file(sourceDescriptor).stat();
	const client = new PublicSdkSessionClient();
	try {
		await client.attach({
			sessionId: sourceSessionId,
			cwd: root,
			endpoint: { url: `ws://127.0.0.1:${sourceServer.port}`, token: "source-token" },
			authority: {
				descriptorPath: sourceDescriptor,
				descriptorStat: { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs },
				payloadDigest: digest(await Bun.file(sourceDescriptor).text()),
				generation: stat.mtimeMs,
				expectedSessionId: sourceSessionId,
				expectedCwd: root,
			},
		});
		const mutation =
			operation === "session.resume"
				? client.resumeSession({ sessionId: targetSessionId, sessionPath: targetSessionPath }, undefined, 1_000)
				: client.switchSession({ sessionId: targetSessionId, sessionPath: targetSessionPath }, undefined, 1_000);
		if (outcome === "mismatch") await expect(mutation).rejects.toThrow("does not match");
		else if (outcome === "unchanged") await expect(mutation).rejects.toThrow("timed out");
		else {
			const successor = await mutation;
			expect(successor.sessionId).toBe(targetSessionId);
			expect(successor.endpoint.token).toBe("target-token-successor");
			expect(successor.authority?.descriptorStat.ino).not.toBe(targetDescriptorStat.ino);
		}
		expect(receivedInput).toEqual({ id: targetSessionPath });
	} finally {
		client.detach();
		sourceServer.stop(true);
		targetServer.stop(true);
		rmSync(root, { recursive: true, force: true });
	}
}

async function expectMissingLifecycleTargetBlocksControl(
	operation: "session.resume" | "session.switch",
): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "gjc-sdk-lifecycle-missing-target-"));
	const stateDirectory = join(root, ".gjc", "state", "sdk");
	mkdirSync(stateDirectory, { recursive: true });
	let controls = 0;
	const server = Bun.serve({
		port: 0,
		fetch(request, bunServer) {
			return bunServer.upgrade(request, { data: undefined })
				? undefined
				: new Response("upgrade required", { status: 426 });
		},
		websocket: {
			open(socket) {
				socket.send(JSON.stringify({ type: "server_hello", protocolVersion: 3, connectionId: "validation" }));
			},
			message(_socket, message) {
				const frame = JSON.parse(String(message)) as { type: string };
				if (frame.type === "control_request") controls += 1;
			},
		},
	});
	const descriptorPath = join(stateDirectory, "session-1.json");
	writeFileSync(
		descriptorPath,
		JSON.stringify({
			version: 1,
			url: `ws://127.0.0.1:${server.port}`,
			token: "token",
		}),
	);
	const client = new PublicSdkSessionClient();
	try {
		await client.attach(
			attachmentFromPublishedSdkEndpoint(root, "session-1", {
				sessionId: "session-1",
				path: descriptorPath,
				url: `ws://127.0.0.1:${server.port}`,
				token: "token",
			}),
		);
		const missingSessionId =
			operation === "session.resume"
				? client.resumeSession({ sessionPath: "/sessions/target.jsonl" })
				: client.switchSession({ sessionPath: "/sessions/target.jsonl" });
		await expect(missingSessionId).rejects.toThrow("sessionId must be a non-empty string");
		const missingSessionPath =
			operation === "session.resume"
				? client.resumeSession({ sessionId: "target-session" })
				: client.switchSession({ sessionId: "target-session" });
		await expect(missingSessionPath).rejects.toThrow("sessionPath must be a non-empty string");
		expect(controls).toBe(0);
	} finally {
		client.detach();
		server.stop(true);
		rmSync(root, { recursive: true, force: true });
	}
}
async function expectLifecycleSuccessorMismatch(
	operation: "session.resume" | "session.switch",
	acknowledgement: "resumed" | "switched",
): Promise<void> {
	await expectLifecycleWireInput(operation, acknowledgement, "mismatch");
}
function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
