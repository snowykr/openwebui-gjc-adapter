export type UntrustedPolicyResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly diagnostic: "UNTRUSTED_DEPENDENCIES" | "UNTRUSTED_OUTPUT_INVALID" };

const cleanOutput =
	'bun pm untrusted v1.3.14 (0d9b296a)\n\nFound 0 untrusted dependencies with scripts.\n\nThis means all packages with scripts are in "trustedDependencies" or none of your dependencies have scripts.\n\nFor more information, visit https://bun.com/docs/install/lifecycle#trusteddependencies';

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
