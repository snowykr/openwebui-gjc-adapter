export type UntrustedPolicyResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly diagnostic: "UNTRUSTED_DEPENDENCIES" | "UNTRUSTED_OUTPUT_INVALID" };

const cleanOutput = "No untrusted dependencies found";

export function evaluateBunUntrustedPolicy(exitCode: number, output: string): UntrustedPolicyResult {
	if (exitCode !== 0) {
		return { ok: false, diagnostic: "UNTRUSTED_OUTPUT_INVALID" };
	}

	const normalized = output.replaceAll("\r\n", "\n").replace(/\n$/, "");
	if (normalized === cleanOutput) {
		return { ok: true };
	}
	if (normalized.endsWith("These dependencies had their lifecycle scripts blocked during install.")) {
		return { ok: false, diagnostic: "UNTRUSTED_DEPENDENCIES" };
	}
	return { ok: false, diagnostic: "UNTRUSTED_OUTPUT_INVALID" };
}

if (import.meta.main) {
	const [exitCodeText, outputPath] = Bun.argv.slice(2);
	const exitCode = Number(exitCodeText);
	if (!Number.isInteger(exitCode) || outputPath === undefined) {
		console.error("UNTRUSTED_OUTPUT_INVALID");
		process.exit(2);
	}
	const result = evaluateBunUntrustedPolicy(exitCode, await Bun.file(outputPath).text());
	if (!result.ok) {
		console.error(result.diagnostic);
		process.exit(1);
	}
}
