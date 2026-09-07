import { closePublicSession, lifecycleDeadlineMs, type PublicSdkSession } from "./gjc-release-compat-sdk";

type Observe = (name: string, action: () => Promise<unknown>) => Promise<unknown>;

export async function closeWithPublicSdkProof(
	client: PublicSdkSession,
	directory: string,
	targetSessionId: string,
	observe: Observe,
): Promise<Record<string, unknown>> {
	if (client.sessionId !== targetSessionId)
		throw new Error("public lifecycle close target does not match the attached public SDK session");
	const acknowledgement = await observe("session.close", () =>
		closePublicSession(directory, targetSessionId, client.generation),
	);
	if (
		!isRecord(acknowledgement) ||
		acknowledgement.ok !== true ||
		!isRecord(acknowledgement.result) ||
		acknowledgement.result.sessionId !== targetSessionId
	)
		throw new Error("public lifecycle session.close returned an invalid acknowledgement");
	const retirement = await awaitRetirement(client);
	return {
		phase: "sdkLogicalClose",
		targetSessionId,
		generation: client.generation,
		acknowledgement,
		retirement,
	};
}

async function awaitRetirement(client: PublicSdkSession): Promise<Record<string, unknown>> {
	const deadline = Date.now() + lifecycleDeadlineMs;
	for (;;) {
		const status = await client.generationStatus();
		if (status.status === "retired")
			return {
				status: status.status,
				evidence: status.evidence,
			};
		if (status.status === "replaced")
			throw new Error("public lifecycle close observed replacement instead of exact-generation retirement");
		if (status.status === "unknown")
			throw new Error(`public lifecycle close retirement evidence is unknown: ${status.reason}`);
		const remaining = deadline - Date.now();
		if (remaining <= 0)
			throw new Error("public lifecycle close did not produce exact-generation retirement evidence");
		await Bun.sleep(Math.min(100, remaining));
	}
}

export async function awaitLifecycleTermination(client: PublicSdkSession): Promise<Record<string, unknown>> {
	return await awaitRetirement(client);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
