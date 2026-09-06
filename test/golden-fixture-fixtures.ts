import type { Message } from "@gajae-code/ai";
import type { SessionEntry, SessionHeader, SessionMessageEntry } from "@gajae-code/coding-agent";
import type {
	GjcContinueSessionInput,
	GjcSessionAddress,
	GjcSessionState,
	GjcSessionStateInput,
	GjcStartNewSessionInput,
	GjcTurnResult,
	GjcTurnRunner,
	ManagedGenerationProof,
	ManagedPreparedTurnAuthority,
	ManagedTurnAuthority,
} from "../src/gjc/turn-runner";
import { lifecycleFixture, managedPreparedAuthority } from "./gjc-lifecycle-fixtures";

export const ownerUserId = "owner-1";
export const createdAt = new Date("2026-07-08T00:00:00.000Z");
export const sseInput = { id: "chatcmpl-golden", created: 1783468800, model: "gjc/golden" };
export const deliveredEvents: { events: readonly { type: string }[] }[] = [];

export function goldenHeader(cwd: string): SessionHeader {
	return {
		type: "session",
		version: 3,
		id: "session-golden",
		title: "Golden session",
		timestamp: "2026-07-08T00:00:00.000Z",
		cwd,
	};
}

export function goldenEntries(): SessionEntry[] {
	return [
		messageEntry("u-root", null, "user", "Register this project"),
		customEntry("migration-v2", "u-root", "migration", { from: "legacy-openwebui-chat" }),
		messageEntry("a-left", "migration-v2", "assistant", "Imported branch"),
		messageEntry("a-right", "u-root", "assistant", "Active branch"),
		customEntry("blob-ref", "a-right", "blob", { bytes: 1048576, path: "blob://cold" }),
		customEntry("cold-spill", "blob-ref", "cold-spill", { reason: "large transcript" }),
		messageEntry("u-leaf", "cold-spill", "user", "Continue live"),
	];
}

export class GoldenTurnRunner implements GjcTurnRunner {
	readonly starts: GjcStartNewSessionInput[] = [];
	readonly continues: GjcContinueSessionInput[] = [];
	readonly states: GjcSessionStateInput[] = [];
	readonly #managedAuthorities = new WeakMap<object, ManagedTurnAuthority>();

	constructor(private readonly sessionFile: string) {}

	async startNewSession<T>(): Promise<T> {
		throw new Error("Golden fixture requires managed session startup.");
	}

	async startManagedSession<T>(
		input: GjcStartNewSessionInput & { readonly preparedManagedAuthority: ManagedPreparedTurnAuthority },
		publish: (
			result: GjcSessionAddress & GjcTurnResult,
			lifecycle: ReturnType<typeof lifecycleFixture>,
		) => Promise<T>,
		beforePrompt: (
			address: GjcSessionAddress,
			proof: ManagedGenerationProof,
			lifecycle: ReturnType<typeof lifecycleFixture>,
		) => Promise<void>,
	): Promise<T> {
		const prepared = input.preparedManagedAuthority;
		if (
			prepared === undefined ||
			prepared.principalId !== input.principalId ||
			prepared.projectId !== input.projectId ||
			prepared.canonicalWorkspace !== input.cwd ||
			prepared.chatId !== input.chatId ||
			prepared.requestKey !== input.userMessageId ||
			![prepared.principalId, prepared.leaseId, prepared.epoch, prepared.requestKey].every(
				value => typeof value === "string" && value.trim().length > 0,
			)
		)
			throw new Error("Golden fixture requires exact prepared managed authority.");
		this.starts.push(input);
		const managedAuthority = managedPreparedAuthority({
			...prepared,
			sessionId: "session-live",
			generation: 1,
		});
		const managedProof: ManagedGenerationProof = {
			kind: "managed-generation",
			sessionId: managedAuthority.sessionId,
			generation: managedAuthority.generation,
			leaseId: managedAuthority.leaseId,
			epoch: managedAuthority.epoch,
		};
		const result = {
			cwd: input.cwd,
			sessionRoot: input.sessionRoot,
			projectId: input.projectId,
			chatId: input.chatId,
			sessionId: "session-live",
			text: "started",
			events: [{ type: "tool_execution_end", text: "Tool finished", id: "tool-1" }],
			sessionFile: this.sessionFile,
			activeLeaf: "assistant-1",
			rawFrameCursor: 1,
			eventCursor: 1,
			managedAuthority,
			managedProof,
			...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
		};
		const lifecycle = lifecycleFixture(result, managedAuthority);
		await beforePrompt(result, managedProof, lifecycle);
		return await publish(result, lifecycle);
	}

	async continueSession(input: GjcContinueSessionInput): Promise<GjcTurnResult> {
		const managedState = this.bindManagedAuthority(input);
		this.continues.push(input);
		input.onDispatch?.();
		return {
			text: "continued",
			events: [{ type: "workflow_gate", text: "Approve continuation", id: "gate-live" }],
			sessionFile: this.sessionFile,
			activeLeaf: "assistant-2",
			rawFrameCursor: input.rawFrameCursor + 1,
			eventCursor: input.eventCursor + 1,
			...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
			...managedState,
		};
	}

	async withLifecyclePublication<T>(
		address: GjcSessionAddress,
		effect: (lifecycle: ReturnType<typeof lifecycleFixture>) => Promise<T>,
	): Promise<T> {
		const lifecycle = lifecycleFixture(address);
		lifecycle.publishManaged = async (proof, write) => {
			const authority = this.#managedAuthorities.get(lifecycle);
			if (authority === undefined) throw new Error("Golden lifecycle has no managed authority.");
			return await lifecycleFixture(address, authority).publishManaged!(proof, write);
		};
		return await effect(lifecycle);
	}

	async getState(input: GjcSessionStateInput): Promise<GjcSessionState> {
		const managedState = this.bindManagedAuthority(input);
		this.states.push(input);
		return {
			sessionFile: this.sessionFile,
			activeLeaf: "assistant-1",
			rawFrameCursor: 1,
			eventCursor: 1,
			...managedState,
		};
	}

	private bindManagedAuthority(input: GjcSessionStateInput) {
		const authority = input.managedAuthority;
		if (
			authority === undefined ||
			authority.projectId !== input.projectId ||
			authority.canonicalWorkspace !== input.cwd ||
			authority.chatId !== input.chatId ||
			authority.sessionId !== input.sessionId ||
			!Number.isSafeInteger(authority.generation) ||
			authority.generation <= 0 ||
			![authority.principalId, authority.leaseId, authority.epoch, authority.requestKey].every(
				value => typeof value === "string" && value.trim().length > 0,
			)
		)
			throw new Error("Golden fixture requires exact managed session authority.");
		const bound = this.#managedAuthorities.get(input.lifecycle);
		if (
			bound !== undefined &&
			(Object.keys(bound) as (keyof ManagedTurnAuthority)[]).some(key => bound[key] !== authority[key])
		)
			throw new Error("Golden lifecycle managed authority changed.");
		this.#managedAuthorities.set(input.lifecycle, { ...authority });
		return {
			managedAuthority: { ...authority },
			managedProof: {
				kind: "managed-generation" as const,
				sessionId: authority.sessionId,
				generation: authority.generation,
				leaseId: authority.leaseId,
				epoch: authority.epoch,
			},
		};
	}
}

export function liveHeaders(
	chatId: string,
	messageId: string,
	userMessageId: string,
	parentId: string | null,
): Record<string, string> {
	return {
		"X-OpenWebUI-Chat-Id": chatId,
		"X-OpenWebUI-Message-Id": messageId,
		"X-OpenWebUI-User-Message-Id": userMessageId,
		"X-OpenWebUI-User-Message-Parent-Id": parentId ?? "",
		"X-OpenWebUI-User-Id": ownerUserId,
	};
}

export function failGate() {
	throw new Error("expected pending gate");
}

function messageEntry(
	id: string,
	parentId: string | null,
	role: Message["role"],
	content: Message["content"],
): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-07-08T00:00:00.000Z",
		message: { role, content, timestamp: 1783468800000 } as Message,
	};
}

function customEntry(
	id: string,
	parentId: string | null,
	customType: string,
	data: Record<string, unknown>,
): SessionEntry {
	return {
		type: "custom",
		id,
		parentId,
		timestamp: "2026-07-08T00:00:00.000Z",
		customType,
		data,
	} as SessionEntry;
}
