import * as path from "node:path";
import { type GjcRuntimeSpawnInfo, resolveGjcRuntimeSpawnInfo } from "../../daemon/runtime";

export type SdkInternalAction = "broker-internal" | "session-host-internal";

/**
 * Resolve an SDK-internal CLI invocation for source and compiled runtimes.
 *
 * Source-mode SDK children must name the CLI entrypoint explicitly: `Bun.main`
 * may instead be a test/embedding entrypoint. Compiled binaries self-spawn
 * directly and must never reference workspace source paths.
 */
export function resolveSdkInternalSpawnCommand(
	action: SdkInternalAction,
	runtime: GjcRuntimeSpawnInfo = resolveGjcRuntimeSpawnInfo(),
): { file: string; args: string[] } {
	if (runtime.mode === "compiled") return { file: runtime.execPath, args: ["sdk", action] };
	const entrypoint = process.argv[1]?.endsWith("cli.ts")
		? process.argv[1]
		: path.resolve(import.meta.dir, "../../cli.ts");
	return { file: runtime.execPath, args: [entrypoint, "sdk", action] };
}
