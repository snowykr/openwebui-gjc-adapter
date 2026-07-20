import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";
import type { PublicSdkSessionCoordinatorOwner } from "./public-sdk-contract";
import { SdkV3OperationError } from "./sdk-v3-protocol";

export interface PublicSdkSessionCoordinatorScope { readonly cwd: string; readonly sessionId: string; }
interface SessionMutationCoordinator { owner: PublicSdkSessionCoordinatorOwner | undefined; tail: Promise<void>; }
const coordinators = new Map<string, SessionMutationCoordinator>();
const ambientOwner = new AsyncLocalStorage<PublicSdkSessionCoordinatorOwner>();

/** Serializes mutations and descriptor refreshes by canonical session lookup scope. */
export async function withPublicSdkSessionMutationCoordinator<T>(scope: PublicSdkSessionCoordinatorScope, owner: PublicSdkSessionCoordinatorOwner, effect: () => Promise<T>): Promise<T> {
	if (typeof owner !== "object" || owner === null) throw new SdkV3OperationError("coordinator_owner_mismatch", "Session mutation coordinator owner must be a non-null object");
	const key = `${resolve(scope.cwd)}\u0000${scope.sessionId}`;
	const active = coordinators.get(key);
	const storedOwner = ambientOwner.getStore();
	if (storedOwner !== undefined && storedOwner !== owner) {
		throw new SdkV3OperationError(
			"coordinator_owner_mismatch",
			"Session mutation coordinator ambient owner does not match supplied owner",
		);
	}
	if (active !== undefined && active.owner === owner && storedOwner === owner) {
		return effect();
	}
	let release!: () => void;
	const turn = new Promise<void>(resolve => {
		release = resolve;
	});
	const predecessor = active?.tail;
	const coordinator = active ?? createCoordinator(key, turn);
	const tail = predecessor === undefined ? turn : predecessor.then(() => turn);
	if (predecessor !== undefined) {
		coordinator.tail = tail;
	}
	await predecessor;
	coordinator.owner = owner;
	try {
		return await ambientOwner.run(owner, effect);
	} finally {
		releaseCoordinatorTurn(key, coordinator, tail, release);
	}
}
function createCoordinator(key: string, turn: Promise<void>): SessionMutationCoordinator {
	const coordinator: SessionMutationCoordinator = {
		owner: undefined,
		tail: turn,
	};
	coordinators.set(key, coordinator);
	return coordinator;
}
function releaseCoordinatorTurn(
	key: string,
	coordinator: SessionMutationCoordinator,
	tail: Promise<void>,
	release: () => void,
): void {
	coordinator.owner = undefined;
	release();
	if (coordinator.tail === tail) {
		coordinators.delete(key);
	}
}
