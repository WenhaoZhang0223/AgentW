import { describe, expect, it } from "vitest";
import { classifyGoogleSheetsPage, productsToTsv } from "../src/edge/google-sheets.ts";

describe("Google Sheets workflow", () => {
	it("classifies login, home, and editable spreadsheet URLs", () => {
		expect(classifyGoogleSheetsPage("https://accounts.google.com/v3/signin/identifier")).toBe("login");
		expect(classifyGoogleSheetsPage("https://docs.google.com/spreadsheets/u/0/")).toBe("sheets-home");
		expect(classifyGoogleSheetsPage("https://docs.google.com/spreadsheets/d/sheet-id/edit#gid=0")).toBe("sheet");
		expect(classifyGoogleSheetsPage("https://example.com/")).toBe("other");
	});

	it("creates a seven-column TSV and removes embedded row separators", () => {
		const tsv = productsToTsv([
			{
				name: "Tea\nSet",
				packaging: "20 bags",
				price: "¥20",
				productionDate: "2026-07-01",
				url: "https://shop.example/tea",
				sourcePage: 1,
				capturedAt: "2026-07-24T12:00:00.000Z",
			},
		]);

		expect(tsv.split("\n")).toHaveLength(2);
		expect(tsv.split("\n")[0]?.split("\t")).toHaveLength(7);
		expect(tsv).toContain("Tea Set\t20 bags\t¥20");
	});
});
