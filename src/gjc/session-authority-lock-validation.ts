import type { AuthorityMutationLockRecord } from "./session-authority-types";
import { isNonEmptyString, isRecord } from "./session-authority-validation-primitives";

export function parseAuthorityMutationLockRecord(value: unknown): AuthorityMutationLockRecord | undefined {
	if (!isRecord(value) || !isNonEmptyString(value.owner)) return undefined;
	if (typeof value.pid !== "number" || !Number.isInteger(value.pid)) return undefined;
	if (typeof value.leaseExpiresAt !== "number" || !Number.isFinite(value.leaseExpiresAt)) return undefined;
	return { owner: value.owner, pid: value.pid, leaseExpiresAt: value.leaseExpiresAt };
}
