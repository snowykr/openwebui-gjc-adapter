import { OpenWebUIPrincipalScopeError } from "./auth";
import type { OpenWebUIChatRecord } from "./client";

export { OpenWebUIPrincipalScopeError } from "./auth";

export interface OpenWebUIOwnerChatProof {
	readonly ownerUserId: string;
	readonly chatId: string;
}

const ownerChatProofs = new WeakSet<object>();

export function createOpenWebUIOwnerChatProof(input: OpenWebUIChatRecord): OpenWebUIOwnerChatProof {
	if (input.owner_user_id.trim().length === 0 || input.id.trim().length === 0) {
		throw new OpenWebUIPrincipalScopeError("OpenWebUI owner/chat proof requires non-empty owner and chat IDs.");
	}
	const proof = Object.freeze({
		ownerUserId: input.owner_user_id,
		chatId: input.id,
	});
	ownerChatProofs.add(proof);
	return proof;
}

export function isOpenWebUIOwnerChatProof(value: unknown): value is OpenWebUIOwnerChatProof {
	return typeof value === "object" && value !== null && ownerChatProofs.has(value);
}

export function assertOpenWebUIOwnerChatProof(
	proof: OpenWebUIOwnerChatProof | undefined,
	expected: { readonly ownerUserId: string; readonly chatId: string },
): asserts proof is OpenWebUIOwnerChatProof {
	if (proof === undefined || !isOpenWebUIOwnerChatProof(proof)) {
		throw new OpenWebUIPrincipalScopeError("OpenWebUI message write requires an owner/chat proof.");
	}
	if (proof.ownerUserId !== expected.ownerUserId || proof.chatId !== expected.chatId) {
		throw new OpenWebUIPrincipalScopeError("OpenWebUI message write owner/chat proof does not match the target.");
	}
}
