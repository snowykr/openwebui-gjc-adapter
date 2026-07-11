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
} from "../src/gjc/rpc-runner";
import type { RegisteredProject } from "../src/projects/registry";

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

	async startNewSession(input: GjcStartNewSessionInput): Promise<GjcSessionAddress & GjcTurnResult> {
		this.starts.push(input);
		return {
			cwd: input.cwd,
			sessionRoot: input.sessionRoot,
			projectId: input.projectId,
			chatId: input.chatId,
			sessionId: "session-1",
			text: `new:${input.text}`,
			events: this.events,
			sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
			activeLeaf: "leaf-1",
			rawFrameCursor: 7,
			eventCursor: 3,
		};
	}

	async continueSession(input: GjcContinueSessionInput): Promise<GjcTurnResult> {
		this.continues.push(input);
		return {
			text: `continued:${input.text}`,
			events: this.events,
			sessionFile: input.sessionFile,
			activeLeaf: "leaf-2",
			rawFrameCursor: input.rawFrameCursor + 5,
			eventCursor: input.eventCursor + 2,
		};
	}

	async switchSession(input: GjcSwitchSessionInput): Promise<void> {
		this.switches.push(input);
	}

	async getState(input: GjcSessionStateInput): Promise<GjcSessionState> {
		this.states.push(input);
		return this.state;
	}

	async respondWorkflowGate(input: GjcRespondWorkflowGateInput): Promise<GjcTurnResult> {
		this.gateResponses.push(input);
		return {
			text: "workflow gate accepted",
			events: [{ type: "assistant", text: "workflow gate accepted" }],
			sessionFile: input.sessionFile,
			activeLeaf: "leaf-gate",
			rawFrameCursor: input.rawFrameCursor,
			eventCursor: input.eventCursor,
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
