import { describe, expect, it } from "vitest";
import { redactDiagnostic } from "../src/host/redact.ts";

describe("redactDiagnostic", () => {
	it("redacts nested secret values without mutating the input", () => {
		const input = {
			url: "https://shop.test",
			headers: { Authorization: "Bearer secret", Cookie: "sid=secret" },
			form: { password: "secret", query: "tea" },
			items: [{ apiKey: "key", publicValue: "ok" }],
		};

		expect(redactDiagnostic(input)).toEqual({
			url: "https://shop.test",
			headers: { Authorization: "[REDACTED]", Cookie: "[REDACTED]" },
			form: { password: "[REDACTED]", query: "tea" },
			items: [{ apiKey: "[REDACTED]", publicValue: "ok" }],
		});
		expect(input.headers.Authorization).toBe("Bearer secret");
		expect(input.items[0]?.apiKey).toBe("key");
	});
});
