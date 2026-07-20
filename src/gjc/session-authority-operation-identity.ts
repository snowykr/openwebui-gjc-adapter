import type { ProvisionalSessionOperation, SessionOperation } from "./session-authority-types";
import { operationIdentifiers } from "./session-operation-codec";

type OperationIdentity = Pick<SessionOperation | ProvisionalSessionOperation, "id" | "ingressId">;
type ProvisionalOperationInput = Omit<ProvisionalSessionOperation, "state" | "startedAt" | "completedAt">;

export function assertReservableIdentity(
	operation: ProvisionalOperationInput,
	journal: readonly SessionOperation[],
	provisional: readonly ProvisionalSessionOperation[],
): void {
	const ingressId = operation.ingressId ?? operation.id;
	if (hasIdentityCollision(operation, journal) || hasIdentityCollision(operation, provisional))
		throw new Error(`Session ingress ${ingressId} conflicts with an existing operation.`);
	if (hasIdentityOverlap(operation, journal))
		throw new Error(`Session operation ${ingressId} requires reconciliation.`);
}

export function assertPublishableIdentity(
	operation: ProvisionalOperationInput,
	reserved: ProvisionalSessionOperation | undefined,
	journal: readonly SessionOperation[],
	provisional: readonly ProvisionalSessionOperation[],
): ProvisionalSessionOperation {
	const ingressId = operation.ingressId ?? operation.id;
	if (
		reserved === undefined ||
		reserved.state !== "pending" ||
		!sameOperationIdentity(reserved, operation) ||
		reserved.kind !== operation.kind ||
		reserved.projectId !== operation.projectId ||
		reserved.detail !== operation.detail
	)
		throw new Error(`Session operation ${ingressId} requires reconciliation.`);
	if (
		hasIdentityCollision(operation, journal) ||
		hasIdentityCollision(
			operation,
			provisional.filter(candidate => candidate !== reserved),
		)
	)
		throw new Error(`Session ingress ${ingressId} conflicts with an existing operation.`);
	return reserved;
}

export function assertBeginableIdentity(
	operation: Omit<SessionOperation, "state" | "startedAt" | "completedAt">,
	provisional: readonly ProvisionalSessionOperation[],
): void {
	const ingressId = operation.ingressId ?? operation.id;
	if (hasIdentityCollision(operation, provisional))
		throw new Error(`Session ingress ${ingressId} conflicts with an existing operation.`);
	if (hasIdentityOverlap(operation, provisional))
		throw new Error(`Session operation ${ingressId} requires reconciliation.`);
}

export function hasIdentityOverlap(incoming: OperationIdentity, candidates: readonly OperationIdentity[]): boolean {
	const identifiers = operationIdentifiers(incoming);
	return candidates.some(candidate =>
		operationIdentifiers(candidate).some(identifier => identifiers.includes(identifier)),
	);
}

export function hasIdentityCollision(incoming: OperationIdentity, candidates: readonly OperationIdentity[]): boolean {
	return candidates.some(
		candidate => hasIdentityOverlap(incoming, [candidate]) && !sameOperationIdentity(incoming, candidate),
	);
}

export function sameOperationIdentity(left: OperationIdentity, right: OperationIdentity): boolean {
	return operationIdentity(left) === operationIdentity(right);
}

export function operationIdentity(operation: OperationIdentity): string {
	return JSON.stringify([operation.id, operation.ingressId ?? operation.id]);
}
