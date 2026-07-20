export { parseAuthorityMutationLockRecord } from "./session-authority-lock-validation";
export {
	isAttachmentProof,
	isEvent,
	isNormalizedModelSelection,
	isOperation,
} from "./session-authority-operation-validation";
export {
	isAuthorityDocumentRelationallyValid,
	isProvisionalOperation,
	isV2Record,
} from "./session-authority-record-validation";
export {
	hasOnlyKeys,
	isAlreadyExists,
	isJsonValue,
	isNonEmptyString,
	isNonnegativeSafeInteger,
	isRecord,
	isTimestamp,
} from "./session-authority-validation-primitives";

import { isRecord } from "./session-authority-validation-primitives";

export function isLegacyMappingDocument(value: unknown): boolean {
	return (
		Array.isArray(value) ||
		(isRecord(value) && Array.isArray(value.mappings) && value.kind === undefined && value.version === undefined)
	);
}
