import { stat } from "node:fs/promises";
import type { SdkClient } from "@gajae-code/coding-agent/sdk";
import {
	endpointFingerprint,
	endpointFor,
	lifecycleDeadlineMs,
	snapshotPublicEndpoints,
} from "./gjc-release-compat-sdk";

type Observe = (name: string, action: () => Promise<unknown>) => Promise<unknown>;

export async function closeWithPublicSdkProof(
	client: SdkClient,
	directory: string,
	targetSessionId: string,
	tmuxTarget: string,
	observe: Observe,
): Promise<Record<string, unknown>> {
	const deadline = Date.now() + lifecycleDeadlineMs;
	const remaining = () => {
		const timeoutMs = deadline - Date.now();
		if (timeoutMs <= 0) throw new Error("released public SDK session.close logical-close deadline exhausted");
		return timeoutMs;
	};
	const endpoint = await endpointFor(directory, targetSessionId);
	const fingerprint = endpointFingerprint(endpoint);
	const originalPanePid = await tmuxPanePid(tmuxTarget);
	if (!(await processLive(originalPanePid)))
		throw new Error(
			`released public SDK session.close target pane PID ${originalPanePid} was not live before acknowledgement`,
		);
	try {
		const acknowledgement = await observe("session.close", () =>
			awaitDeadline(client.control("session.close", {}, { timeoutMs: remaining() }), remaining),
		);
		if (
			!isRecord(acknowledgement) ||
			acknowledgement.ok !== true ||
			!isRecord(acknowledgement.result) ||
			acknowledgement.result.closed !== true
		)
			throw new Error(
				"released public SDK session.close returned an invalid {closed:true} acknowledgement envelope",
			);
		const postAcknowledgementEndpoint = (await snapshotPublicEndpoints(directory)).get(targetSessionId);
		const descriptorPresent = await descriptorExists(endpoint.descriptor);
		const live = await tmuxTargetLive(tmuxTarget);
		const postAcknowledgementPanePid = await tmuxPanePid(tmuxTarget);
		const originalPanePidLive = await processLive(originalPanePid);
		if (
			!descriptorPresent ||
			postAcknowledgementEndpoint === undefined ||
			endpointFingerprint(postAcknowledgementEndpoint) !== fingerprint ||
			!live ||
			postAcknowledgementPanePid !== originalPanePid ||
			!originalPanePidLive
		)
			throw new Error(
				"released public SDK session.close terminated or replaced the exact CLI/tmux endpoint generation",
			);
		return {
			phase: "sdkLogicalClose",
			targetSessionId,
			tmuxTarget,
			originalPanePid,
			endpoint: { descriptor: endpoint.descriptor, fingerprint, originalPanePid },
			acknowledgement,
			postAcknowledgement: {
				descriptorPresent,
				targetSessionIdPresent: true,
				fingerprint: endpointFingerprint(postAcknowledgementEndpoint),
				tmuxTargetLive: live,
				originalPanePid: postAcknowledgementPanePid,
				originalPanePidLive,
			},
		};
	} finally {
		await awaitDeadline(client.close(), remaining);
	}
}

export async function awaitLifecycleTermination(
	directory: string,
	endpoint: unknown,
	tmuxTarget: string,
): Promise<Record<string, unknown>> {
	if (
		!isRecord(endpoint) ||
		typeof endpoint.descriptor !== "string" ||
		typeof endpoint.fingerprint !== "string" ||
		typeof endpoint.originalPanePid !== "number"
	)
		throw new Error("SDK logical close proof did not retain an exact endpoint and original pane PID identity");
	const deadline = Date.now() + lifecycleDeadlineMs;
	const targetSessionId = endpoint.fingerprint.split("\u0000", 1)[0];
	for (;;) {
		const descriptorPresent = await descriptorExists(endpoint.descriptor);
		const currentEndpoint = (await snapshotPublicEndpoints(directory)).get(targetSessionId);
		const live = await tmuxTargetLive(tmuxTarget);
		const originalPanePidLive = await processLive(endpoint.originalPanePid);
		if (currentEndpoint !== undefined && endpointFingerprint(currentEndpoint) !== endpoint.fingerprint)
			throw new Error("CLI/tmux lifecycle termination replaced the exact endpoint generation");
		if (!descriptorPresent && currentEndpoint === undefined && !live && !originalPanePidLive)
			return {
				phase: "cliLifecycleTermination",
				owner: "cli/tmux",
				action: "/exit",
				tmuxTarget,
				originalPanePid: endpoint.originalPanePid,
				endpoint: { descriptor: endpoint.descriptor, fingerprint: endpoint.fingerprint },
				absence: {
					descriptorAbsent: true,
					targetSessionIdAbsent: true,
					tmuxTargetAbsent: true,
					originalPanePidAbsent: true,
				},
			};
		const remaining = deadline - Date.now();
		if (remaining <= 0)
			throw new Error(
				`CLI/tmux lifecycle termination did not remove exact endpoint ${endpoint.descriptor}, tmux target ${tmuxTarget}, and original pane PID ${endpoint.originalPanePid} before deadline`,
			);
		await Bun.sleep(Math.min(100, remaining));
	}
}

export async function awaitTmuxTermination(target: string, subject: string): Promise<Record<string, unknown>> {
	const deadline = Date.now() + lifecycleDeadlineMs;
	for (;;) {
		if (!(await tmuxTargetLive(target)))
			return { phase: "gracefulTmuxTermination", action: "/exit", tmuxTarget: target, tmuxTargetAbsent: true };
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error(`${subject} did not terminate after /exit before deadline`);
		await Bun.sleep(Math.min(100, remaining));
	}
}

export async function exitTmux(target: string, run: Run): Promise<void> {
	await run("tmux", ["send-keys", "-t", target, "/exit", "Enter"]);
}

export async function exitAndObservePostCloseFailure(
	directory: string,
	endpoint: unknown,
	tmuxTarget: string,
	run: Run,
): Promise<Record<string, unknown>> {
	const exitError = await exitTmux(tmuxTarget, run).then(
		() => undefined,
		error => (error instanceof Error ? error.message : String(error)),
	);
	if (
		!isRecord(endpoint) ||
		typeof endpoint.descriptor !== "string" ||
		typeof endpoint.fingerprint !== "string" ||
		typeof endpoint.originalPanePid !== "number"
	)
		return {
			phase: "postCloseFailureCleanup",
			action: "/exit",
			tmuxTarget,
			uncertainty: { reason: "exact endpoint identity unavailable", exitError },
		};
	const deadline = Date.now() + lifecycleDeadlineMs;
	const targetSessionId = endpoint.fingerprint.split("\u0000", 1)[0];
	let absence: Record<string, boolean> = {};
	try {
		while (Date.now() < deadline) {
			const currentEndpoint = (await snapshotPublicEndpoints(directory)).get(targetSessionId);
			absence = {
				descriptorAbsent: !(await descriptorExists(endpoint.descriptor)),
				targetSessionIdAbsent: currentEndpoint === undefined,
				tmuxTargetAbsent: !(await tmuxTargetLive(tmuxTarget)),
				originalPanePidAbsent: !(await processLive(endpoint.originalPanePid)),
			};
			if (Object.values(absence).every(Boolean))
				return {
					phase: "postCloseFailureCleanup",
					action: "/exit",
					tmuxTarget,
					originalPanePid: endpoint.originalPanePid,
					endpoint: { descriptor: endpoint.descriptor, fingerprint: endpoint.fingerprint },
					absence,
					uncertainty: { observed: false, exitError },
				};
			await Bun.sleep(Math.min(100, deadline - Date.now()));
		}
		return {
			phase: "postCloseFailureCleanup",
			action: "/exit",
			tmuxTarget,
			originalPanePid: endpoint.originalPanePid,
			endpoint: { descriptor: endpoint.descriptor, fingerprint: endpoint.fingerprint },
			absence,
			uncertainty: { observed: true, reason: "bounded exact endpoint absence observation expired", exitError },
		};
	} catch (error) {
		return {
			phase: "postCloseFailureCleanup",
			action: "/exit",
			tmuxTarget,
			originalPanePid: endpoint.originalPanePid,
			endpoint: { descriptor: endpoint.descriptor, fingerprint: endpoint.fingerprint },
			absence,
			uncertainty: { observed: true, reason: error instanceof Error ? error.message : String(error), exitError },
		};
	}
}

export type Run = (
	command: string,
	args: readonly string[],
	env?: Record<string, string | undefined>,
	allowFailure?: boolean,
) => Promise<string>;
export async function closeTmux(prefix: string, run: Run): Promise<readonly string[]> {
	const listed = (await run("tmux", ["list-sessions", "-F", "#{session_name}"], undefined, true))
		.split("\n")
		.filter(name => name.startsWith(prefix));
	for (const name of listed) await run("tmux", ["kill-session", "-t", name], undefined, true);
	return listed;
}

async function tmuxTargetLive(target: string): Promise<boolean> {
	const process = Bun.spawn(["tmux", "list-sessions", "-F", "#{session_name}"], { stdout: "pipe", stderr: "pipe" });
	const [code, output] = await Promise.all([process.exited, new Response(process.stdout).text()]);
	return code === 0 && output.split("\n").some(name => name === target);
}
async function tmuxPanePid(target: string): Promise<number> {
	const process = Bun.spawn(["tmux", "display-message", "-p", "-t", target, "#{pane_pid}"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, output] = await Promise.all([process.exited, new Response(process.stdout).text()]);
	const pid = Number.parseInt(output.trim(), 10);
	if (code !== 0 || !Number.isSafeInteger(pid) || pid <= 0)
		throw new Error(`tmux target ${target} did not expose a valid pane PID`);
	return pid;
}
async function processLive(pid: number): Promise<boolean> {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
		if (error instanceof Error && "code" in error && error.code === "EPERM") return true;
		throw error;
	}
}
async function descriptorExists(descriptor: string): Promise<boolean> {
	try {
		await stat(descriptor);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}
function awaitDeadline<T>(promise: Promise<T>, remaining: () => number): Promise<T> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error("released public SDK lifecycle deadline exhausted")),
			remaining(),
		);
		timeout.unref?.();
		void promise.then(
			value => {
				clearTimeout(timeout);
				resolve(value);
			},
			error => {
				clearTimeout(timeout);
				reject(error);
			},
		);
	});
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
