import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createBrowserTools } from "../src/pi-extension/browser-tools.ts";
import { AgentWError } from "../src/shared/errors.ts";

describe("browser tools", () => {
	it("clicks a fresh page element reference", async () => {
		let receivedCommand: { type: string; reference?: string } | undefined;
		const bridge = {
			requestBrowser: async (_taskId: string, command: { type: string; reference?: string }) => {
				receivedCommand = command;
				return { type: "browser.action" as const, changed: false, fingerprint: "page-1" };
			},
		};
		const tool = createBrowserTools(bridge).find((candidate) => candidate.name === "browser_click_element");
		if (!tool) throw new Error("browser_click_element tool is missing");

		await tool.execute(
			"call-click",
			{ reference: "link-1" },
			new AbortController().signal,
			undefined,
			{} as ExtensionContext,
		);

		expect(receivedCommand).toEqual({ type: "browser.click", reference: "link-1", text: undefined });
	});

	it("types text into a fresh field reference", async () => {
		let receivedCommand: { type: string; reference?: string; text?: string; submit?: boolean } | undefined;
		const bridge = {
			requestBrowser: async (
				_taskId: string,
				command: { type: string; reference?: string; text?: string; submit?: boolean },
			) => {
				receivedCommand = command;
				return { type: "browser.action" as const, changed: false, fingerprint: "page-1" };
			},
		};
		const tool = createBrowserTools(bridge).find((candidate) => candidate.name === "browser_type_text");
		if (!tool) throw new Error("browser_type_text tool is missing");

		await tool.execute(
			"call-type",
			{ reference: "element-2", text: "宽松衣服", submit: true },
			new AbortController().signal,
			undefined,
			{} as ExtensionContext,
		);

		expect(receivedCommand).toEqual({
			type: "browser.type_text",
			reference: "element-2",
			text: "宽松衣服",
			submit: true,
		});
	});

	it("searches the current website and waits for results without asking the user to type", async () => {
		const commands: Array<Record<string, unknown>> = [];
		const bridge = {
			requestBrowser: async (_taskId: string, command: Record<string, unknown>) => {
				commands.push(command);
				if (command.type === "browser.search") {
					return { type: "browser.action" as const, changed: false, fingerprint: "home-page" };
				}
				return { type: "browser.action" as const, changed: true, fingerprint: "results-page" };
			},
		};
		const tool = createBrowserTools(bridge).find((candidate) => candidate.name === "browser_search_current_site");
		if (!tool) throw new Error("browser_search_current_site tool is missing");

		const result = await tool.execute(
			"call-search",
			{ query: "宽松衣服" },
			new AbortController().signal,
			undefined,
			{} as ExtensionContext,
		);

		expect(commands).toEqual([
			{ type: "browser.search", query: "宽松衣服" },
			{ type: "browser.wait_for_change", previousFingerprint: "home-page", timeoutMs: 20_000 },
		]);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("BROWSER_RUNTIME_STATUS: OK"),
		});
		expect(tool.promptGuidelines?.join(" ")).toContain("Never ask the user to type");
	});

	it("re-reads once after a stale next-page reference", async () => {
		const calls: string[] = [];
		const bridge = {
			requestBrowser: async (_taskId: string, command: { type: string }) => {
				calls.push(command.type);
				if (calls.length === 1) {
					throw new AgentWError("STALE_ELEMENT_REFERENCE");
				}
				if (command.type === "browser.inspect") {
					return {
						type: "browser.snapshot" as const,
						title: "Shop",
						url: "https://shop.test",
						fingerprint: "page-2",
						text: "",
						links: [],
						fields: [],
					};
				}
				return { type: "browser.action" as const, changed: true, fingerprint: "page-2" };
			},
		};
		const tool = createBrowserTools(bridge).find((candidate) => candidate.name === "browser_next_page");
		if (!tool) {
			throw new Error("browser_next_page tool is missing");
		}

		const result = await tool.execute("call-1", {}, new AbortController().signal, undefined, {} as ExtensionContext);

		expect(calls).toEqual(["browser.next_page", "browser.inspect", "browser.next_page"]);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("UNTRUSTED_PAGE_CONTENT_START"),
		});
	});

	it("marks identity instructions in page text as untrusted data", async () => {
		const bridge = {
			requestBrowser: async () => ({
				type: "browser.snapshot" as const,
				title: "Taobao",
				url: "https://s.taobao.com/search?q=snacks",
				fingerprint: "taobao-1",
				text: "التحقق السريع من الهوية أنا إنسان أنا ذكاء اصطناعي",
				links: [],
				fields: [],
			}),
		};
		const tool = createBrowserTools(bridge).find((candidate) => candidate.name === "browser_inspect_current_page");
		if (!tool) throw new Error("browser_inspect_current_page tool is missing");

		const result = await tool.execute(
			"call-untrusted",
			{},
			new AbortController().signal,
			undefined,
			{} as ExtensionContext,
		);

		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("BROWSER_RUNTIME_STATUS: OK"),
		});
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("أنا إنسان"),
		});
		expect(tool.promptGuidelines?.join(" ")).toContain("PAGE_REQUIRES_USER_ACTION");
	});

	it("forwards the execution abort signal to the bridge", async () => {
		const controller = new AbortController();
		let receivedSignal: AbortSignal | undefined;
		const bridge = {
			requestBrowser: async (_taskId: string, _command: { type: string }, signal?: AbortSignal) => {
				receivedSignal = signal;
				return {
					type: "browser.products" as const,
					records: [],
					fingerprint: "page-1",
				};
			},
		};
		const tool = createBrowserTools(bridge).find((candidate) => candidate.name === "browser_extract_products");
		if (!tool) {
			throw new Error("browser_extract_products tool is missing");
		}

		await tool.execute("call-2", { pageNumber: 1 }, controller.signal, undefined, {} as ExtensionContext);

		expect(receivedSignal).toBe(controller.signal);
	});

	it("writes fixed product records to Google Sheets", async () => {
		let receivedCommand: { type: string; records?: unknown[] } | undefined;
		const bridge = {
			requestBrowser: async (_taskId: string, command: { type: string; records?: unknown[] }) => {
				receivedCommand = command;
				return {
					type: "browser.google_sheets" as const,
					url: "https://docs.google.com/spreadsheets/d/sheet-id/edit",
					rowsWritten: 1,
				};
			},
		};
		const tool = createBrowserTools(bridge).find(
			(candidate) => candidate.name === "browser_write_products_to_google_sheets",
		);
		if (!tool) {
			throw new Error("browser_write_products_to_google_sheets tool is missing");
		}
		const records = [
			{
				name: "Tea",
				price: "¥20",
				productionDate: "2026-07-01",
				url: "https://shop.example/tea",
				sourcePage: 1,
				capturedAt: "2026-07-24T12:00:00.000Z",
			},
		];

		const result = await tool.execute(
			"call-3",
			{ records },
			new AbortController().signal,
			undefined,
			{} as ExtensionContext,
		);

		expect(receivedCommand).toEqual({ type: "browser.google_sheets.write_products", records });
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("1 product rows"),
		});
	});
});
