import { readSdkSessionEndpoint } from "@gajae-code/coding-agent/sdk";
import type { CliLifecycleResult } from "./cli-lifecycle-types";
import { type OwnedTmuxPane, proveTmuxPaneOwnership, type TmuxCommandRunner } from "./tmux-ownership";

export async function readCliSession(
	tmux: TmuxCommandRunner,
	cwd: string,
	captureLines: number,
	pane: OwnedTmuxPane,
	endpointPublicationTimeoutMs: number,
): Promise<CliLifecycleResult<string>> {
	const deadline = Date.now() + endpointPublicationTimeoutMs;
	const ready = await awaitPaneReadiness(tmux, captureLines, pane, deadline);
	if (ready.status !== "closed") return ready;
	const initialIds = parseSessionIds(ready.value.capture);
	if (initialIds.length > 1)
		return { status: "uncertain", message: "startup /session capture contains duplicate or ambiguous session ids" };
	let previous = ready.value;
	let sessionId = initialIds[0];
	for (;;) {
		const position = await panePosition(tmux, pane);
		if (position.status !== "closed") return position;
		if (position.value < previous.position)
			return { status: "uncertain", message: "tmux pane position rolled over while awaiting session endpoint" };
		const captured = await tmux.run(["capture-pane", "-p", "-t", pane.target, "-S", `-${captureLines}`]);
		if (captured.exitCode !== 0)
			return { status: "uncertain", message: captured.stderr.trim() || "tmux capture failed" };
		const fresh = newCaptureBytes(previous.capture, captured.stdout, position.value - previous.position);
		if (sessionId === undefined) {
			const ids =
				parseSessionIds(fresh).length === 0 && captured.stdout !== previous.capture
					? parseSessionIds(captured.stdout)
					: parseSessionIds(fresh);
			if (ids.length > 1)
				return {
					status: "uncertain",
					message: "startup /session capture contains duplicate or ambiguous session ids",
				};
			sessionId = ids[0];
		}
		if (sessionId !== undefined) {
			try {
				if ((await readSdkSessionEndpoint(cwd, sessionId)) !== null) return { status: "closed", value: sessionId };
			} catch (error) {
				return {
					status: "uncertain",
					message: error instanceof Error ? error.message : "cannot read startup CLI session endpoint",
				};
			}
		}
		if (Date.now() >= deadline)
			return { status: "uncertain", message: "startup /session capture did not publish a session endpoint" };
		previous = { position: position.value, capture: captured.stdout };
		await Bun.sleep(50);
	}
}

async function awaitPaneReadiness(
	tmux: TmuxCommandRunner,
	captureLines: number,
	pane: OwnedTmuxPane,
	deadline: number,
): Promise<CliLifecycleResult<{ readonly position: number; readonly capture: string }>> {
	for (;;) {
		const process = await paneProcessReady(tmux, pane);
		if (process.status !== "closed") return process;
		const position = await panePosition(tmux, pane);
		if (position.status !== "closed") return position;
		const captured = await tmux.run(["capture-pane", "-p", "-t", pane.target, "-S", `-${captureLines}`]);
		if (captured.exitCode !== 0)
			return { status: "uncertain", message: captured.stderr.trim() || "tmux capture failed" };
		if (process.value && captured.stdout.trim().length > 0)
			return { status: "closed", value: { position: position.value, capture: captured.stdout } };
		if (Date.now() >= deadline)
			return { status: "uncertain", message: "owned tmux pane did not produce readiness output before /session" };
		await Bun.sleep(50);
	}
}

async function paneProcessReady(tmux: TmuxCommandRunner, pane: OwnedTmuxPane): Promise<CliLifecycleResult<boolean>> {
	const ownership = await proveTmuxPaneOwnership(tmux, pane);
	if (ownership.status !== "owned")
		return {
			status: ownership.status === "unavailable" ? "unavailable" : "uncertain",
			message: ownership.status === "absent" ? "owned tmux pane disappeared before /session" : ownership.message,
		};
	const result = await tmux.run([
		"display-message",
		"-p",
		"-t",
		pane.target,
		"#{pane_dead}|#{pane_pid}|#{pane_current_command}",
	]);
	if (result.exitCode !== 0)
		return { status: "uncertain", message: result.stderr.trim() || "tmux pane process query failed" };
	const [dead, pidText, command, ...extra] = result.stdout.trim().split("|");
	if (
		extra.length !== 0 ||
		(dead !== "0" && dead !== "1") ||
		!/^\d+$/.test(pidText ?? "") ||
		Number(pidText) !== pane.panePid ||
		command === undefined
	)
		return { status: "uncertain", message: "tmux pane process query was malformed" };
	return { status: "closed", value: dead === "0" && !/^(?:ba|z|fi|da)?sh$/i.test(command) };
}

async function panePosition(tmux: TmuxCommandRunner, pane: OwnedTmuxPane): Promise<CliLifecycleResult<number>> {
	const ownership = await proveTmuxPaneOwnership(tmux, pane);
	if (ownership.status !== "owned")
		return {
			status: ownership.status === "unavailable" ? "unavailable" : "uncertain",
			message: ownership.status === "absent" ? "owned tmux pane disappeared during /session" : ownership.message,
		};
	const result = await tmux.run(["display-message", "-p", "-t", pane.target, "#{history_size}|#{cursor_y}"]);
	if (result.exitCode !== 0)
		return { status: "uncertain", message: result.stderr.trim() || "tmux pane position query failed" };
	const [historyText, cursorText, ...extra] = result.stdout.trim().split("|");
	if (extra.length !== 0 || !/^\d+$/.test(historyText ?? "") || !/^\d+$/.test(cursorText ?? ""))
		return { status: "uncertain", message: "tmux pane position query was malformed" };
	return { status: "closed", value: Number(historyText) + Number(cursorText) };
}

function parseSessionIds(capture: string): string[] {
	const unwrapped = capture.replace(
		/((?:^|\n)\s*(?:ID|Session ID)\s*:\s*[^\s]+)\n(\s*-[^\s]+)(?=\s*(?:\n|$))/gim,
		"$1$2",
	);
	return [...unwrapped.matchAll(/(?:^|\n)\s*(?:ID|Session ID)\s*:\s*([^\s]+)\s*$/gim)].map(match => match[1]!);
}
function newCaptureBytes(previous: string, current: string, advancedLines: number): string {
	if (current.startsWith(previous)) return current.slice(previous.length);
	if (advancedLines < 1) return "";
	const lines = current.split("\n");
	return lines.slice(Math.max(0, lines.length - advancedLines - 1)).join("\n");
}
