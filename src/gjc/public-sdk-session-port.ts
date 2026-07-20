import type { NormalizedModelSelection } from "../contracts";
import { assertAttachmentAuthority } from "./public-sdk-attachment";
import type {
	PublicSdkGate,
	PublicSdkSessionAttachment,
	PublicSdkSessionCoordinatorOwner,
	PublicSdkSessionPort,
	PublicSdkSessionState,
	PublicSdkTurnOutcome,
} from "./public-sdk-contract";

export {
	assertPublishedSdkAttachmentCurrent,
	attachmentFromPublishedSdkEndpoint,
	samePublishedSdkEndpoint,
} from "./public-sdk-attachment";

import { queryOne, withPublicSdkAuthority } from "./public-sdk-authority";
import { withPublicSdkSessionMutationCoordinator } from "./public-sdk-coordinator";

export type { PublicSdkSessionCoordinatorScope } from "./public-sdk-coordinator";
export { withPublicSdkSessionMutationCoordinator } from "./public-sdk-coordinator";

import { discoverLifecycleSuccessor, sessionOperation } from "./public-sdk-lifecycle";
import { closeSession, type PublicSdkActionHost, reply, setModel, setThinking } from "./public-sdk-session-actions";
import { readAvailableModels, readBranchCandidates, readSessionState } from "./public-sdk-state";
import { runGateTurn, runTurn } from "./public-sdk-turns";
import { SdkV3Client } from "./sdk-v3-client";
import { type SdkRecord, SdkV3OperationError } from "./sdk-v3-protocol";

/** Public, per-session SDK adapter. It owns only its WebSocket attachment. */
export class PublicSdkSessionClient implements PublicSdkSessionPort {
	#attachment: PublicSdkSessionAttachment | undefined;
	#client: SdkV3Client | undefined;
	readonly #coordinatorOwner: PublicSdkSessionCoordinatorOwner = {};
	#attachedCoordinatorOwner: PublicSdkSessionCoordinatorOwner = this.#coordinatorOwner;
	#mutationInFlight = false;
	#selectedModel: NormalizedModelSelection | undefined;
	async attach(
		attachment: PublicSdkSessionAttachment,
		timeoutMs?: number,
		coordinatorOwner: PublicSdkSessionCoordinatorOwner = this.#coordinatorOwner,
	): Promise<void> {
		assertAttachmentAuthority(attachment);
		this.detach();
		const client = new SdkV3Client(attachment.endpoint);
		try {
			await client.connect(timeoutMs);
		} catch (error) {
			client.detach();
			throw error;
		}
		this.#attachment = attachment;
		this.#attachedCoordinatorOwner = coordinatorOwner;
		this.#client = client;
	}
	detach(): void {
		this.#client?.detach();
		this.#client = undefined;
		this.#attachment = undefined;
		this.#attachedCoordinatorOwner = this.#coordinatorOwner;
		this.#mutationInFlight = false;
		this.#selectedModel = undefined;
	}
	getState(timeoutMs?: number): Promise<PublicSdkSessionState> {
		return this.authority(timeoutMs, client => readSessionState(client, this.connected().attachment, timeoutMs));
	}
	getAvailableModels(timeoutMs?: number): Promise<readonly unknown[]> {
		return this.authority(timeoutMs, client => readAvailableModels(client, timeoutMs));
	}
	branchCandidates(timeoutMs?: number) {
		return this.authority(timeoutMs, client => readBranchCandidates(client, timeoutMs));
	}
	setModel(selection: NormalizedModelSelection, key?: string, timeoutMs?: number): Promise<NormalizedModelSelection> {
		return this.coordinated(() => setModel(this.actionHost(), selection, key, timeoutMs));
	}
	setThinking(
		thinkingLevel: NormalizedModelSelection["thinkingLevel"],
		key?: string,
		timeoutMs?: number,
	): Promise<NormalizedModelSelection> {
		return this.coordinated(() => setThinking(this.actionHost(), thinkingLevel, key, timeoutMs));
	}
	prompt(text: string, timeoutMs = 60_000): Promise<PublicSdkTurnOutcome> {
		return this.coordinated(() => runTurn(this.turnContext(), "turn.prompt", { text }, undefined, timeoutMs));
	}
	steer(text: string, key?: string, timeoutMs?: number): Promise<unknown> {
		return this.reply("turn.steer", { text }, key, timeoutMs);
	}
	followUp(text: string, key?: string, timeoutMs?: number): Promise<PublicSdkTurnOutcome> {
		return this.coordinated(() => runTurn(this.turnContext(), "turn.follow_up", { text }, key, timeoutMs ?? 60_000));
	}
	abort(key?: string, timeoutMs?: number): Promise<unknown> {
		return this.reply("turn.abort", {}, key, timeoutMs);
	}
	abortAndPrompt(text: string, key?: string, timeoutMs?: number): Promise<PublicSdkTurnOutcome> {
		return this.coordinated(() =>
			runTurn(this.turnContext(), "turn.abort_and_prompt", { text }, key, timeoutMs ?? 60_000),
		);
	}
	replyToAction(id: string, answer: unknown, key?: string, timeoutMs?: number): Promise<unknown> {
		return this.reply("ask.answer", { id, answer }, key, timeoutMs);
	}
	planApprove(input: SdkRecord, key?: string, timeoutMs = 60_000): Promise<unknown> {
		return this.coordinated(() =>
			runTurn(
				this.turnContext(),
				"workflow.plan_approve",
				{ ...input, expectedSessionId: this.connected().attachment.sessionId },
				key,
				timeoutMs,
			),
		);
	}
	answerGate(gate: PublicSdkGate, answer: unknown, key?: string, timeoutMs = 60_000): Promise<PublicSdkTurnOutcome> {
		return this.coordinated(() => runGateTurn(this.turnContext(), gate, answer, key, timeoutMs));
	}

	branch(input: SdkRecord, key?: string, timeoutMs?: number): Promise<PublicSdkSessionAttachment> {
		return this.lifecycle("session.branch", input, key, timeoutMs);
	}

	newSession(input: SdkRecord = {}, key?: string, timeoutMs?: number): Promise<PublicSdkSessionAttachment> {
		return this.lifecycle("session.new", input, key, timeoutMs);
	}

	resumeSession(input: SdkRecord = {}, key?: string, timeoutMs?: number): Promise<PublicSdkSessionAttachment> {
		return this.lifecycle("session.resume", input, key, timeoutMs);
	}

	switchSession(input: SdkRecord, key?: string, timeoutMs?: number): Promise<PublicSdkSessionAttachment> {
		return this.lifecycle("session.switch", input, key, timeoutMs);
	}

	async closeSession(key?: string, timeoutMs?: number): Promise<void> {
		await this.coordinated(() => closeSession(this.actionHost(), key, timeoutMs));
	}

	async reply(operation: string, input: SdkRecord, key?: string, timeoutMs = 60_000): Promise<unknown> {
		return this.coordinated(() => reply(this.actionHost(), operation, input, key, timeoutMs));
	}

	private lifecycle(
		operation: string,
		input: SdkRecord,
		key?: string,
		timeoutMs?: number,
	): Promise<PublicSdkSessionAttachment> {
		const owner = this.#attachedCoordinatorOwner;
		return this.coordinated(() =>
			sessionOperation(
				{
					connected: () => ({ attachment: this.connected().attachment }),
					mutate: (op, value, id, timeout) => this.mutate(this.connected().client, op, value, id, timeout),
					withAuthority: (timeout, effect, post) => this.authority(timeout, () => effect(), post),
					discover: discoverLifecycleSuccessor,
					attach: (attachment, timeout) => this.attach(attachment, timeout, owner),
					detach: () => this.detach(),
					metadata: timeout => this.queryOne(this.connected().client, "session.metadata", timeout),
				},
				operation,
				input,
				key,
				timeoutMs,
			),
		);
	}

	private turnContext() {
		const { attachment, client } = this.connected();
		return {
			attachment,
			client,
			authority: <T>(timeoutMs: number, effect: (authorized: SdkV3Client) => Promise<T>) =>
				this.authority(timeoutMs, effect),
			mutate: (operation: string, input: SdkRecord, key?: string, timeoutMs?: number) =>
				this.mutate(client, operation, input, key, timeoutMs),
		};
	}

	private actionHost(): PublicSdkActionHost {
		return {
			authority: (timeoutMs, effect, post) => this.authority(timeoutMs, effect, post),
			mutate: (client, operation, input, key, timeoutMs) => this.mutate(client, operation, input, key, timeoutMs),
			selectedModel: () => this.#selectedModel,
			setSelectedModel: selection => {
				this.#selectedModel = selection;
			},
			detach: () => this.detach(),
			connected: () => this.connected(),
		};
	}
	private mutate(
		client: SdkV3Client,
		operation: string,
		input: SdkRecord,
		key?: string,
		timeoutMs?: number,
	): Promise<unknown> {
		return this.coordinated(async () => {
			if (this.#mutationInFlight)
				throw new SdkV3OperationError("mutation_in_flight", "Only one mutation may run per session attachment");
			this.#mutationInFlight = true;
			try {
				return await client.control(operation, input, timeoutMs, key);
			} finally {
				this.#mutationInFlight = false;
			}
		});
	}

	private authority<T>(
		timeoutMs: number | undefined,
		effect: (client: SdkV3Client) => Promise<T>,
		post: "strict" | "allow_missing" | "skip" = "strict",
	): Promise<T> {
		const { attachment, client } = this.connected();
		return withPublicSdkAuthority(
			{ attachment, client, isCurrent: () => this.#attachment === attachment && this.#client === client },
			timeoutMs,
			effect,
			post,
		);
	}

	private queryOne(client: SdkV3Client, query: string, timeoutMs?: number): Promise<unknown> {
		return queryOne(client, query, timeoutMs);
	}

	private connected(): { readonly client: SdkV3Client; readonly attachment: PublicSdkSessionAttachment } {
		if (this.#client === undefined || this.#attachment === undefined) {
			throw new SdkV3OperationError("session_unavailable", "No public SDK session is attached");
		}
		return { client: this.#client, attachment: this.#attachment };
	}

	private coordinated<T>(effect: () => Promise<T>): Promise<T> {
		const { attachment } = this.connected();
		return withPublicSdkSessionMutationCoordinator(
			{ cwd: attachment.cwd, sessionId: attachment.sessionId },
			this.#attachedCoordinatorOwner,
			effect,
		);
	}
}
