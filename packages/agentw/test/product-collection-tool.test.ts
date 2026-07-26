import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createProductCollectionTool } from "../src/pi-extension/product-collection-tool.ts";
import { AgentWError } from "../src/shared/errors.ts";
import type { ProductRecord } from "../src/shared/product.ts";

describe("product collection tool", () => {
	it("streams pages to an internal dataset and returns only a compact summary", async () => {
		const tea: ProductRecord = {
			name: "Tea",
			packaging: "20 bags",
			price: "€0,89",
			productionDate: "网页未提供",
			url: "https://shop.test/tea",
			sourcePage: 1,
			capturedAt: "now",
		};
		const coffee: ProductRecord = {
			name: "Coffee",
			packaging: "500 g",
			price: "€4,50",
			productionDate: "网页未提供",
			url: "https://shop.test/coffee",
			sourcePage: 2,
			capturedAt: "now",
		};
		const appended: ProductRecord[] = [];
		const exported: ProductRecord[] = [];
		const commands: string[] = [];
		const bridge = {
			appendProductDataset: async (_taskId: string, records: ProductRecord[]) => {
				appended.push(...records.filter((record) => !appended.some((item) => item.url === record.url)));
				return { appended: records.length, total: appended.length };
			},
			exportExcel: async (_taskId: string, records: ProductRecord[]) => {
				exported.push(...records);
				return {
					id: "excel-1",
					name: "products.xlsx",
					size: 456,
					sha256: "def",
				};
			},
			finalizeProductDataset: async () => ({
				id: "artifact-1",
				name: "data.json",
				size: 123,
				sha256: "abc",
			}),
			requestBrowser: async (
				_taskId: string,
				command: { type: string; pageNumber?: number; timeoutMs?: number },
			) => {
				commands.push(command.type);
				if (command.type === "browser.extract_products") {
					if (command.pageNumber === 1) {
						return { type: "browser.products" as const, records: [tea], fingerprint: "page-1" };
					}
					return { type: "browser.products" as const, records: [tea, coffee], fingerprint: "page-2" };
				}
				if (command.type === "browser.next_page" && commands.filter((type) => type === command.type).length > 1) {
					throw new AgentWError("NEXT_PAGE_NOT_FOUND");
				}
				if (command.type === "browser.google_sheets.write_products") {
					return {
						type: "browser.google_sheets" as const,
						url: "https://docs.google.com/spreadsheets/d/new/edit",
						rowsWritten: 2,
					};
				}
				return {
					type: "browser.action" as const,
					changed: command.timeoutMs === 30_000,
					fingerprint: "page-2",
				};
			},
		};
		const tool = createProductCollectionTool(bridge);

		const result = await tool.execute("call-1", {}, new AbortController().signal, undefined, {} as ExtensionContext);

		expect(appended).toEqual([tea, coffee]);
		expect(exported).toEqual([tea, coffee]);
		expect(commands).toEqual([
			"browser.extract_products",
			"browser.next_page",
			"browser.wait_for_change",
			"browser.extract_products",
			"browser.wait_for_change",
			"browser.next_page",
			"browser.google_sheets.write_products",
		]);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("2 unique products across 2 pages"),
		});
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("Excel file ready: products.xlsx"),
		});
		expect(result.content[0]).not.toMatchObject({ text: expect.stringContaining("Coffee") });
		expect(result.content[0]).not.toMatchObject({ text: expect.stringContaining("data.json") });
		expect(result.details).not.toHaveProperty("artifact");
	});

	it("retries pagination without asking the user when the first click does not change the page", async () => {
		const product: ProductRecord = {
			name: "Chocolate",
			packaging: "100 g",
			price: "€1.00",
			productionDate: "网页未提供",
			url: "https://shop.test/chocolate",
			sourcePage: 1,
			capturedAt: "now",
		};
		let nextPageCalls = 0;
		let navigationWaitCalls = 0;
		const bridge = {
			appendProductDataset: async () => ({ appended: 1, total: 1 }),
			exportExcel: async () => ({
				id: "excel-1",
				name: "products.xlsx",
				size: 100,
				sha256: "def",
			}),
			finalizeProductDataset: async () => ({
				id: "artifact-1",
				name: "data.json",
				size: 100,
				sha256: "abc",
			}),
			requestBrowser: async (
				_taskId: string,
				command: { type: string; pageNumber?: number; timeoutMs?: number },
			) => {
				if (command.type === "browser.extract_products") {
					if (command.pageNumber === 1) {
						return { type: "browser.products" as const, records: [product], fingerprint: "page-1" };
					}
					return { type: "browser.products" as const, records: [], fingerprint: "page-2" };
				}
				if (command.type === "browser.next_page") {
					nextPageCalls++;
					return { type: "browser.action" as const, changed: false, fingerprint: "page-1" };
				}
				if (command.timeoutMs !== 30_000) {
					return { type: "browser.action" as const, changed: false, fingerprint: "page-2" };
				}
				navigationWaitCalls++;
				return {
					type: "browser.action" as const,
					changed: navigationWaitCalls > 1,
					fingerprint: navigationWaitCalls > 1 ? "page-2" : "page-1",
				};
			},
		};
		const tool = createProductCollectionTool(bridge);

		const result = await tool.execute(
			"call-retry",
			{ writeGoogleSheet: false },
			new AbortController().signal,
			undefined,
			{} as ExtensionContext,
		);

		expect(nextPageCalls).toBe(2);
		expect(navigationWaitCalls).toBe(2);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("Stop reason: empty_page"),
		});
	});

	it("waits for products to render after the page URL changes", async () => {
		const first: ProductRecord = {
			name: "Chocolate one",
			packaging: "100 g",
			price: "€1.00",
			productionDate: "网页未提供",
			url: "https://shop.test/chocolate-one",
			sourcePage: 1,
			capturedAt: "now",
		};
		const second: ProductRecord = {
			...first,
			name: "Chocolate two",
			url: "https://shop.test/chocolate-two",
			sourcePage: 2,
		};
		const appended: ProductRecord[] = [];
		let secondPageExtractions = 0;
		let readinessWaits = 0;
		let nextPageCalls = 0;
		const bridge = {
			appendProductDataset: async (_taskId: string, records: ProductRecord[]) => {
				appended.push(...records);
				return { appended: records.length, total: appended.length };
			},
			exportExcel: async () => ({
				id: "excel-1",
				name: "products.xlsx",
				size: 100,
				sha256: "def",
			}),
			finalizeProductDataset: async () => ({
				id: "artifact-1",
				name: "data.json",
				size: 100,
				sha256: "abc",
			}),
			requestBrowser: async (
				_taskId: string,
				command: { type: string; pageNumber?: number; timeoutMs?: number },
			) => {
				if (command.type === "browser.extract_products") {
					if (command.pageNumber === 1) {
						return { type: "browser.products" as const, records: [first], fingerprint: "page-1" };
					}
					secondPageExtractions++;
					return secondPageExtractions === 1
						? { type: "browser.products" as const, records: [], fingerprint: "page-2-loading" }
						: { type: "browser.products" as const, records: [second], fingerprint: "page-2-ready" };
				}
				if (command.type === "browser.next_page") {
					if (++nextPageCalls > 1) throw new AgentWError("NEXT_PAGE_NOT_FOUND");
					return { type: "browser.action" as const, changed: false, fingerprint: "page-1" };
				}
				if (command.timeoutMs === 30_000) {
					return { type: "browser.action" as const, changed: true, fingerprint: "page-2-loading" };
				}
				readinessWaits++;
				return {
					type: "browser.action" as const,
					changed: readinessWaits === 1,
					fingerprint: "page-2-ready",
				};
			},
		};
		const tool = createProductCollectionTool(bridge);

		const result = await tool.execute(
			"call-ready",
			{ writeGoogleSheet: false },
			new AbortController().signal,
			undefined,
			{} as ExtensionContext,
		);

		expect(secondPageExtractions).toBe(2);
		expect(appended).toEqual([first, second]);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("2 unique products across 2 pages"),
		});
	});

	it("reloads a transient empty result page and continues collection", async () => {
		const first: ProductRecord = {
			name: "Loose shirt one",
			packaging: "XL",
			price: "100",
			productionDate: "not provided",
			url: "https://shop.test/one",
			sourcePage: 1,
			capturedAt: "now",
		};
		const second: ProductRecord = {
			...first,
			name: "Loose shirt two",
			url: "https://shop.test/two",
			sourcePage: 2,
		};
		const appended: ProductRecord[] = [];
		const exported: ProductRecord[] = [];
		let reloaded = false;
		const commands: string[] = [];
		const bridge = {
			appendProductDataset: async (_taskId: string, records: ProductRecord[]) => {
				appended.push(...records);
				return { appended: records.length, total: appended.length };
			},
			exportExcel: async (_taskId: string, records: ProductRecord[]) => {
				exported.push(...records);
				return {
					id: "excel-1",
					name: "products.xlsx",
					size: 100,
					sha256: "def",
				};
			},
			finalizeProductDataset: async () => ({
				id: "artifact-1",
				name: "data.json",
				size: 100,
				sha256: "abc",
			}),
			requestBrowser: async (
				_taskId: string,
				command: { type: string; pageNumber?: number; timeoutMs?: number },
			) => {
				commands.push(command.type);
				if (command.type === "browser.extract_products") {
					return {
						type: "browser.products" as const,
						records: command.pageNumber === 1 ? [first] : reloaded ? [second] : [],
						fingerprint: command.pageNumber === 1 ? "page-1" : reloaded ? "page-2-ready" : "page-2-error",
					};
				}
				if (command.type === "browser.inspect") {
					return {
						type: "browser.snapshot" as const,
						title: "Search",
						url: "https://shop.test/search?page=2",
						fingerprint: "page-2-error",
						text: "Network error. Try again.",
						links: [],
						fields: [],
					};
				}
				if (command.type === "browser.reload") {
					reloaded = true;
					return { type: "browser.action" as const, changed: true, fingerprint: "page-2-ready" };
				}
				return {
					type: "browser.action" as const,
					changed: command.timeoutMs === 30_000,
					fingerprint: command.timeoutMs === 30_000 ? "page-2-error" : "unchanged",
				};
			},
		};
		const tool = createProductCollectionTool(bridge);

		const result = await tool.execute(
			"call-recover",
			{ maxPages: 2, writeGoogleSheet: false },
			new AbortController().signal,
			undefined,
			{} as ExtensionContext,
		);

		expect(commands).toContain("browser.reload");
		expect(appended).toEqual([first, second]);
		expect(exported).toEqual([first, second]);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("2 unique products across 2 pages"),
		});
	});
});
