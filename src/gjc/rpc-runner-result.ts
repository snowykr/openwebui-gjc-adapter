import type { GjcRpcTransportState, GjcSessionState, GjcTurnEvent, GjcTurnResult } from "./rpc-runner";

export function mapSessionState(
	state: GjcRpcTransportState,
	rawFrameCursor: number,
	eventCursor: number,
): GjcSessionState {
	return {
		...(state.sessionFile === undefined ? {} : { sessionFile: state.sessionFile }),
		...(state.activeLeaf === undefined ? {} : { activeLeaf: state.activeLeaf }),
		rawFrameCursor: state.rawFrameCursor ?? rawFrameCursor,
		eventCursor: state.eventCursor ?? state.messageCount ?? eventCursor,
	};
}

export function lastEventText(events: readonly GjcTurnEvent[]): string | undefined {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const text = events[index]?.text;
		if (text !== undefined) return text;
	}
	return undefined;
}

export function stripSessionId(result: GjcTurnResult & { readonly sessionId: string }): GjcTurnResult {
	const { sessionId: _sessionId, ...turn } = result;
	return turn;
}
