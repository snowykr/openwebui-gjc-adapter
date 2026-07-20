import type { SessionOperationResult } from "./session-authority";
import type { GjcCloseReceipt, GjcLifecycleTransaction } from "./turn-runner";
import { replayCloseOperation } from "./session-operation-codec";
import type { SessionMapping, SessionMappingStore } from "./session-mapping-store";

export type SessionCloseResult =
	| { readonly status: "closed" }
	| { readonly status: "unavailable"; readonly message: string }
	| { readonly status: "uncertain"; readonly message: string };

export interface SessionCloseIngress {
	readonly ingressId: string;
	readonly ingressHash: string;
}

export interface RouteGjcSessionCloseInput extends SessionCloseIngress {
	readonly mapping: SessionMapping;
	readonly mappings: SessionMappingStore;
	readonly lifecycle: GjcLifecycleTransaction;
	readonly close: (receipt: GjcCloseReceipt) => Promise<SessionCloseResult>;
	readonly afterPublish?: (mapping: SessionMapping) => void;
}

export async function routeGjcSessionClose(input: RouteGjcSessionCloseInput): Promise<SessionCloseResult> {
	const prior = input.mappings.operation(input.mapping.chatId, input.ingressId);
	if (prior !== undefined) return replayPriorClose(input, prior.result, prior.kind, prior.detail, prior.state);
	input.mappings.beginOperation(input.mapping.chatId, { id: input.ingressId, kind: "close", ingressId: input.ingressId, detail: input.ingressHash });
	try {
		const proof = input.mapping.attachment;
		if (!hasOwnedPaneAttachment(proof)) {
			input.mappings.transitionOperation(input.mapping.chatId, input.ingressId, "conflict", input.ingressHash);
			return { status: "uncertain", message: "GJC close requires a complete owned-pane attachment before acknowledgement." };
		}
		let receipt: GjcCloseReceipt;
		try {
			receipt = input.lifecycle.assertClosePreflight(proof);
		} catch (error) {
			const message = error instanceof Error ? error.message : "GJC close receipt could not be established.";
			input.mappings.transitionOperation(input.mapping.chatId, input.ingressId, "conflict", input.ingressHash);
			return { status: "uncertain", message };
		}
		const result = await input.close(receipt);
		if (result.status !== "closed") {
			input.mappings.transitionOperation(input.mapping.chatId, input.ingressId, "conflict", input.ingressHash);
			return result;
		}
		await input.lifecycle.publishClosed(receipt, () => {
			const mapping = input.mappings.completeOperationWithMapping(input.mapping.chatId, input.ingressId, input.ingressHash, input.mapping, "close");
			input.afterPublish?.(mapping);
			return mapping;
		});
		return result;
	} catch (error) {
		input.mappings.transitionOperation(input.mapping.chatId, input.ingressId, "uncertain", input.ingressHash);
		throw error;
	}
}

function replayPriorClose(input: RouteGjcSessionCloseInput, result: SessionOperationResult | undefined, kind: string, detail: string | undefined, state: string): SessionCloseResult {
	if (kind !== "close" || detail !== input.ingressHash) throw new Error(`GJC close ${input.ingressId} conflicts with a different ingress payload.`);
	if (state === "complete") { input.afterPublish?.(input.mapping); return replayCloseOperation(input.ingressId, result); }
	if (state === "pending") throw new Error(`GJC close ${input.ingressId} is pending and cannot be replayed.`);
	throw new Error(`GJC close ${input.ingressId} requires reconciliation.`);
}

function hasOwnedPaneAttachment(proof: SessionMapping["attachment"]): proof is NonNullable<SessionMapping["attachment"]> & Required<Pick<NonNullable<SessionMapping["attachment"]>, "tmuxSocket" | "tmuxPane" | "tmuxPanePid" | "tmuxOwnershipTag">> {
	return proof?.tmuxSocket !== undefined && proof.tmuxPane !== undefined && proof.tmuxPanePid !== undefined && proof.tmuxOwnershipTag !== undefined;
}
