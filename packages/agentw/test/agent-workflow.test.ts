import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { type AgentWBridge, createAgentWTools } from "../src/pi-extension/index.ts";
import type { ProductRecord } from "../src/shared/product.ts";

const pageOne: ProductRecord[] = [
	{
		name: "Tea",
		price: "$1",
		productionDate: "Not provided",
		url: "https://shop.test/tea",
		sourcePage: 1,
		capturedAt: "2026-07-23T10:00:00.000Z",
	},
];
const pageTwo: ProductRecord[] = [
	{ ...pageOne[0], sourcePage: 2, capturedAt: "2026-07-23T10:00:10.000Z" },
	{
		name: "Coffee",
		price: "$2",
		productionDate: "2026-07-01",
		url: "https://shop.test/coffee",
		sourcePage: 2,
		capturedAt: "2026-07-23T10:00:10.000Z",
	},
];
const twoPageRecords = [pageOne[0], pageTwo[1]].filter((record): record is ProductRecord => record !== undefined);

function createScriptedBridge(calls: string[]): AgentWBridge {
	return {
		async requestBrowser(_taskId, command) {
			switch (command.type) {
				case "browser.extract_products":
					calls.push(`extract:${command.pageNumber}`);
					return {
						type: "browser.products",
						records: command.pageNumber === 1 ? pageOne : pageTwo,
						fingerprint: `page-${command.pageNumber}`,
					};
				case "browser.next_page":
					calls.push("next");
					return { type: "browser.action", changed: true, fingerprint: "page-2" };
				case "browser.wait_for_change":
					calls.push(`wait:${command.previousFingerprint}`);
					return { type: "browser.action", changed: true, fingerprint: "page-2" };
				case "browser.inspect":
					return {
						type: "browser.snapshot",
						title: "Shop",
						url: "https://shop.test",
						fingerprint: "page-1",
						text: "",
						links: [],
						fields: [],
					};
				case "browser.google_sheets.write_products":
					calls.push("google-sheets");
					return {
						type: "browser.google_sheets",
						url: "https://docs.google.com/spreadsheets/d/sheet-id/edit",
						rowsWritten: command.records.length,
					};
			}
		},
		async exportExcel(_taskId, records) {
			calls.push("export");
			const urls = records.map((record) => record.url);
			expect(new Set(urls).size).toBe(urls.length);
			return { id: "artifact-1", name: "products.xlsx", size: 120, sha256: "a".repeat(64) };
		},
	};
}

describe("AgentW product workflow", () => {
	let harness: Harness | undefined;

	afterEach(() => harness?.cleanup());

	it("reads two pages and exports one deduplicated workbook request", async () => {
		const calls: string[] = [];
		harness = await createHarness({ tools: createAgentWTools(createScriptedBridge(calls)) });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("browser_extract_products", { pageNumber: 1 }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("browser_next_page", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("browser_wait_for_page_change", { previousFingerprint: "page-1" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("browser_extract_products", { pageNumber: 2 }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("artifact_export_excel", { records: twoPageRecords }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Two pages extracted and exported."),
		]);

		await harness.session.prompt("Extract two pages of products and generate Excel.");

		expect(calls).toEqual(["extract:1", "next", "wait:page-1", "extract:2", "export"]);
	});

	it("extracts products and writes them to Google Sheets", async () => {
		const calls: string[] = [];
		harness = await createHarness({ tools: createAgentWTools(createScriptedBridge(calls)) });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("browser_extract_products", { pageNumber: 1 }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("browser_write_products_to_google_sheets", { records: pageOne }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("The product rows were written to Google Sheets."),
		]);

		await harness.session.prompt("Extract these products and write them to Google Sheets.");

		expect(calls).toEqual(["extract:1", "google-sheets"]);
	});
});
