export function spawnCli(args: readonly string[], cwd: string, env: Record<string, string | undefined>) {
	return Bun.spawn([...args], { cwd, env, stdout: "ignore", stderr: "pipe" });
}

type CliProcess = ReturnType<typeof spawnCli>;

export async function observeStartup(process: CliProcess, port: number): Promise<"exited" | "listening" | "deadline"> {
	const deadline = Date.now() + 4_000;
	while (Date.now() < deadline) {
		if (process.exitCode !== null) return "exited";
		const listening = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(100) }).then(
			async response => {
				await response.body?.cancel();
				return true;
			},
			() => false,
		);
		if (listening) return "listening";
		await Bun.sleep(25);
	}
	return process.exitCode === null ? "deadline" : "exited";
}

export async function terminateAndReap(process: CliProcess): Promise<void> {
	if (process.exitCode === null) {
		process.kill("SIGTERM");
		const terminated = await Promise.race([process.exited.then(() => true), Bun.sleep(500).then(() => false)]);
		if (!terminated) process.kill("SIGKILL");
	}
	await process.exited;
}
