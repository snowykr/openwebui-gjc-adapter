import { readSdkSessionEndpoint } from "@gajae-code/coding-agent/sdk";
import { proveTmuxPaneOwnership, type OwnedTmuxPane, type TmuxCommandRunner } from "./tmux-ownership";
import { MAX_LIFECYCLE_CLOSE_PROOF_WINDOW_MS, type CliLifecycleAttachment, type CliLifecycleResult, unavailable } from "./cli-lifecycle-types";

export async function requestExit(tmux: TmuxCommandRunner, attachment: CliLifecycleAttachment): Promise<CliLifecycleResult<undefined>> {
	const ownership = await proveTmuxPaneOwnership(tmux, attachment.pane);
	if (ownership.status === "absent") return { status: "closed", value: undefined };
	if (ownership.status !== "owned") return { status: ownership.status === "unavailable" ? "unavailable" : "uncertain", message: ownership.message };
	const sent = await tmux.run(["send-keys", "-t", attachment.pane.target, "/exit", "Enter"]);
	return sent.exitCode === 0 ? { status: "closed", value: undefined } : { status: "unavailable", message: sent.stderr.trim() || "tmux could not send /exit" };
}

export async function requestExitAndProveClosedAfterAcknowledgement(
	tmux: TmuxCommandRunner, cwd: string, isProcessAlive: ((pid: number) => boolean | Promise<boolean>) | undefined,
	attachment: CliLifecycleAttachment, timeoutMs = 1_000,
): Promise<CliLifecycleResult<undefined>> {
	const requested = await requestExit(tmux, attachment);
	const proved = await proveClosedAfterAcknowledgement(tmux, cwd, isProcessAlive, attachment, timeoutMs);
	if (proved.status === "closed" || requested.status === "closed") return proved;
	return {
		status: proved.status === "unavailable" ? "unavailable" : "uncertain",
		message: `public SDK close was acknowledged, but exact owned-pane /exit was not accepted: ${requested.message}; closure proof is ${proved.status}: ${proved.message}`,
	};
}

export async function proveClosedAfterAcknowledgement(
	tmux: TmuxCommandRunner, cwd: string, isProcessAlive: ((pid: number) => boolean | Promise<boolean>) | undefined,
	attachment: CliLifecycleAttachment, timeoutMs = 1_000,
): Promise<CliLifecycleResult<undefined>> {
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_LIFECYCLE_CLOSE_PROOF_WINDOW_MS) throw new TypeError(`timeoutMs must be an integer between 1 and ${MAX_LIFECYCLE_CLOSE_PROOF_WINDOW_MS}`);
	const deadline = Date.now() + timeoutMs;
	let endpointMessage = "session endpoint is still available";
	let paneMessage = "owned tmux pane is still running";
	for (;;) {
		try {
			endpointMessage = await readSdkSessionEndpoint(cwd, attachment.sessionId) === null ? "" : "session endpoint is still available";
		} catch (error) {
			return { status: "uncertain", message: error instanceof Error ? error.message : "cannot verify session endpoint disappearance" };
		}
		const ownership = await proveTmuxPaneOwnership(tmux, attachment.pane);
		if (ownership.status === "owned") paneMessage = "owned tmux pane is still running";
		else {
			const originalProcess = await proveOriginalPaneProcessAbsent(isProcessAlive, attachment.pane);
			if (originalProcess.status === "unavailable") return originalProcess;
			paneMessage = originalProcess.status === "closed" ? "" : originalProcess.message;
		}
		if (endpointMessage === "" && paneMessage === "") return { status: "closed", value: undefined };
		if (Date.now() >= deadline) return { status: "uncertain", message: [endpointMessage, paneMessage].filter(Boolean).join("; ") };
		await Bun.sleep(Math.min(50, deadline - Date.now()));
	}
}

async function proveOriginalPaneProcessAbsent(isProcessAlive: ((pid: number) => boolean | Promise<boolean>) | undefined, pane: OwnedTmuxPane): Promise<CliLifecycleResult<undefined>> {
	try {
		const alive = await (isProcessAlive?.(pane.panePid) ?? processIsAlive(pane.panePid));
		return alive ? { status: "uncertain", message: "original tmux pane process is still running" } : { status: "closed", value: undefined };
	} catch (error) {
		return unavailable(error, "cannot verify original tmux pane process absence");
	}
}

function processIsAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) {
		if (isErrno(error, "ESRCH")) return false;
		if (isErrno(error, "EPERM")) return true;
		throw error;
	}
}
function isErrno(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }
