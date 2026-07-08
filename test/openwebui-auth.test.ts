import { describe, expect, test } from "bun:test";
import { detectOpenWebUICredentialType, validateForwardedOwnerUserId } from "../src/openwebui/auth";

describe("OpenWebUI owner/auth primitives", () => {
	test("detects configured credential type", () => {
		expect(detectOpenWebUICredentialType({ openWebUIApiToken: "token" })).toBe("api-token");
		expect(
			detectOpenWebUICredentialType({
				openWebUIAdminEmail: "admin@example.com",
				openWebUIAdminPassword: "password",
			}),
		).toBe("admin-credentials");
		expect(detectOpenWebUICredentialType({})).toBe("missing");
	});

	test("rejects forwarded owner mismatch", () => {
		const result = validateForwardedOwnerUserId({ ownerUserId: "owner-1", singleOwnerLocalMode: true }, "owner-2");

		expect(result).toEqual({
			ok: false,
			ownerUserId: "owner-1",
			forwardedUserId: "owner-2",
			reason: "owner-mismatch",
		});
	});

	test("allows absent forwarded owner in single-owner local mode", () => {
		const result = validateForwardedOwnerUserId({ ownerUserId: "owner-1", singleOwnerLocalMode: true }, undefined);

		expect(result).toEqual({ ok: true, ownerUserId: "owner-1", forwardedUserId: null });
	});
});
