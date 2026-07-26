import { describe, expect, it } from "vitest";
import { isAuthorizedActiveTab } from "../src/edge/tab-authorization.ts";

describe("tab authorization", () => {
	it("accepts only the currently visible authorized tab", () => {
		const authorization = { tabId: 12, origin: "https://example.com" };

		expect(isAuthorizedActiveTab(authorization, 12, "https://example.com")).toBe(true);
		expect(isAuthorizedActiveTab(authorization, 13, "https://example.com")).toBe(false);
		expect(isAuthorizedActiveTab(authorization, 12, "https://other.example")).toBe(false);
		expect(isAuthorizedActiveTab(authorization, undefined, undefined)).toBe(false);
	});

	it("rejects every tab when no page is authorized", () => {
		expect(isAuthorizedActiveTab(undefined, 12, "https://example.com")).toBe(false);
	});
});
