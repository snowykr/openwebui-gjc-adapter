import { createHash } from "node:crypto";

const TERMINAL_ABORT_KEY_PREFIX = "gjc-terminal-abort-v1:";

/** Returns a stable, bounded SDK idempotency key for owner-scoped terminal aborts. */
export function terminalAbortIdempotencyKey(chatId: string, userMessageId: string): string {
	const hash = createHash("sha256");
	updateLengthDelimited(hash, chatId);
	updateLengthDelimited(hash, userMessageId);
	return `${TERMINAL_ABORT_KEY_PREFIX}${hash.digest("hex")}`;
}

function updateLengthDelimited(hash: ReturnType<typeof createHash>, value: string): void {
	const bytes = Buffer.from(value, "utf8");
	const length = Buffer.allocUnsafe(4);
	length.writeUInt32BE(bytes.length, 0);
	hash.update(length).update(bytes);
}
