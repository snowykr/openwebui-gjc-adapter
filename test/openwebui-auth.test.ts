import { describe, expect, test } from "bun:test";
import {
	detectOpenWebUICredentialType,
	isOpenWebUIAdmin,
	resolveForwardedPrincipal,
	validateForwardedOwnerUserId,
} from "../src/openwebui/auth";

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
	test("resolves a required forwarded principal and its configured admin role", () => {
		const owner = { ownerUserId: "admin-1", singleOwnerLocalMode: false };

		expect(resolveForwardedPrincipal(owner, undefined)).toEqual({
			ok: false,
			reason: "missing-forwarded-user",
		});
		expect(resolveForwardedPrincipal(owner, " normal-1 ")).toEqual({
			ok: true,
			principal: { userId: "normal-1", role: "user" },
		});

		const resolved = resolveForwardedPrincipal(owner, "admin-1");
		expect(resolved).toEqual({
			ok: true,
			principal: { userId: "admin-1", role: "admin" },
		});
		if (resolved.ok) expect(isOpenWebUIAdmin(resolved.principal)).toBe(true);
	});
	test("normalizes configured owner identity before role assignment and owner validation", () => {
		const owner = { ownerUserId: " admin-1 ", singleOwnerLocalMode: true };

		expect(resolveForwardedPrincipal(owner, "admin-1")).toEqual({
			ok: true,
			principal: { userId: "admin-1", role: "admin" },
		});
		expect(validateForwardedOwnerUserId(owner, undefined)).toEqual({
			ok: true,
			ownerUserId: "admin-1",
			forwardedUserId: null,
		});
	});
	test("rejects unresolved or control-character forwarded principal values", () => {
		const owner = { ownerUserId: "admin-1", singleOwnerLocalMode: false };

		for (const value of ["{{USER_ID}}", "{{}}", "prefix{{USER_ID}}suffix", "user\u0000id", "user\u0085id", "\n\t"]) {
			expect(resolveForwardedPrincipal(owner, value)).toEqual({
				ok: false,
				reason: "missing-forwarded-user",
			});
		}
	});
});
