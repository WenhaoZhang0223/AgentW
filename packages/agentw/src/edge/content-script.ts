/// <reference types="chrome" />

import { AgentWError } from "../shared/errors.ts";
import type { ProductRecord } from "../shared/product.ts";
import type { BrowserCommand, BrowserResult } from "../shared/protocol.ts";
import {
	MAX_BROWSER_INPUT_CHARACTERS,
	MAX_ELEMENT_REFERENCE_CHARACTERS,
	MAX_SEARCH_QUERY_CHARACTERS,
} from "../shared/protocol.ts";
import { productsToTsv } from "./google-sheets.ts";
import { PageActionRegistry } from "./page-actions.ts";
import { extractProducts } from "./product-extractor.ts";

interface ContentScope {
	agentWContentScriptVersion?: number;
}

const CONTENT_SCRIPT_VERSION = 3;

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function parseCommand(value: unknown): BrowserCommand {
	const command = record(value);
	switch (command.type) {
		case "browser.inspect":
			return { type: "browser.inspect" };
		case "browser.click":
			if (
				(typeof command.reference === "string" && command.reference.length > 0) ||
				(typeof command.text === "string" && command.text.length > 0)
			) {
				return {
					type: "browser.click",
					reference: typeof command.reference === "string" ? command.reference : undefined,
					text: typeof command.text === "string" ? command.text : undefined,
				};
			}
			break;
		case "browser.type_text":
			if (
				typeof command.reference === "string" &&
				command.reference.length > 0 &&
				command.reference.length <= MAX_ELEMENT_REFERENCE_CHARACTERS &&
				typeof command.text === "string" &&
				command.text.length <= MAX_BROWSER_INPUT_CHARACTERS &&
				typeof command.submit === "boolean"
			) {
				return {
					type: "browser.type_text",
					reference: command.reference,
					text: command.text,
					submit: command.submit,
				};
			}
			break;
		case "browser.search":
			if (
				typeof command.query === "string" &&
				command.query.length > 0 &&
				command.query.length <= MAX_SEARCH_QUERY_CHARACTERS
			) {
				return { type: "browser.search", query: command.query };
			}
			break;
		case "browser.extract_products":
			if (Number.isInteger(command.pageNumber)) {
				return { type: "browser.extract_products", pageNumber: Number(command.pageNumber) };
			}
			break;
		case "browser.next_page":
			return { type: "browser.next_page" };
		case "browser.reload":
			return { type: "browser.reload" };
		case "browser.wait_for_change":
			if (typeof command.previousFingerprint === "string" && typeof command.timeoutMs === "number") {
				return {
					type: "browser.wait_for_change",
					previousFingerprint: command.previousFingerprint,
					timeoutMs: command.timeoutMs,
				};
			}
			break;
	}
	throw new AgentWError("INVALID_MESSAGE");
}

const scope = globalThis as typeof globalThis & ContentScope;
if (scope.agentWContentScriptVersion !== CONTENT_SCRIPT_VERSION) {
	scope.agentWContentScriptVersion = CONTENT_SCRIPT_VERSION;
	const actions = new PageActionRegistry(document, location);

	const execute = async (command: BrowserCommand): Promise<BrowserResult> => {
		switch (command.type) {
			case "browser.inspect":
				return { type: "browser.snapshot", ...(await actions.inspect()) };
			case "browser.click": {
				const snapshot = await actions.inspect();
				if (command.reference) {
					actions.click(command.reference);
				} else if (command.text) {
					actions.clickByText(command.text);
				}
				return { type: "browser.action", changed: false, fingerprint: snapshot.fingerprint };
			}
			case "browser.type_text": {
				const snapshot = await actions.inspect();
				actions.typeText(command.reference, command.text, command.submit);
				return { type: "browser.action", changed: false, fingerprint: snapshot.fingerprint };
			}
			case "browser.search": {
				const snapshot = await actions.inspect();
				actions.search(command.query);
				return { type: "browser.action", changed: false, fingerprint: snapshot.fingerprint };
			}
			case "browser.next_page":
				return actions.nextPage();
			case "browser.reload": {
				const snapshot = await actions.inspect();
				location.reload();
				return { type: "browser.action", changed: false, fingerprint: snapshot.fingerprint };
			}
			case "browser.wait_for_change":
				return actions.waitForChange(command.previousFingerprint, command.timeoutMs);
			case "browser.extract_products": {
				const snapshot = await actions.inspect();
				return {
					type: "browser.products",
					records: extractProducts(document, command.pageNumber, new Date().toISOString()),
					fingerprint: snapshot.fingerprint,
				};
			}
			case "browser.google_sheets.write_products":
				return writeProductsToGoogleSheets(command.records);
		}
	};

	const writeProductsToGoogleSheets = async (records: ProductRecord[]): Promise<BrowserResult> => {
		if (location.hostname !== "docs.google.com" || !/^\/spreadsheets\/d\/[^/]+/.test(location.pathname)) {
			throw new AgentWError(
				"PAGE_REQUIRES_USER_ACTION",
				"请先完成 Google 登录并打开一个可编辑的 Google 表格，然后告诉 AgentW 继续。",
			);
		}
		const tsv = productsToTsv(records);
		await navigator.clipboard.writeText(tsv);
		const firstCell = document.querySelector<HTMLElement>('[aria-label="A1"], [role="gridcell"], .waffle-cell');
		firstCell?.click();
		firstCell?.focus();
		await new Promise<void>((resolveWait) => setTimeout(resolveWait, 200));
		const target = document.activeElement ?? firstCell ?? document.body;
		const clipboard = new DataTransfer();
		clipboard.setData("text/plain", tsv);
		const paste = new ClipboardEvent("paste", {
			bubbles: true,
			cancelable: true,
			clipboardData: clipboard,
		});
		if (target.dispatchEvent(paste)) {
			throw new AgentWError(
				"PAGE_REQUIRES_USER_ACTION",
				"商品数据已复制到剪贴板。请在 Google 表格中点击 A1 并按 Ctrl+V，然后告诉 AgentW 已完成。",
			);
		}
		return {
			type: "browser.google_sheets",
			url: location.href,
			rowsWritten: records.length,
		};
	};

	chrome.runtime.onMessage.addListener((input: unknown, _sender, sendResponse) => {
		const message = record(input);
		if (message.channel === "agentw.google_sheets.write") {
			void writeProductsToGoogleSheets(
				Array.isArray(message.records) ? (message.records as ProductRecord[]) : [],
			).then(
				(result) => sendResponse({ ok: true, result }),
				(error: unknown) => {
					const agentError = error instanceof AgentWError ? error : new AgentWError("PAGE_ACCESS_DENIED");
					sendResponse({ ok: false, code: agentError.code, message: agentError.message });
				},
			);
			return true;
		}
		if (message.channel !== "agentw.browser.command") return;
		void execute(parseCommand(message.command)).then(
			(result) => sendResponse({ ok: true, result }),
			(error: unknown) => {
				const agentError = error instanceof AgentWError ? error : new AgentWError("PAGE_ACCESS_DENIED");
				sendResponse({ ok: false, code: agentError.code, message: agentError.message });
			},
		);
		return true;
	});
}
