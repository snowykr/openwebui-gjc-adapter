import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	assertManagedLifecycleTransition,
	isManagedLifecycleState,
	type ManagedLifecycleState,
} from "./managed-lifecycle-state";
import type {
	HistoricalSessionBinding,
	ProvisionalSessionOperation,
	SessionOperation,
	SessionOperationResult,
} from "./session-authority-types";
import { hasOnlyKeys, isNonEmptyString, isRecord, isTimestamp } from "./session-authority-validation-primitives";
import type {
	ManagedEndpointReceipt,
	ManagedGenerationProof,
	ManagedPreparedTurnAuthority,
	ManagedTurnAuthority,
} from "./turn-runner";

/** Public saved-session selection receipt, not snapshot or process-incarnation authority. */
export interface ManagedHistoricalSavedSession {
	readonly id: string;
	readonly path: string;
	readonly identity: {
		readonly dev: string;
		readonly ino: string;
		readonly size: number;
		readonly mtimeMs: number;
		readonly mtimeNs: string;
		readonly sha256: string;
		readonly nlink: string;
		readonly ctimeNs: string;
	};
}

export interface ManagedHistoricalLifecycleSource {
	readonly kind: "bootstrap-history";
	readonly manifestDigest: string;
	readonly historicalBinding: HistoricalSessionBinding;
	readonly savedSession: ManagedHistoricalSavedSession;
}

export interface ManagedLifecycleEvidence {
	readonly operation: "session.create" | "session.resume" | "session.fork" | "session.close" | "session.delete";
	readonly actor: { readonly id: string; readonly namespace: "openwebui-gjc-adapter" };
	readonly requestKey: string;
	readonly requestHash: string;
	readonly payloadHash: string;
	readonly preparedAuthority: ManagedPreparedTurnAuthority;
	readonly source?: ManagedTurnAuthority;
	readonly historicalSource?: ManagedHistoricalLifecycleSource;
	readonly sourceProofRef?: { readonly operationId: string; readonly evidenceHash: string };
	readonly target: Readonly<Record<string, unknown>>;
	readonly state: ManagedLifecycleState;
	readonly recordedAt: string;
	readonly acknowledged?: ManagedTurnAuthority;
	readonly endpointReceipt?: ManagedEndpointReceipt;
	readonly proven?: ManagedGenerationProof;
	readonly closeAcknowledgement?: {
		readonly sessionId: string;
		readonly generation: number;
		readonly observedAt: string;
	};
	readonly retirement?: {
		readonly sessionId: string;
		readonly generation: number;
		readonly acknowledgedSessionId: string;
		readonly observedAt: string;
		readonly evidence: Readonly<Record<string, unknown>>;
	};
}

/** Original admitted success observed after timeout; never active or recovery authority. */
export interface ManagedLateLifecycleAcknowledgement {
	readonly kind: "original-admission-success";
	readonly admissionHash: string;
	readonly observedAt: string;
	readonly acknowledged: { readonly sessionId: string; readonly generation: number };
	readonly endpointReceipt?: ManagedEndpointReceipt;
}

/** Initial create output retained by its prepared provisional owner, never a binding. */
export interface ManagedLateCreateAcknowledgement {
	readonly kind: "original-provisional-create-success";
	readonly admissionHash: string;
	readonly observedAt: string;
	readonly acknowledged: { readonly sessionId: string; readonly generation: number };
	readonly endpointReceipt?: ManagedEndpointReceipt;
}

export function isManagedEndpointReceipt(
	value: unknown,
	acknowledged?: Pick<ManagedTurnAuthority, "sessionId" | "generation">,
): value is ManagedEndpointReceipt {
	if (
		!isRecord(value) ||
		(Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
		Reflect.ownKeys(value).length !== 3 ||
		!["sessionId", "endpointGeneration", "endpointIncarnation"].every(field => {
			const descriptor = Object.getOwnPropertyDescriptor(value, field);
			return descriptor?.enumerable === true && "value" in descriptor;
		})
	)
		return false;
	return (
		isNonEmptyString(value.sessionId) &&
		positiveInteger(value.endpointGeneration) &&
		isHash(value.endpointIncarnation) &&
		value.endpointIncarnation.length === 64 &&
		(acknowledged === undefined ||
			(value.sessionId === acknowledged.sessionId && value.endpointGeneration === acknowledged.generation))
	);
}

export function copyManagedEndpointReceipt(value: ManagedEndpointReceipt): ManagedEndpointReceipt {
	if (!isManagedEndpointReceipt(value)) throw new Error("Invalid managed endpoint receipt.");
	return {
		sessionId: value.sessionId,
		endpointGeneration: value.endpointGeneration,
		endpointIncarnation: value.endpointIncarnation,
	};
}

/** Projects only the named fields of an original observed successful lifecycle result. */
export function managedEndpointReceiptFromResult(
	result: unknown,
	acknowledged: Pick<ManagedTurnAuthority, "sessionId" | "generation">,
): ManagedEndpointReceipt | undefined {
	if (!isRecord(result)) return undefined;
	const receipt = {
		sessionId: Object.getOwnPropertyDescriptor(result, "sessionId")?.value,
		endpointGeneration: Object.getOwnPropertyDescriptor(result, "endpointGeneration")?.value,
		endpointIncarnation: Object.getOwnPropertyDescriptor(result, "endpointIncarnation")?.value,
	};
	return isManagedEndpointReceipt(receipt, acknowledged) ? copyManagedEndpointReceipt(receipt) : undefined;
}

/** Requires original create/resume/fork evidence, not effect or routing authorization. */
export function requireManagedEndpointReceipt(evidence: ManagedLifecycleEvidence): ManagedEndpointReceipt {
	assertEvidence(evidence);
	if (
		!["session.create", "session.resume", "session.fork"].includes(evidence.operation) ||
		evidence.acknowledged === undefined ||
		!isManagedEndpointReceipt(evidence.endpointReceipt, evidence.acknowledged)
	)
		throw new Error("Managed lifecycle evidence lacks its original endpoint receipt.");
	return copyManagedEndpointReceipt(evidence.endpointReceipt);
}

export function managedProvisionalCreateAdmissionHash(operation: ProvisionalSessionOperation): string {
	const evidence = operation.lifecycle;
	if (
		!isNonEmptyString(operation.id) ||
		(operation.ingressId !== undefined && !isNonEmptyString(operation.ingressId)) ||
		!isTimestamp(operation.startedAt) ||
		!isManagedLifecycleEvidence(evidence) ||
		operation.kind !== "create" ||
		evidence.operation !== "session.create" ||
		evidence.source !== undefined ||
		evidence.sourceProofRef !== undefined ||
		evidence.historicalSource !== undefined ||
		operation.historicalBinding !== undefined ||
		operation.managedAuthority !== undefined ||
		operation.sessionId !== undefined ||
		operation.sessionFile !== undefined ||
		operation.activeLeaf !== undefined ||
		operation.attachment !== undefined ||
		operation.lateLifecycleAcknowledgement !== undefined ||
		operation.cleanup !== undefined ||
		(operation.purpose !== undefined && operation.purpose !== "model-catalog") ||
		operation.projectId !== evidence.preparedAuthority.projectId ||
		(operation.chatId !== evidence.preparedAuthority.chatId &&
			operation.chatId !==
				JSON.stringify([evidence.preparedAuthority.principalId, evidence.preparedAuthority.chatId])) ||
		evidence.payloadHash !== operation.detail ||
		Date.parse(evidence.recordedAt) < Date.parse(operation.startedAt)
	)
		throw new Error("Late create observation requires an exact prepared provisional reservation.");
	return requestHash({
		chatId: JSON.stringify([evidence.preparedAuthority.principalId, evidence.preparedAuthority.chatId]),
		projectId: operation.projectId,
		id: operation.id,
		ingressId: operation.ingressId ?? operation.id,
		kind: operation.kind,
		...(operation.purpose === undefined ? {} : { purpose: operation.purpose }),
		startedAt: operation.startedAt,
		detail: operation.detail,
		lifecycle: Object.fromEntries(
			identityFields.filter(field => evidence[field] !== undefined).map(field => [field, evidence[field]]),
		),
	});
}

export function createManagedLateCreateAcknowledgement(
	admitted: ProvisionalSessionOperation,
	acknowledged: ManagedTurnAuthority,
	observedAt = new Date().toISOString(),
	endpointReceipt?: ManagedEndpointReceipt,
): ManagedLateCreateAcknowledgement {
	const admissionHash = managedProvisionalCreateAdmissionHash(admitted);
	const evidence = admitted.lifecycle!;
	if (
		admitted.state !== "pending" ||
		evidence.state !== "invoking" ||
		proofFields.some(field => evidence[field] !== undefined) ||
		admitted.result !== undefined ||
		admitted.completedAt !== undefined ||
		admitted.acknowledgedSuccessor !== undefined ||
		admitted.lateCreateAcknowledgement !== undefined ||
		!isAuthority(acknowledged) ||
		(endpointReceipt !== undefined && !isManagedEndpointReceipt(endpointReceipt, acknowledged)) ||
		!preparedFields.every(field => acknowledged[field] === evidence.preparedAuthority[field]) ||
		!isTimestamp(observedAt) ||
		Date.parse(observedAt) < Date.parse(evidence.recordedAt)
	)
		throw new Error("Late create observation does not match its original invocation.");
	return {
		kind: "original-provisional-create-success",
		admissionHash,
		observedAt,
		acknowledged: { sessionId: acknowledged.sessionId, generation: acknowledged.generation },
		...(endpointReceipt === undefined ? {} : { endpointReceipt: copyManagedEndpointReceipt(endpointReceipt) }),
	};
}

export function isManagedLateCreateAcknowledgement(
	value: unknown,
	operation: ProvisionalSessionOperation,
): value is ManagedLateCreateAcknowledgement {
	try {
		return (
			hasOnlyKeys(value, ["kind", "admissionHash", "observedAt", "acknowledged", "endpointReceipt"]) &&
			value.kind === "original-provisional-create-success" &&
			value.admissionHash === managedProvisionalCreateAdmissionHash(operation) &&
			operation.state === "uncertain" &&
			operation.lifecycle?.state === "uncertain" &&
			proofFields.every(field => operation.lifecycle![field] === undefined) &&
			operation.result === undefined &&
			operation.completedAt === undefined &&
			operation.acknowledgedSuccessor === undefined &&
			isTimestamp(value.observedAt) &&
			Date.parse(value.observedAt) >= Date.parse(operation.lifecycle.recordedAt) &&
			hasOnlyKeys(value.acknowledged, ["sessionId", "generation"]) &&
			isNonEmptyString(value.acknowledged.sessionId) &&
			positiveInteger(value.acknowledged.generation) &&
			(!Object.hasOwn(value, "endpointReceipt") ||
				isManagedEndpointReceipt(
					value.endpointReceipt,
					value.acknowledged as { sessionId: string; generation: number },
				))
		);
	} catch {
		return false;
	}
}

/** Catalog evidence is a nonpublished provisional; its cleanup owns a separate close request. */
export function isManagedCatalogProvisional(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (value.purpose === undefined) return value.cleanup === undefined;
	const evidence = value.lifecycle;
	if (
		value.purpose !== "model-catalog" ||
		value.kind !== "create" ||
		!isManagedLifecycleEvidence(evidence) ||
		evidence.operation !== "session.create" ||
		evidence.source !== undefined ||
		evidence.sourceProofRef !== undefined ||
		evidence.historicalSource !== undefined ||
		[
			"sessionId",
			"sessionFile",
			"activeLeaf",
			"managedAuthority",
			"historicalBinding",
			"attachment",
			"result",
			"acknowledgedSuccessor",
			"lateLifecycleAcknowledgement",
		].some(field => value[field] !== undefined) ||
		!isTimestamp(value.startedAt) ||
		Date.parse(evidence.recordedAt) < Date.parse(value.startedAt) ||
		value.projectId !== evidence.preparedAuthority.projectId ||
		(value.chatId !== evidence.preparedAuthority.chatId &&
			value.chatId !==
				JSON.stringify([evidence.preparedAuthority.principalId, evidence.preparedAuthority.chatId])) ||
		value.detail !== evidence.payloadHash
	)
		return false;
	const child = value.cleanup;
	if (child === undefined)
		return (
			!["closing", "cleanup_pending", "cleanup_uncertain", "retired"].includes(evidence.state) &&
			(value.state === "complete") === (evidence.state === "terminal_failure")
		);
	if (
		value.lateCreateAcknowledgement !== undefined ||
		evidence.acknowledged === undefined ||
		!["acknowledged_unproven", "closing", "cleanup_uncertain", "uncertain", "retired"].includes(evidence.state) ||
		!hasOnlyKeys(child, ["id", "ingressId", "kind", "state", "startedAt", "completedAt", "detail", "lifecycle"]) ||
		!isNonEmptyString(child.id) ||
		!isNonEmptyString(child.ingressId) ||
		child.kind !== "close" ||
		[child.id, child.ingressId].some(id => id === value.id || id === (value.ingressId ?? value.id)) ||
		!["pending", "complete", "uncertain", "conflict"].includes(String(child.state)) ||
		!isTimestamp(child.startedAt) ||
		Date.parse(child.startedAt) < Date.parse(value.startedAt) ||
		!isManagedLifecycleEvidence(child.lifecycle)
	)
		return false;
	const close = child.lifecycle;
	if (
		close.operation !== "session.close" ||
		close.sourceProofRef !== undefined ||
		close.historicalSource !== undefined ||
		!isDeepStrictEqual(close.source, evidence.acknowledged) ||
		close.requestKey === evidence.requestKey ||
		!scopeFields.every(field => close.preparedAuthority[field] === evidence.preparedAuthority[field]) ||
		close.payloadHash !== child.detail ||
		Date.parse(close.recordedAt) < Date.parse(child.startedAt) ||
		(evidence.state === "acknowledged_unproven"
			? Date.parse(child.startedAt) < Date.parse(evidence.recordedAt)
			: Date.parse(child.startedAt) > Date.parse(evidence.recordedAt)) ||
		close.proven !== undefined ||
		close.acknowledged !== undefined ||
		!hasOnlyKeys(close.target, ["sessionId", "endpointGeneration", "endpointIncarnation"]) ||
		close.target.sessionId !== evidence.acknowledged.sessionId ||
		close.target.endpointGeneration !== evidence.acknowledged.generation ||
		((evidence.endpointReceipt !== undefined || close.target.endpointIncarnation !== undefined) &&
			(!isManagedEndpointReceipt(close.target, evidence.acknowledged) ||
				!isDeepStrictEqual(close.target, evidence.endpointReceipt)))
	)
		return false;
	if (child.state === "complete") {
		if (
			!isTimestamp(child.completedAt) ||
			Date.parse(child.completedAt) < Date.parse(close.recordedAt) ||
			!["retired", "terminal_failure"].includes(close.state)
		)
			return false;
	} else if (child.completedAt !== undefined || ["retired", "terminal_failure"].includes(close.state)) return false;
	if (["acknowledged_unproven", "retired"].includes(close.state) && close.closeAcknowledgement === undefined)
		return false;
	if (
		close.closeAcknowledgement !== undefined &&
		Date.parse(close.closeAcknowledgement.observedAt) < Date.parse(child.startedAt)
	)
		return false;
	if (close.state === "retired") {
		if (
			evidence.state !== "retired" ||
			value.state !== "complete" ||
			child.state !== "complete" ||
			!isTimestamp(value.completedAt) ||
			Date.parse(value.completedAt) < Date.parse(child.completedAt as string) ||
			!isDeepStrictEqual(evidence.retirement, close.retirement) ||
			Date.parse(close.closeAcknowledgement!.observedAt) > Date.parse(close.retirement!.observedAt)
		)
			return false;
	} else if (evidence.state === "retired" || value.state === "complete") return false;
	return true;
}

type LifecycleReservation = Pick<SessionOperation, "id" | "ingressId" | "kind" | "startedAt" | "detail" | "lifecycle">;

/** Stable reservation identity, independent of changing lifecycle state and observation time. */
export function managedLifecycleAdmissionHash(operation: LifecycleReservation): string {
	const evidence = operation.lifecycle;
	if (
		!isNonEmptyString(operation.id) ||
		(operation.ingressId !== undefined && !isNonEmptyString(operation.ingressId)) ||
		!isTimestamp(operation.startedAt) ||
		!isManagedLifecycleEvidence(evidence) ||
		evidence.source === undefined ||
		!(
			(operation.kind === "create" && evidence.operation === "session.create") ||
			(operation.kind === "branch" && evidence.operation === "session.fork") ||
			(operation.kind === "resume" && evidence.operation === "session.resume")
		) ||
		evidence.payloadHash !== operation.detail ||
		Date.parse(evidence.recordedAt) < Date.parse(operation.startedAt)
	)
		throw new Error("Late lifecycle observation requires an exact control reservation.");
	return requestHash({
		id: operation.id,
		ingressId: operation.ingressId ?? operation.id,
		kind: operation.kind,
		startedAt: operation.startedAt,
		detail: operation.detail,
		lifecycle: Object.fromEntries(
			identityFields.filter(field => evidence[field] !== undefined).map(field => [field, evidence[field]]),
		),
	});
}

export function createManagedLateLifecycleAcknowledgement(
	admitted: SessionOperation,
	acknowledged: ManagedTurnAuthority,
	observedAt = new Date().toISOString(),
	endpointReceipt?: ManagedEndpointReceipt,
): ManagedLateLifecycleAcknowledgement {
	const admissionHash = managedLifecycleAdmissionHash(admitted);
	const evidence = admitted.lifecycle!;
	if (
		admitted.state !== "pending" ||
		evidence.state !== "invoking" ||
		proofFields.some(field => evidence[field] !== undefined) ||
		admitted.result !== undefined ||
		admitted.acknowledgedSuccessor !== undefined ||
		!isAuthority(acknowledged) ||
		(endpointReceipt !== undefined && !isManagedEndpointReceipt(endpointReceipt, acknowledged)) ||
		!preparedFields.every(field => acknowledged[field] === evidence.preparedAuthority[field]) ||
		!matchesPassiveLifecycleTarget(evidence, acknowledged) ||
		!isTimestamp(observedAt) ||
		Date.parse(observedAt) < Date.parse(evidence.recordedAt)
	)
		throw new Error("Late lifecycle observation does not match its original invocation.");
	return {
		kind: "original-admission-success",
		admissionHash,
		observedAt,
		acknowledged: { sessionId: acknowledged.sessionId, generation: acknowledged.generation },
		...(endpointReceipt === undefined ? {} : { endpointReceipt: copyManagedEndpointReceipt(endpointReceipt) }),
	};
}

export function isManagedLateLifecycleAcknowledgement(
	value: unknown,
	operation: SessionOperation,
): value is ManagedLateLifecycleAcknowledgement {
	try {
		return (
			hasOnlyKeys(value, ["kind", "admissionHash", "observedAt", "acknowledged", "endpointReceipt"]) &&
			value.kind === "original-admission-success" &&
			isHash(value.admissionHash) &&
			value.admissionHash === managedLifecycleAdmissionHash(operation) &&
			operation.state === "uncertain" &&
			operation.lifecycle?.state === "uncertain" &&
			proofFields.every(field => operation.lifecycle![field] === undefined) &&
			operation.result === undefined &&
			operation.completedAt === undefined &&
			operation.acknowledgedSuccessor === undefined &&
			isTimestamp(value.observedAt) &&
			Date.parse(value.observedAt) >= Date.parse(operation.lifecycle.recordedAt) &&
			hasOnlyKeys(value.acknowledged, ["sessionId", "generation"]) &&
			isNonEmptyString(value.acknowledged.sessionId) &&
			positiveInteger(value.acknowledged.generation) &&
			(!Object.hasOwn(value, "endpointReceipt") ||
				isManagedEndpointReceipt(
					value.endpointReceipt,
					value.acknowledged as { sessionId: string; generation: number },
				)) &&
			matchesPassiveLifecycleTarget(
				operation.lifecycle,
				value.acknowledged as { sessionId: string; generation: number },
			)
		);
	} catch {
		return false;
	}
}

export function copyManagedLateLifecycleAcknowledgement(
	value: ManagedLateLifecycleAcknowledgement,
): ManagedLateLifecycleAcknowledgement {
	return {
		...value,
		acknowledged: { ...value.acknowledged },
		...(value.endpointReceipt === undefined
			? {}
			: { endpointReceipt: copyManagedEndpointReceipt(value.endpointReceipt) }),
	};
}

export function copyManagedLateCreateAcknowledgement(
	value: ManagedLateCreateAcknowledgement,
): ManagedLateCreateAcknowledgement {
	return {
		...value,
		acknowledged: { ...value.acknowledged },
		...(value.endpointReceipt === undefined
			? {}
			: { endpointReceipt: copyManagedEndpointReceipt(value.endpointReceipt) }),
	};
}

function matchesPassiveLifecycleTarget(
	evidence: ManagedLifecycleEvidence,
	target: { readonly sessionId: string; readonly generation: number },
): boolean {
	return evidence.operation === "session.resume"
		? target.sessionId === evidence.source!.sessionId && target.generation === evidence.source!.generation
		: target.sessionId !== evidence.source!.sessionId;
}

/** Structural view shared by V3 and its inherited in-memory relational validator. */
export interface ManagedHistoricalAssociationOwner {
	readonly chatId: string;
	readonly projectId: string;
	readonly managedAuthority?: ManagedTurnAuthority;
	readonly historicalBinding?: HistoricalSessionBinding;
	readonly journal: readonly SessionOperation[];
	readonly prior?: ManagedHistoricalAssociationOwner;
	readonly reassignment?: {
		readonly sourceTombstone?: ManagedHistoricalAssociationOwner;
		readonly priorTombstone?: ManagedHistoricalAssociationOwner;
	};
}

export interface ManagedHistoricalSourceAssociation {
	readonly canonicalChatId: string;
	readonly operationId: string;
	readonly evidence: ManagedLifecycleEvidence;
	readonly historicalSource: ManagedHistoricalLifecycleSource;
}

/** Derives ownership only; never grants runtime authority or rewrites historical identity. */
export function managedHistoricalSourceAssociation(
	root: ManagedHistoricalAssociationOwner,
	history: HistoricalSessionBinding,
	operation?: SessionOperation,
): ManagedHistoricalSourceAssociation | undefined {
	if (!isHistoricalSessionBinding(history)) return undefined;
	const receipts = historicalSourceReceipts(root).filter(receipt => {
		const original = receipt.historicalSource.historicalBinding;
		return history.chatId === original.chatId;
	});
	// A second receipt for the same original graph is ambiguity, even if only one pointer fits.
	if (receipts.length !== 1) return undefined;
	const receipt = receipts[0]!;
	const original = receipt.historicalSource.historicalBinding;
	if (
		history.provenance.source !== original.provenance.source ||
		history.provenance.documentHash !== original.provenance.documentHash ||
		(history.principalId !== undefined && history.principalId !== receipt.evidence.preparedAuthority.principalId) ||
		(history.projectId === original.projectId &&
			history.canonicalWorkspace !== undefined &&
			history.canonicalWorkspace !== receipt.evidence.preparedAuthority.canonicalWorkspace)
	)
		return undefined;
	const prefix = original.provenance.nodeRef.split("/");
	const pointer = history.provenance.nodeRef.split("/");
	if (
		prefix.length !== 3 ||
		prefix[1] !== "mappings" ||
		!/^(0|[1-9][0-9]*)$/.test(prefix[2]!) ||
		!prefix.every((part, index) => part === pointer[index])
	)
		return undefined;
	const suffix = pointer.slice(prefix.length);
	let owner = receipt.owner;
	let cursor = 0;
	if (suffix[0] === "reassignment") {
		if (suffix[1] !== "sourceTombstone" && suffix[1] !== "priorTombstone") return undefined;
		const targetPath = [...prefix, ...suffix.slice(0, 2)];
		let descendant = receipt.owner.reassignment?.[suffix[1]] ?? receipt.owner.prior;
		if (descendant === undefined || descendant.historicalBinding?.provenance.nodeRef !== targetPath.join("/"))
			return undefined;
		cursor = 2;
		while (suffix[cursor] === "prior") {
			targetPath.push(suffix[cursor++]!);
			descendant = descendant.prior;
			if (descendant === undefined || descendant.historicalBinding?.provenance.nodeRef !== targetPath.join("/"))
				return undefined;
		}
		if (descendant.historicalBinding?.provenance.documentHash !== original.provenance.documentHash) return undefined;
		owner = descendant;
	}
	if (operation === undefined) {
		if (suffix.length === 0) {
			if (!isDeepStrictEqual(original, history)) return undefined;
		} else if (cursor === 0 || cursor !== suffix.length || !isDeepStrictEqual(owner.historicalBinding, history))
			return undefined;
	} else {
		if (
			suffix[cursor] !== "journal" ||
			!/^(0|[1-9][0-9]*)$/.test(suffix[cursor + 1] ?? "") ||
			suffix.length !== cursor + 3
		)
			return undefined;
		const index = Number(suffix[cursor + 1]);
		if (!Number.isSafeInteger(index) || (owner === receipt.owner && index >= receipt.index)) return undefined;
		const retained = owner.journal[index];
		if (retained === undefined || !isDeepStrictEqual(retained, operation)) return undefined;
		const binding =
			suffix[cursor + 2] === "result"
				? retained.result?.historicalBinding
				: suffix[cursor + 2] === "acknowledgedSuccessor" &&
						retained.acknowledgedSuccessor !== undefined &&
						"historicalBinding" in retained.acknowledgedSuccessor
					? retained.acknowledgedSuccessor.historicalBinding
					: undefined;
		if (!isDeepStrictEqual(binding, history) || history.projectId !== owner.projectId) return undefined;
	}
	return {
		canonicalChatId: root.chatId,
		operationId: receipt.operationId,
		evidence: receipt.evidence,
		historicalSource: receipt.historicalSource,
	};
}

/** Completed original-key reservations associate only through their exact retained publication. */
export function managedHistoricalPublicationAssociation(
	root: ManagedHistoricalAssociationOwner,
	provisional: ProvisionalSessionOperation,
): ManagedHistoricalSourceAssociation | undefined {
	const history = provisional.historicalBinding;
	if (
		provisional.state !== "complete" ||
		provisional.managedAuthority !== undefined ||
		(history === undefined
			? provisional.sessionId !== undefined || provisional.result !== undefined
			: !isHistoricalSessionBinding(history, provisional) ||
				!/^\/provisionalOperations\/(0|[1-9][0-9]*)$/.test(history.provenance.nodeRef))
	)
		return undefined;
	const matches: ManagedHistoricalSourceAssociation[] = [];
	for (const owner of historicalOwners(root))
		for (const published of owner.journal) {
			const result = published.result;
			if (
				published.state !== "complete" ||
				result?.historicalBinding === undefined ||
				result.managedAuthority !== undefined ||
				!isHistoricalSessionBinding(result.historicalBinding, result.mapping) ||
				result.mapping.operationId !== published.id ||
				(published.kind !== "prompt" && published.kind !== "create") ||
				(provisional.kind !== "prompt" && provisional.kind !== "create") ||
				published.id !== provisional.id ||
				(published.ingressId ?? published.id) !== (provisional.ingressId ?? provisional.id) ||
				published.detail !== provisional.detail ||
				published.startedAt !== provisional.startedAt ||
				published.completedAt !== provisional.completedAt ||
				!isDeepStrictEqual(published.lifecycle, provisional.lifecycle) ||
				(provisional.result !== undefined &&
					(history === undefined || !matchesHistoricalPublicationResult(provisional.result, result, history))) ||
				provisional.chatId !== result.mapping.chatId ||
				provisional.projectId !== result.mapping.projectId ||
				(provisional.sessionId !== undefined && provisional.sessionId !== result.mapping.sessionId) ||
				(history !== undefined &&
					(!compatibleHistoricalPublicationIdentity(history, result.historicalBinding, true) ||
						history.provenance.source !== result.historicalBinding.provenance.source ||
						history.provenance.documentHash !== result.historicalBinding.provenance.documentHash))
			)
				continue;
			const association = managedHistoricalSourceAssociation(root, result.historicalBinding, published);
			if (
				association !== undefined &&
				[history, provisional.result?.historicalBinding].every(
					binding =>
						binding === undefined ||
						((binding.principalId === undefined ||
							binding.principalId === association.evidence.preparedAuthority.principalId) &&
							(binding.projectId !== association.evidence.preparedAuthority.projectId ||
								binding.canonicalWorkspace === undefined ||
								binding.canonicalWorkspace === association.evidence.preparedAuthority.canonicalWorkspace)),
				)
			)
				matches.push(association);
		}
	return matches.length === 1 ? matches[0] : undefined;
}

function matchesHistoricalPublicationResult(
	provisional: SessionOperationResult,
	published: SessionOperationResult,
	reservation: HistoricalSessionBinding,
): boolean {
	const history = provisional.historicalBinding;
	if (
		provisional.managedAuthority !== undefined ||
		published.managedAuthority !== undefined ||
		!isHistoricalSessionBinding(history, provisional.mapping) ||
		published.historicalBinding === undefined ||
		history.provenance.nodeRef !== `${reservation.provenance.nodeRef}/result` ||
		history.provenance.source !== reservation.provenance.source ||
		history.provenance.documentHash !== reservation.provenance.documentHash ||
		!compatibleHistoricalPublicationIdentity(reservation, history, true)
	)
		return false;
	// The two original occurrences have different pointers and source-node digests.
	// Compare their retained content, not those distinct provenance receipts.
	const {
		historicalBinding: _provisionalHistory,
		managedAuthority: _provisionalAuthority,
		...provisionalPayload
	} = provisional;
	const {
		historicalBinding: _publishedHistory,
		managedAuthority: _publishedAuthority,
		...publishedPayload
	} = published;
	return (
		compatibleHistoricalPublicationIdentity(history, published.historicalBinding) &&
		isDeepStrictEqual(provisionalPayload, publishedPayload)
	);
}

function compatibleHistoricalPublicationIdentity(
	left: HistoricalSessionBinding,
	right: HistoricalSessionBinding,
	unassignedReservation = false,
): boolean {
	return (
		(["chatId", "projectId"] as const).every(field => left[field] === right[field]) &&
		((unassignedReservation && left.sessionId === undefined) || left.sessionId === right.sessionId) &&
		(["principalId", "canonicalWorkspace"] as const).every(
			field => left[field] === undefined || right[field] === undefined || left[field] === right[field],
		)
	);
}

/** Whether an original chat is claimed; unresolved reservations must not become orphan aliases. */
export function hasManagedHistoricalSourceChat(root: ManagedHistoricalAssociationOwner, chatId: string): boolean {
	return historicalSourceReceipts(root).some(receipt => receipt.historicalSource.historicalBinding.chatId === chatId);
}

function historicalOwners(root: ManagedHistoricalAssociationOwner): ManagedHistoricalAssociationOwner[] {
	const owners = [root];
	const seen = new Set<ManagedHistoricalAssociationOwner>(owners);
	let current = root.reassignment?.sourceTombstone ?? root.reassignment?.priorTombstone ?? root.prior;
	while (current !== undefined && !seen.has(current)) {
		owners.push(current);
		seen.add(current);
		current = current.prior;
	}
	return owners;
}

function historicalSourceReceipts(root: ManagedHistoricalAssociationOwner) {
	const receipts: (ManagedHistoricalSourceAssociation & {
		owner: ManagedHistoricalAssociationOwner;
		index: number;
	})[] = [];
	if (
		root.managedAuthority === undefined ||
		root.historicalBinding !== undefined ||
		!isAuthority(lifecycleExactAuthority(root.managedAuthority))
	)
		return receipts;
	for (const owner of historicalOwners(root))
		for (const [index, operation] of owner.journal.entries()) {
			const evidence = operation.lifecycle;
			if (
				operation.kind !== "resume" ||
				operation.state !== "complete" ||
				!operation.id.startsWith("migration:resume:") ||
				operation.id.length === "migration:resume:".length ||
				!isManagedLifecycleEvidence(evidence) ||
				evidence.operation !== "session.resume" ||
				evidence.state !== "active_generation_proven" ||
				evidence.historicalSource === undefined ||
				evidence.acknowledged === undefined ||
				evidence.proven === undefined ||
				operation.detail !== evidence.payloadHash ||
				!isTimestamp(operation.startedAt) ||
				!isTimestamp(operation.completedAt) ||
				Date.parse(operation.startedAt) > Date.parse(evidence.recordedAt) ||
				Date.parse(evidence.recordedAt) > Date.parse(operation.completedAt)
			)
				continue;
			const prepared = evidence.preparedAuthority;
			const canonicalChatId = JSON.stringify([prepared.principalId, prepared.chatId]);
			const authority = owner.managedAuthority;
			if (
				owner.historicalBinding !== undefined ||
				authority === undefined ||
				root.chatId !== canonicalChatId ||
				owner.chatId !== canonicalChatId ||
				!isAuthority(lifecycleExactAuthority(authority)) ||
				root.managedAuthority.chatId !== canonicalChatId ||
				root.managedAuthority.principalId !== prepared.principalId ||
				authority.chatId !== canonicalChatId ||
				authority.principalId !== prepared.principalId ||
				owner.projectId !== prepared.projectId ||
				authority.projectId !== prepared.projectId ||
				authority.canonicalWorkspace !== prepared.canonicalWorkspace
			)
				continue;
			if (operation.result !== undefined) {
				const actual = operation.result.managedAuthority;
				if (
					actual === undefined ||
					operation.result.historicalBinding !== undefined ||
					operation.result.kind === "close" ||
					operation.result.mapping.chatId !== canonicalChatId ||
					operation.result.mapping.projectId !== owner.projectId ||
					operation.result.mapping.sessionId !== evidence.acknowledged.sessionId ||
					operation.result.mapping.operationId !== operation.id ||
					actual.chatId !== canonicalChatId ||
					!(
						[...scopeFields.filter(field => field !== "chatId"), "requestKey", "sessionId", "generation"] as const
					).every(field => actual[field] === evidence.acknowledged![field])
				)
					continue;
			}
			receipts.push({
				canonicalChatId,
				operationId: operation.id,
				evidence,
				historicalSource: evidence.historicalSource,
				owner,
				index,
			});
		}
	return receipts;
}

type EvidenceInput = Pick<
	ManagedLifecycleEvidence,
	"operation" | "preparedAuthority" | "source" | "historicalSource" | "target" | "payloadHash"
>;
type EvidencePatch = Partial<
	Pick<ManagedLifecycleEvidence, "acknowledged" | "endpointReceipt" | "proven" | "retirement" | "closeAcknowledgement">
>;
const preparedFields = [
	"principalId",
	"projectId",
	"canonicalWorkspace",
	"chatId",
	"leaseId",
	"epoch",
	"requestKey",
] as const;
const scopeFields = ["principalId", "projectId", "canonicalWorkspace", "chatId", "leaseId", "epoch"] as const;
const proofFields = ["acknowledged", "endpointReceipt", "proven", "retirement", "closeAcknowledgement"] as const;
const savedTranscriptFields = ["dev", "ino", "size", "mtimeMs", "mtimeNs", "sha256"] as const;
const identityFields = [
	"operation",
	"actor",
	"requestKey",
	"requestHash",
	"payloadHash",
	"preparedAuthority",
	"source",
	"historicalSource",
	"sourceProofRef",
	"target",
] as const;
const operations = new Set(["session.create", "session.resume", "session.fork", "session.close", "session.delete"]);
const forbiddenField =
	/^(?:raw.*|.*token.*|.*secret.*|.*password.*|.*credential.*|.*descriptor.*|.*attachment.*|.*tmux.*|pid|process.*|.*incarnation.*|url|endpointUrl|authorization|sessionFile|sessionPath|sourceSessionPath|stateRoot)$/i;

export function lifecyclePreparedAuthority(authority: ManagedPreparedTurnAuthority): ManagedPreparedTurnAuthority {
	return {
		principalId: authority.principalId,
		projectId: authority.projectId,
		canonicalWorkspace: authority.canonicalWorkspace,
		chatId: authority.chatId,
		leaseId: authority.leaseId,
		epoch: authority.epoch,
		requestKey: authority.requestKey,
	};
}
export function lifecycleExactAuthority(authority: ManagedTurnAuthority): ManagedTurnAuthority {
	return {
		...lifecyclePreparedAuthority(authority),
		sessionId: authority.sessionId,
		generation: authority.generation,
	};
}

export function createManagedLifecycleEvidence(
	input: EvidenceInput,
	recordedAt = new Date().toISOString(),
): ManagedLifecycleEvidence {
	const actor = { id: input.preparedAuthority.principalId, namespace: "openwebui-gjc-adapter" } as const;
	const requestKey = input.preparedAuthority.requestKey;
	const value: ManagedLifecycleEvidence = {
		operation: input.operation,
		preparedAuthority: input.preparedAuthority,
		target: input.target,
		payloadHash: input.payloadHash,
		...(input.source === undefined ? {} : { source: input.source }),
		...(input.historicalSource === undefined ? {} : { historicalSource: input.historicalSource }),
		actor,
		requestKey,
		requestHash: requestHash({ operation: input.operation, actor, requestKey, target: input.target }),
		state: "intent_prepared",
		recordedAt,
	};
	assertEvidence(value);
	return copyManagedLifecycleEvidence(value);
}

/** Initializes a distinct close operation; the store atomically binds its source proof. */
export function createManagedRetirementEvidence(
	input: Omit<EvidenceInput, "operation" | "source"> & {
		readonly operation: "session.close" | "session.delete";
		readonly source: ManagedTurnAuthority;
		readonly sourceOperationId: string;
		readonly sourceEvidence: ManagedLifecycleEvidence;
	},
	recordedAt = new Date().toISOString(),
): ManagedLifecycleEvidence {
	assertEvidence(input.sourceEvidence);
	const prior = input.sourceEvidence;
	if (
		!isNonEmptyString(input.sourceOperationId) ||
		prior.state !== "active_generation_proven" ||
		prior.acknowledged === undefined ||
		prior.proven === undefined ||
		![...scopeFields, "sessionId", "generation"].every(
			field => Reflect.get(prior.acknowledged!, field) === Reflect.get(input.source, field),
		)
	)
		throw new Error("Managed retirement requires matching persisted active-generation proof.");
	if (input.operation === "session.close" && !isDeepStrictEqual(input.target, requireManagedEndpointReceipt(prior)))
		throw new Error("Managed close target must equal its original source endpoint receipt.");
	const intent = createManagedLifecycleEvidence(input, recordedAt);
	return copyManagedLifecycleEvidence({
		...intent,
		state: "closing",
		sourceProofRef: {
			operationId: input.sourceOperationId,
			evidenceHash: managedLifecycleEvidenceHash(prior),
		},
	});
}

export function managedLifecycleEvidenceHash(evidence: ManagedLifecycleEvidence): string {
	assertEvidence(evidence);
	return requestHash(evidence);
}

export function transitionManagedLifecycleEvidence(
	current: ManagedLifecycleEvidence,
	state: ManagedLifecycleState,
	patch: EvidencePatch = {},
	recordedAt?: string,
): ManagedLifecycleEvidence {
	if (!hasOnlyKeys(patch, proofFields)) throw new Error("Lifecycle transition patch may contain only proof fields.");
	const next = {
		...current,
		...patch,
		state,
		recordedAt: recordedAt ?? (state === current.state ? current.recordedAt : new Date().toISOString()),
	};
	assertManagedLifecycleEvidenceUpdate(current, next);
	return copyManagedLifecycleEvidence(next);
}

export function assertManagedLifecycleEvidenceUpdate(
	current: ManagedLifecycleEvidence,
	next: ManagedLifecycleEvidence,
): void {
	assertEvidence(current);
	assertEvidence(next);
	for (const field of identityFields)
		if (!isDeepStrictEqual(current[field], next[field]))
			throw new Error(`Immutable managed lifecycle identity changed: ${field}.`);
	if (Date.parse(next.recordedAt) < Date.parse(current.recordedAt))
		throw new Error("Managed lifecycle evidence time moved backwards.");
	if (current.acknowledged !== undefined && !isDeepStrictEqual(current.endpointReceipt, next.endpointReceipt))
		throw new Error("Managed endpoint receipt presence and absence are sealed by the first acknowledgement.");
	if (
		current.endpointReceipt === undefined &&
		next.endpointReceipt !== undefined &&
		(current.acknowledged !== undefined || current.state !== "invoking" || next.state !== "acknowledged_unproven")
	)
		throw new Error("Managed endpoint receipt must accompany the first lifecycle acknowledgement atomically.");
	if (current.state === next.state) {
		if (
			(current.state === "closing" ||
				(current.state === "uncertain" &&
					current.operation === "session.close" &&
					current.sourceProofRef !== undefined &&
					isManagedEndpointReceipt(current.target, current.source))) &&
			current.closeAcknowledgement === undefined &&
			next.closeAcknowledgement !== undefined &&
			Date.parse(next.closeAcknowledgement.observedAt) >= Date.parse(current.recordedAt) &&
			isDeepStrictEqual(
				{ ...current, closeAcknowledgement: next.closeAcknowledgement, recordedAt: next.recordedAt },
				next,
			)
		)
			return;
		if (!isDeepStrictEqual(current, next)) throw new Error("Only an exact duplicate lifecycle update is idempotent.");
		return;
	}
	assertManagedLifecycleTransition(current.state, next.state);
	if (next.state === "terminal_failure" && current.state !== "intent_prepared")
		throw new Error(
			"Post-invocation termination requires explicit public not-applied evidence, which this receipt cannot represent.",
		);
	if (
		current.state === "uncertain" &&
		["acknowledged_unproven", "active_generation_proven", "cleanup_pending"].includes(next.state)
	)
		throw new Error(
			"Uncertain lifecycle recovery requires fresh public request-bound evidence, which this receipt cannot represent.",
		);
	if (current.state === "invoking" && next.state === "cleanup_pending")
		throw new Error(
			"Cleanup invocation recovery requires explicit public not-applied evidence, which this receipt cannot represent.",
		);
	if (current.state === "invoking" && current.acknowledged !== undefined && next.state === "acknowledged_unproven")
		throw new Error("Cleanup invocation cannot reuse an earlier acknowledgement as fresh public outcome evidence.");
	if (current.state === "closing" && next.state === "active_generation_proven")
		throw new Error(
			"Close restoration requires explicit public not-applied evidence, which this receipt cannot represent.",
		);
	if (current.state === "cleanup_uncertain" && next.state === "cleanup_pending")
		throw new Error(
			"Cleanup retry requires explicit public not-applied evidence, which this receipt cannot represent.",
		);
	for (const field of proofFields)
		if (current[field] !== undefined && !isDeepStrictEqual(current[field], next[field]))
			throw new Error(`Managed lifecycle proof cannot be removed or replaced: ${field}.`);
	if (
		next.retirement !== undefined &&
		current.retirement === undefined &&
		Date.parse(next.retirement.observedAt) < Date.parse(current.recordedAt)
	)
		throw new Error("Retirement observation predates the recorded lifecycle operation.");
}

export function copyManagedLifecycleEvidence(value: ManagedLifecycleEvidence): ManagedLifecycleEvidence {
	assertEvidence(value);
	return JSON.parse(canonicalJson(value)) as ManagedLifecycleEvidence;
}

export function isManagedLifecycleEvidence(value: unknown): value is ManagedLifecycleEvidence {
	try {
		assertEvidence(value);
		return true;
	} catch {
		return false;
	}
}

function assertEvidence(value: unknown): asserts value is ManagedLifecycleEvidence {
	if (
		!hasOnlyKeys(value, [...identityFields, ...proofFields, "state", "recordedAt"]) ||
		!operations.has(String(value.operation)) ||
		!isManagedLifecycleState(value.state) ||
		!isTimestamp(value.recordedAt) ||
		!isPrepared(value.preparedAuthority) ||
		!isRecord(value.target) ||
		!isHash(value.payloadHash) ||
		!isHash(value.requestHash) ||
		!hasOnlyKeys(value.actor, ["id", "namespace"]) ||
		value.actor.id !== value.preparedAuthority.principalId ||
		value.actor.namespace !== "openwebui-gjc-adapter" ||
		value.requestKey !== value.preparedAuthority.requestKey
	)
		throw new Error("Invalid managed lifecycle evidence identity.");
	if (
		value.requestHash !==
		requestHash({
			operation: value.operation,
			actor: value.actor,
			requestKey: value.requestKey,
			target: value.target,
		})
	)
		throw new Error("Managed lifecycle request hash does not match its public request.");
	const prepared = value.preparedAuthority;
	const source = value.source;
	const historicalSource = value.historicalSource;
	if (historicalSource !== undefined) {
		if (
			value.operation !== "session.resume" ||
			source !== undefined ||
			value.sourceProofRef !== undefined ||
			!isManagedHistoricalLifecycleSource(historicalSource, prepared)
		)
			throw new Error("Managed bootstrap resume requires an exclusive matching historical source.");
		validateHistoricalTarget(value.target, prepared, historicalSource);
		canonicalJson(value.target);
	} else if (value.operation === "session.close" && value.target.endpointIncarnation !== undefined) {
		if (!isManagedEndpointReceipt(value.target))
			throw new Error("Managed close target requires an exact endpoint receipt.");
		const { endpointIncarnation: _endpointIncarnation, ...target } = value.target;
		canonicalJson(target, true);
	} else canonicalJson(value.target, true);
	if (
		value.sourceProofRef !== undefined &&
		(!hasOnlyKeys(value.sourceProofRef, ["operationId", "evidenceHash"]) ||
			!isNonEmptyString(value.sourceProofRef.operationId) ||
			!isHash(value.sourceProofRef.evidenceHash) ||
			(value.operation !== "session.close" && value.operation !== "session.delete"))
	)
		throw new Error("Managed retirement source proof reference is invalid.");
	if (source !== undefined && (!isAuthority(source) || !scopeFields.every(field => source[field] === prepared[field])))
		throw new Error("Managed lifecycle source crosses its prepared tenant fence.");
	if (value.operation !== "session.create" && source === undefined && historicalSource === undefined)
		throw new Error("Managed lifecycle requires an exact source authority.");
	if (historicalSource === undefined)
		validateTarget(
			value.operation as ManagedLifecycleEvidence["operation"],
			value.target,
			prepared,
			source as ManagedTurnAuthority | undefined,
		);
	const acknowledged = value.acknowledged;
	if (acknowledged !== undefined) {
		if (!isAuthority(acknowledged) || !preparedFields.every(field => acknowledged[field] === prepared[field]))
			throw new Error("Managed lifecycle acknowledgement crosses its prepared authority.");
		if (
			historicalSource !== undefined &&
			isManagedHistoricalLifecycleSource(historicalSource, prepared) &&
			acknowledged.sessionId !== historicalSource.historicalBinding.sessionId
		)
			throw new Error("Managed bootstrap acknowledgement changed the full historical session identity.");
		if (source !== undefined && isAuthority(source)) {
			if (
				(value.operation === "session.create" || value.operation === "session.fork") &&
				acknowledged.sessionId === source.sessionId
			)
				throw new Error("Managed successor acknowledgement reused the source identity.");
			if (
				!["session.create", "session.fork"].includes(String(value.operation)) &&
				(acknowledged.sessionId !== source.sessionId || acknowledged.generation !== source.generation)
			)
				throw new Error("Managed lifecycle acknowledgement changed the exact source generation.");
		}
	}
	if (
		value.endpointReceipt !== undefined &&
		(!["session.create", "session.resume", "session.fork"].includes(String(value.operation)) ||
			!isAuthority(acknowledged) ||
			!isManagedEndpointReceipt(value.endpointReceipt, acknowledged))
	)
		throw new Error("Managed endpoint receipt does not match its original lifecycle acknowledgement.");
	if (value.proven !== undefined && (!isAuthority(acknowledged) || !isProof(value.proven, acknowledged)))
		throw new Error("Managed lifecycle proof does not match its acknowledged generation.");
	const retiringSource = value.operation === "session.close" || value.operation === "session.delete";
	if (value.closeAcknowledgement !== undefined) {
		const ack = value.closeAcknowledgement;
		if (
			!retiringSource ||
			!isAuthority(source) ||
			!hasOnlyKeys(ack, ["sessionId", "generation", "observedAt"]) ||
			ack.sessionId !== source.sessionId ||
			ack.generation !== source.generation ||
			!isTimestamp(ack.observedAt) ||
			Date.parse(ack.observedAt) > Date.parse(value.recordedAt)
		)
			throw new Error("Managed close acknowledgement does not match its exact source.");
	}
	if (
		["acknowledged_unproven", "active_generation_proven", "cleanup_pending", "cleanup_uncertain"].includes(
			value.state,
		) &&
		acknowledged === undefined &&
		!(retiringSource && value.state === "acknowledged_unproven")
	)
		throw new Error("Managed lifecycle state requires acknowledged target authority.");
	if (
		value.state === "active_generation_proven" &&
		(value.proven === undefined || ["session.close", "session.delete"].includes(String(value.operation)))
	)
		throw new Error("Managed active state requires target generation proof.");
	if (value.state === "closing" && source === undefined && value.proven === undefined)
		throw new Error("Managed closing state requires an exact prior authority.");
	if (value.state === "intent_prepared" && proofFields.some(field => value[field] !== undefined))
		throw new Error("Prepared lifecycle intent cannot contain outcome proof.");
	if (value.retirement !== undefined) {
		const retired = value.retirement;
		const expected =
			value.operation === "session.close" || value.operation === "session.delete" ? source : acknowledged;
		if (
			!isAuthority(expected) ||
			!hasOnlyKeys(retired, ["sessionId", "generation", "acknowledgedSessionId", "observedAt", "evidence"]) ||
			retired.sessionId !== expected.sessionId ||
			retired.generation !== expected.generation ||
			retired.acknowledgedSessionId !== retired.sessionId ||
			!isTimestamp(retired.observedAt) ||
			Date.parse(retired.observedAt) > Date.parse(value.recordedAt) ||
			!isRetirementProof(retired.evidence)
		)
			throw new Error("Managed lifecycle retirement lacks matching exact-generation success and positive evidence.");
		if (
			value.sourceProofRef !== undefined &&
			(!isRecord(value.closeAcknowledgement) ||
				!isTimestamp(value.closeAcknowledgement.observedAt) ||
				Date.parse(value.closeAcknowledgement.observedAt) > Date.parse(retired.observedAt))
		)
			throw new Error("Managed retirement requires its prior durable successful close acknowledgement.");
	}
	if (value.state === "retired" && value.retirement === undefined)
		throw new Error("Retired lifecycle requires positive retirement proof.");
	if (value.retirement !== undefined && value.state !== "retired")
		throw new Error("Retirement proof belongs only to retired lifecycle state.");
	canonicalJson(value);
}

function isManagedHistoricalLifecycleSource(
	value: unknown,
	prepared: ManagedPreparedTurnAuthority,
): value is ManagedHistoricalLifecycleSource {
	if (
		!hasOnlyKeys(value, ["kind", "manifestDigest", "historicalBinding", "savedSession"]) ||
		value.kind !== "bootstrap-history" ||
		!isHash(value.manifestDigest) ||
		!isHistoricalSessionBinding(value.historicalBinding)
	)
		return false;
	const historical = value.historicalBinding;
	return (
		isNonEmptyString(historical.sessionId) &&
		historical.projectId === prepared.projectId &&
		(historical.chatId === prepared.chatId ||
			historical.chatId === JSON.stringify([prepared.principalId, prepared.chatId])) &&
		(historical.principalId === undefined || historical.principalId === prepared.principalId) &&
		(historical.canonicalWorkspace === undefined || historical.canonicalWorkspace === prepared.canonicalWorkspace) &&
		isHistoricalSavedSession(value.savedSession, historical.sessionId, prepared.canonicalWorkspace)
	);
}

export function isHistoricalSavedSession(
	value: unknown,
	sessionId: string,
	workspace: string,
): value is ManagedHistoricalSavedSession {
	if (
		!hasOnlyKeys(value, ["id", "path", "identity"]) ||
		value.id !== sessionId ||
		!isNonEmptyString(value.path) ||
		!isAbsolute(value.path) ||
		resolve(value.path) !== value.path ||
		/[\p{Cc}]/u.test(value.path) ||
		resolve(workspace) !== workspace ||
		/[\p{Cc}]/u.test(workspace)
	)
		return false;
	const within = relative(workspace, value.path);
	if (within === "" || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) return false;
	const identity = value.identity;
	return (
		hasOnlyKeys(identity, [...savedTranscriptFields, "nlink", "ctimeNs"]) &&
		[identity.dev, identity.ino, identity.mtimeNs, identity.nlink, identity.ctimeNs].every(isDecimalIdentity) &&
		typeof identity.size === "number" &&
		Number.isSafeInteger(identity.size) &&
		identity.size >= 0 &&
		typeof identity.mtimeMs === "number" &&
		Number.isFinite(identity.mtimeMs) &&
		identity.mtimeMs >= 0 &&
		isHash(identity.sha256)
	);
}

function isDecimalIdentity(value: unknown): value is string {
	return typeof value === "string" && /^[0-9]+$/.test(value);
}

export function isHistoricalSessionBinding(
	value: unknown,
	identity?: { readonly chatId?: unknown; readonly projectId?: unknown; readonly sessionId?: unknown },
): value is HistoricalSessionBinding {
	if (
		!hasOnlyKeys(value, [
			"kind",
			"chatId",
			"projectId",
			"sessionId",
			"principalId",
			"canonicalWorkspace",
			"reason",
			"provenance",
		]) ||
		value.kind !== "unbound-history" ||
		!isNonEmptyString(value.chatId) ||
		!isNonEmptyString(value.projectId) ||
		(value.sessionId !== undefined && !isNonEmptyString(value.sessionId)) ||
		(value.principalId !== undefined && !isNonEmptyString(value.principalId)) ||
		(value.canonicalWorkspace !== undefined &&
			(!isNonEmptyString(value.canonicalWorkspace) || !isAbsolute(value.canonicalWorkspace)))
	)
		return false;
	if (
		identity !== undefined &&
		(value.chatId !== identity.chatId ||
			value.projectId !== identity.projectId ||
			value.sessionId !== identity.sessionId)
	)
		return false;
	const principal = scopedHistoricalPrincipal(value.chatId);
	if (principal !== undefined && value.principalId !== principal) return false;
	if (
		value.reason !==
		(value.principalId === undefined || value.canonicalWorkspace === undefined
			? "ownership-unresolved"
			: "generation-unproven")
	)
		return false;
	const provenance = value.provenance;
	return (
		hasOnlyKeys(provenance, ["source", "documentHash", "nodeRef", "nodeHash"]) &&
		Object.keys(provenance).length === 4 &&
		provenance.source === "v2" &&
		isHash(provenance.documentHash) &&
		isHash(provenance.nodeHash) &&
		typeof provenance.nodeRef === "string" &&
		/^\/(?:mappings|provisionalOperations)\/(?:0|[1-9][0-9]*)(?:\/(?:[^~/]|~[01])+)*$/.test(provenance.nodeRef)
	);
}

function scopedHistoricalPrincipal(chatId: string): string | undefined {
	try {
		const scope: unknown = JSON.parse(chatId);
		return Array.isArray(scope) &&
			scope.length === 2 &&
			scope.every(isNonEmptyString) &&
			JSON.stringify(scope) === chatId
			? scope[0]
			: undefined;
	} catch {
		return undefined;
	}
}

function validateHistoricalTarget(
	target: Record<string, unknown>,
	prepared: ManagedPreparedTurnAuthority,
	source: ManagedHistoricalLifecycleSource,
): void {
	const identity = target.sessionIdentity;
	if (
		!hasOnlyKeys(target, ["sessionId", "cwd", "sessionPath", "sessionIdentity"]) ||
		target.sessionId !== source.savedSession.id ||
		target.cwd !== prepared.canonicalWorkspace ||
		target.sessionPath !== source.savedSession.path ||
		!hasOnlyKeys(identity, savedTranscriptFields) ||
		!savedTranscriptFields.every(field => identity[field] === source.savedSession.identity[field])
	)
		throw new Error(
			"Managed bootstrap target requires the exact public saved-session selection and transcript identity projection.",
		);
}

function validateTarget(
	operation: ManagedLifecycleEvidence["operation"],
	target: Record<string, unknown>,
	prepared: ManagedPreparedTurnAuthority,
	source?: ManagedTurnAuthority,
): void {
	const allowed = {
		"session.create": ["kind", "path", "cwd", "body", "modelPreset", "readiness", "readinessTimeoutMs"],
		"session.resume": ["sessionId", "sessionIdOrPrefix", "path", "cwd", "body", "modelPreset", "readinessTimeoutMs"],
		"session.fork": ["sourceSessionId", "cwd", "body", "modelPreset", "readinessTimeoutMs"],
		"session.close": ["sessionId", "endpointGeneration", "endpointIncarnation"],
		"session.delete": ["sessionId", "cwd"],
	};
	if (Object.keys(target).some(key => !allowed[operation].includes(key)))
		throw new Error("Lifecycle target contains undeclared authority.");
	for (const field of ["cwd", "path"])
		if (target[field] !== undefined && target[field] !== prepared.canonicalWorkspace)
			throw new Error("Lifecycle target workspace is foreign.");
	if (
		operation === "session.create" &&
		target.cwd !== prepared.canonicalWorkspace &&
		target.path !== prepared.canonicalWorkspace
	)
		throw new Error("Lifecycle create target requires its canonical workspace.");
	if (target.kind !== undefined && target.kind !== "existing_path")
		throw new Error("Lifecycle evidence requires an existing canonical workspace.");
	if (
		operation === "session.fork" &&
		(target.sourceSessionId !== source?.sessionId || target.cwd !== prepared.canonicalWorkspace)
	)
		throw new Error("Lifecycle fork target does not match its source.");
	if (
		operation === "session.resume" &&
		((target.sessionId ?? target.sessionIdOrPrefix) !== source?.sessionId ||
			(target.sessionId !== undefined && target.sessionId !== source?.sessionId) ||
			(target.sessionIdOrPrefix !== undefined && target.sessionIdOrPrefix !== source?.sessionId))
	)
		throw new Error("Lifecycle resume target must name the exact source session.");
	if ((operation === "session.close" || operation === "session.delete") && target.sessionId !== source?.sessionId)
		throw new Error("Lifecycle retirement target must name the exact source session.");
	if (target.endpointGeneration !== undefined && target.endpointGeneration !== source?.generation)
		throw new Error("Lifecycle target generation does not match its source.");
}

function isPrepared(value: unknown): value is ManagedPreparedTurnAuthority {
	return (
		hasOnlyKeys(value, preparedFields) &&
		preparedFields.every(field => isNonEmptyString(value[field])) &&
		isAbsolute(value.canonicalWorkspace as string)
	);
}
function isAuthority(value: unknown): value is ManagedTurnAuthority {
	return (
		hasOnlyKeys(value, [...preparedFields, "sessionId", "generation"]) &&
		preparedFields.every(field => isNonEmptyString(value[field])) &&
		isAbsolute(value.canonicalWorkspace as string) &&
		isNonEmptyString(value.sessionId) &&
		positiveInteger(value.generation)
	);
}
function isProof(value: unknown, authority: ManagedTurnAuthority): value is ManagedGenerationProof {
	return (
		hasOnlyKeys(value, ["kind", "sessionId", "generation", "leaseId", "epoch"]) &&
		value.kind === "managed-generation" &&
		value.sessionId === authority.sessionId &&
		value.generation === authority.generation &&
		value.leaseId === authority.leaseId &&
		value.epoch === authority.epoch
	);
}
function isRetirementProof(value: unknown): boolean {
	if (!isRecord(value)) return false;
	canonicalJson(value, true);
	return (
		value.source === "session_index" &&
		["host_unregistered", "session_closed", "session_deleted"].includes(String(value.event)) &&
		positiveInteger(value.observedIndexSeq) &&
		positiveInteger(value.evidenceIndexSeq) &&
		value.evidenceIndexSeq <= value.observedIndexSeq
	);
}
function positiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function isHash(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function requestHash(request: unknown): string {
	return createHash("sha256").update(canonicalJson(request)).digest("hex");
}
function canonicalJson(value: unknown, rejectAuthority = false, depth = 0): string {
	if (depth > 64) throw new Error("Managed lifecycle evidence is too deeply nested.");
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value))
	)
		return JSON.stringify(value);
	if (Array.isArray(value))
		return `[${Array.from(value, child => canonicalJson(child, rejectAuthority, depth + 1)).join(",")}]`;
	if (!isRecord(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null))
		throw new Error("Managed lifecycle evidence must contain only JSON values.");
	return `{${Object.keys(value)
		.sort()
		.map(key => {
			if (rejectAuthority && forbiddenField.test(key))
				throw new Error("Managed lifecycle evidence contains forbidden raw authority.");
			return `${JSON.stringify(key)}:${canonicalJson(value[key], rejectAuthority, depth + 1)}`;
		})
		.join(",")}}`;
}
