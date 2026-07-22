import { join } from "node:path";
import type { NormalizedModelSelection } from "../src/contracts";
import type {
	GjcContinueSessionInput,
	GjcRespondWorkflowGateInput,
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

export class FakeGjcTurnRunner implements GjcTurnRunner {
	readonly starts: GjcStartNewSessionInput[] = [];
	readonly continues: GjcContinueSessionInput[] = [];
	readonly switches: GjcSwitchSessionInput[] = [];
	readonly states: GjcSessionStateInput[] = [];
	readonly gateResponses: GjcRespondWorkflowGateInput[] = [];

	state: GjcSessionState = {
		sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
		activeLeaf: "leaf-1",
		rawFrameCursor: 7,
		eventCursor: 3,
	};
	events: GjcTurnResult["events"] = [{ type: "assistant", text: "assistant from gjc" }];
	gateResponseEvents: GjcTurnResult["events"] = [{ type: "assistant", text: "workflow gate accepted" }];
	startModelSelection?: NormalizedModelSelection;
	continueModelSelection?: NormalizedModelSelection;
	completionBarrier?: Promise<void>;

	async startNewSession<T>(
		input: GjcStartNewSessionInput,
		publish: (
			result: GjcSessionAddress & GjcTurnResult,
			lifecycle: ReturnType<typeof lifecycleFixture>,
		) => Promise<T>,
	): Promise<T> {
		this.starts.push(input);
		for (const event of this.events) await input.observer?.(event);
		await this.completionBarrier;
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

	async continueSession(input: GjcContinueSessionInput): Promise<GjcTurnResult> {
		this.continues.push(input);
		for (const event of this.events) await input.observer?.(event);
		await this.completionBarrier;
		return {
			text: `continued:${input.text}`,
			events: this.events,
			sessionFile: input.sessionFile,
			activeLeaf: "leaf-2",
			rawFrameCursor: input.rawFrameCursor + 5,
			eventCursor: input.eventCursor + 2,
			...(this.continueModelSelection === undefined
				? input.modelSelection === undefined
					? {}
					: { modelSelection: input.modelSelection }
				: { modelSelection: this.continueModelSelection }),
			attachment: attachmentProof(input),
		};
	}

	async switchSession(input: GjcSwitchSessionInput): Promise<void> {
		this.switches.push(input);
	}

	async withLifecyclePublication<T>(
		address: GjcSessionAddress,
		effect: (lifecycle: ReturnType<typeof lifecycleFixture>) => Promise<T>,
	): Promise<T> {
		return await effect(lifecycleFixture(address));
	}

	async getState(input: GjcSessionStateInput): Promise<GjcSessionState> {
		this.states.push(input);
		return { ...this.state, attachment: attachmentProof(input) };
	}

	async respondWorkflowGate(input: GjcRespondWorkflowGateInput): Promise<GjcTurnResult> {
		this.gateResponses.push(input);
		return {
			text: "workflow gate accepted",
			events: this.gateResponseEvents,
			sessionFile: input.sessionFile,
			activeLeaf: "leaf-gate",
			rawFrameCursor: input.rawFrameCursor,
			eventCursor: input.eventCursor,
			attachment: attachmentProof(input),
		};
	}
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
