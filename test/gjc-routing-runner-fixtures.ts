import { join, resolve } from "node:path";
import type { NormalizedModelSelection } from "../src/contracts";
import { SESSION_AUTHORITY_V3_EPOCH } from "../src/gjc/session-authority-v3";
import type {
	GjcCancelTurnInput,
	GjcContinueSessionInput,
	GjcLifecycleTransaction,
	GjcRespondWorkflowGateInput,
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
import { GjcTurnCancelledError } from "../src/gjc/turn-runner";
import type { RegisteredProject } from "../src/projects/registry";
import { attachmentProof, lifecycleFixture } from "./gjc-lifecycle-fixtures";

export class FakeGjcTurnRunner implements GjcTurnRunner {
	readonly starts: GjcStartNewSessionInput[] = [];
	readonly managedStarts: (GjcStartNewSessionInput & {
		readonly preparedManagedAuthority: ManagedPreparedTurnAuthority;
	})[] = [];
	readonly continues: GjcContinueSessionInput[] = [];
	readonly states: GjcSessionStateInput[] = [];
	readonly gateResponses: GjcRespondWorkflowGateInput[] = [];
	cancelTurn?: (input: GjcCancelTurnInput) => void;

	state: GjcSessionState = {
		rawFrameCursor: 7,
		eventCursor: 3,
	};
	events: GjcTurnResult["events"] = [{ type: "assistant", text: "assistant from gjc" }];
	observedEvents?: GjcTurnResult["events"];
	gateResponseEvents: GjcTurnResult["events"] = [{ type: "assistant", text: "workflow gate accepted" }];
	gateObservedEvents?: GjcTurnResult["events"];
	startModelSelection?: NormalizedModelSelection;
	continueModelSelection?: NormalizedModelSelection;
	completionBarrier?: Promise<void>;
	completionError?: Error;
	private readonly lifecycleAuthorities = new WeakMap<GjcLifecycleTransaction, ManagedTurnAuthority>();

	async startNewSession<T>(
		input: GjcStartNewSessionInput,
		publish: (
			result: GjcSessionAddress & GjcTurnResult,
			lifecycle: ReturnType<typeof lifecycleFixture>,
		) => Promise<T>,
	): Promise<T> {
		this.starts.push(input);
		for (const event of this.observedEvents ?? this.events) await input.observer?.(event);
		await this.completionBarrier;
		if (this.completionError !== undefined) throw this.completionError;
		const result = {
			cwd: input.cwd,
			sessionRoot: input.sessionRoot,
			projectId: input.projectId,
			chatId: input.chatId,
			sessionId: "session-1",
			text: `new:${input.text}`,
			events: this.events,
			sessionFile: join(input.sessionRoot, "session-1.jsonl"),
			activeLeaf: "leaf-1",
			rawFrameCursor: 7,
			eventCursor: 3,
			...(this.startModelSelection === undefined
				? input.modelSelection === undefined
					? {}
					: { modelSelection: input.modelSelection }
				: { modelSelection: this.startModelSelection }),
		};
		const lifecycle = lifecycleFixture(result);
		return await publish({ ...result, attachment: attachmentProof(result) }, lifecycle);
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
		onFailure?: (lifecycle: GjcLifecycleTransaction, error: unknown) => Promise<void>,
	): Promise<T> {
		throwIfAborted(input.signal);
		this.managedStarts.push(input);
		const authority = {
			...input.preparedManagedAuthority,
			sessionId: "session-1",
			generation: 1,
			authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
		} as ManagedTurnAuthority & { readonly authorityEpoch: typeof SESSION_AUTHORITY_V3_EPOCH };
		const result = {
			cwd: input.cwd,
			sessionRoot: input.sessionRoot,
			projectId: input.projectId,
			chatId: input.chatId,
			sessionId: authority.sessionId,
			text: `new:${input.text}`,
			events: this.events,
			rawFrameCursor: 7,
			eventCursor: 3,
			managedProof: managedProof(authority),
			managedAuthority: authority,
			...(this.startModelSelection === undefined
				? input.modelSelection === undefined
					? {}
					: { modelSelection: input.modelSelection }
				: { modelSelection: this.startModelSelection }),
		};
		const lifecycle = this.managedLifecycle(result);
		this.lifecycleAuthorities.set(lifecycle, authority);
		await beforePrompt(result, result.managedProof, lifecycle);
		throwIfAborted(input.signal);
		try {
			for (const event of this.observedEvents ?? this.events) await input.observer?.(event);
			await this.completionBarrier;
			throwIfAborted(input.signal);
			if (this.completionError !== undefined) throw this.completionError;
			return await publish(result, lifecycle);
		} catch (error) {
			await onFailure?.(lifecycle, error);
			throw error;
		}
	}

	async continueSession(input: GjcContinueSessionInput): Promise<GjcTurnResult> {
		throwIfAborted(input.signal);
		const authority = this.bindAuthority(input);
		this.continues.push(input);
		input.onDispatch?.();
		for (const event of this.observedEvents ?? this.events) await input.observer?.(event);
		await this.completionBarrier;
		throwIfAborted(input.signal);
		if (this.completionError !== undefined) throw this.completionError;
		return {
			text: `continued:${input.text}`,
			events: this.events,
			rawFrameCursor: input.rawFrameCursor + 5,
			eventCursor: input.eventCursor + 2,
			...(this.continueModelSelection === undefined
				? input.modelSelection === undefined
					? {}
					: { modelSelection: input.modelSelection }
				: { modelSelection: this.continueModelSelection }),
			managedProof: managedProof(authority),
			managedAuthority: authority,
		};
	}

	async withLifecyclePublication<T>(
		address: GjcSessionAddress,
		effect: (lifecycle: ReturnType<typeof lifecycleFixture>) => Promise<T>,
	): Promise<T> {
		return await effect(this.managedLifecycle(address));
	}

	async getState(input: GjcSessionStateInput): Promise<GjcSessionState> {
		const authority = this.bindAuthority(input);
		this.states.push(input);
		return {
			rawFrameCursor: this.state.rawFrameCursor,
			eventCursor: this.state.eventCursor,
			managedProof: managedProof(authority),
			managedAuthority: authority,
		};
	}

	async respondWorkflowGate(input: GjcRespondWorkflowGateInput): Promise<GjcTurnResult> {
		throwIfAborted(input.signal);
		const authority = this.bindAuthority(input);
		this.gateResponses.push(input);
		input.onDispatch?.();
		for (const event of this.gateObservedEvents ?? this.gateResponseEvents) await input.observer?.(event);
		await this.completionBarrier;
		throwIfAborted(input.signal);
		if (this.completionError !== undefined) throw this.completionError;
		return {
			text: "workflow gate accepted",
			events: this.gateResponseEvents,
			rawFrameCursor: input.rawFrameCursor,
			eventCursor: input.eventCursor,
			managedProof: managedProof(authority),
			managedAuthority: authority,
		};
	}

	private bindAuthority(input: GjcSessionStateInput): ManagedTurnAuthority {
		const authority = input.managedAuthority;
		if (authority === undefined) throw new Error("Routing fake requires managed authority.");
		if (
			!authority.principalId ||
			!authority.leaseId ||
			!authority.epoch ||
			!authority.requestKey ||
			!Number.isSafeInteger(authority.generation) ||
			authority.generation <= 0 ||
			authority.projectId !== input.projectId ||
			authority.chatId !== input.chatId ||
			authority.sessionId !== input.sessionId ||
			authority.canonicalWorkspace !== resolve(input.cwd) ||
			(authority as ManagedTurnAuthority & { readonly authorityEpoch?: unknown }).authorityEpoch !==
				SESSION_AUTHORITY_V3_EPOCH
		)
			throw new Error("Routing fake requires complete exact managed authority.");
		if (input.lifecycle !== undefined) {
			const bound = this.lifecycleAuthorities.get(input.lifecycle);
			if (bound !== undefined) {
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
				] as const)
					if (bound[field] !== authority[field]) throw new Error("Routing fake lifecycle authority changed.");
				if (
					(bound as ManagedTurnAuthority & { readonly authorityEpoch?: unknown }).authorityEpoch !==
					(authority as ManagedTurnAuthority & { readonly authorityEpoch?: unknown }).authorityEpoch
				)
					throw new Error("Routing fake lifecycle authority epoch changed.");
			}
			this.lifecycleAuthorities.set(input.lifecycle, { ...authority });
		}
		return { ...authority };
	}

	private managedLifecycle(address: GjcSessionAddress): GjcLifecycleTransaction {
		const lifecycle: GjcLifecycleTransaction = {
			address,
			owner: {},
			assertClosePreflight(): never {
				throw new Error("Routing fake has no close authority.");
			},
			async publish(): Promise<never> {
				throw new Error("Routing fake rejects legacy publication.");
			},
			publishManaged: async (proof, write) => {
				const authority = this.lifecycleAuthorities.get(lifecycle);
				if (authority === undefined) throw new Error("Routing fake lifecycle authority is unbound.");
				if (
					authority.projectId !== address.projectId ||
					authority.chatId !== address.chatId ||
					authority.canonicalWorkspace !== resolve(address.cwd) ||
					authority.sessionId !== address.sessionId ||
					proof.kind !== "managed-generation" ||
					proof.sessionId !== authority.sessionId ||
					!Number.isSafeInteger(proof.generation) ||
					proof.generation <= 0 ||
					proof.generation !== authority.generation ||
					proof.leaseId !== authority.leaseId ||
					proof.epoch !== authority.epoch
				)
					throw new Error("Routing fake rejected mismatched managed proof.");
				return write();
			},
			async publishClosed(): Promise<never> {
				throw new Error("Routing fake has no close publication.");
			},
			async handoff(): Promise<never> {
				throw new Error("Routing fake has no successor authority.");
			},
		};
		return lifecycle;
	}
}

function managedProof(authority: ManagedTurnAuthority): ManagedGenerationProof {
	return {
		kind: "managed-generation",
		sessionId: authority.sessionId,
		generation: authority.generation,
		leaseId: authority.leaseId,
		epoch: authority.epoch,
	};
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new GjcTurnCancelledError();
}

export const project: RegisteredProject = {
	id: "project",
	name: "Project",
	cwd: "/workspace/project",
	allowedRoot: "/workspace",
	createdAt: new Date("2026-07-08T00:00:00.000Z"),
};

export const deepInterviewWorkflowGateEvent = {
	type: "workflow_gate",
	id: "gate-deep-1",
	payload: {
		gateId: "gate-deep-1",
		stage: "deep-interview",
		kind: "question",
		schemaHash: "sha256:deep",
		idempotencyKey: "idem-deep-1",
		commandId: "command-1",
		turnId: "turn-1",
		sessionId: "session-1",
		context: { prompt: "Choose authentication method" },
		options: [
			{ label: "JWT", value: "JWT" },
			{ label: "OAuth2", value: "OAuth2" },
			{ label: "Session cookies", value: "Session cookies" },
		],
		schema: {
			type: "object",
			required: ["selected"],
			additionalProperties: false,
			properties: {
				selected: {
					type: "array",
					minItems: 1,
					items: { type: "string", enum: ["JWT", "OAuth2", "Session cookies"] },
				},
			},
		},
	},
} as const;

export const decisionWorkflowGateEvent = {
	type: "workflow_gate",
	id: "gate-plan-1",
	payload: {
		gateId: "gate-plan-1",
		stage: "ralplan",
		kind: "approval",
		schemaHash: "sha256:decision",
		context: { prompt: "Approve this plan?" },
		options: [
			{ label: "Approve", value: "approve" },
			{ label: "Reject", value: "reject" },
		],
		schema: {
			type: "object",
			required: ["decision"],
			additionalProperties: false,
			properties: {
				decision: { type: "string", enum: ["approve", "reject"] },
			},
		},
	},
} as const;
