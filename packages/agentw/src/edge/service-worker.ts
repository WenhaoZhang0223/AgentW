/// <reference types="chrome" />

import { AgentWError, type AgentWErrorCode } from "../shared/errors.ts";
import type { AgentWEnvelope, BrowserCommand, BrowserResult, ClientMessage, HostMessage } from "../shared/protocol.ts";
import { createEnvelope, parseEnvelope } from "../shared/protocol.ts";
import { ArtifactRegistry } from "./artifact-registry.ts";
import { classifyGoogleSheetsPage } from "./google-sheets.ts";
import { type ActivePageContext, addCurrentPageContext } from "./prompt-context.ts";
import { type AuthorizedTab, isAuthorizedActiveTab } from "./tab-authorization.ts";
import { TaskTabRegistry } from "./task-tabs.ts";

const HOST_NAME = "com.earendil_works.agentw";
const BROWSER_COMMAND_RETRY_TIMEOUT_MS = 20_000;
const ERROR_CODES = new Set<AgentWErrorCode>([
	"PAGE_ACCESS_DENIED",
	"PAGE_REQUIRES_USER_ACTION",
	"STALE_ELEMENT_REFERENCE",
	"NEXT_PAGE_NOT_FOUND",
	"HOST_DISCONNECTED",
	"AGENT_TIMEOUT",
	"EXPORT_FAILED",
	"SKILL_VALIDATION_FAILED",
	"TASK_ABORTED",
	"INVALID_MESSAGE",
	"UNSUPPORTED_PROTOCOL",
	"MESSAGE_TOO_LARGE",
]);

let authorizedTab: AuthorizedTab | undefined;
let nativePort: chrome.runtime.Port | undefined;
let panelWindowId: number | undefined;
const currentPages = new Map<number, ActivePageContext>();
const taskTabs = new TaskTabRegistry();
const availableArtifacts = new ArtifactRegistry();

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function notify(message: unknown): void {
	void chrome.runtime.sendMessage(message).catch(() => undefined);
}

function pageOrigin(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		const value = new URL(url);
		return value.protocol === "http:" || value.protocol === "https:" ? value.origin : undefined;
	} catch {
		return undefined;
	}
}

function syncCurrentPage(tab: chrome.tabs.Tab | undefined): void {
	const readable = pageOrigin(tab?.url) !== undefined;
	if (tab?.windowId === undefined) return;
	const page = readable ? { title: tab.title, url: tab.url } : {};
	currentPages.set(tab.windowId, page);
	if (panelWindowId === undefined || tab.windowId === panelWindowId) {
		notify({ channel: "agentw.page.context", title: page.title, url: page.url });
	}
}

function connectHost(): chrome.runtime.Port | undefined {
	if (nativePort) return nativePort;
	try {
		const port = chrome.runtime.connectNative(HOST_NAME);
		nativePort = port;
		port.onMessage.addListener(handleHostMessage);
		port.onDisconnect.addListener(() => {
			const message = chrome.runtime.lastError?.message;
			if (nativePort === port) nativePort = undefined;
			availableArtifacts.clear();
			notify({ channel: "agentw.native.disconnected", message });
		});
		return port;
	} catch (error) {
		notify({
			channel: "agentw.native.disconnected",
			message: error instanceof Error ? error.message : "Native Host connection failed",
		});
		return undefined;
	}
}

function post(envelope: AgentWEnvelope<ClientMessage>): void {
	connectHost()?.postMessage(envelope);
}

function isBrowserResult(value: unknown): value is BrowserResult {
	const type = record(value).type;
	return (
		type === "browser.snapshot" ||
		type === "browser.products" ||
		type === "browser.action" ||
		type === "browser.google_sheets"
	);
}

type BrowserCommandEnvelope = AgentWEnvelope<Extract<HostMessage, { type: "browser.command" }>>;

function browserError(envelope: BrowserCommandEnvelope, code: AgentWErrorCode, message: string): void {
	post(
		createEnvelope(envelope.requestId, envelope.taskId, {
			type: "browser.error",
			commandId: envelope.message.commandId,
			code,
			message,
		}),
	);
}

function browserResult(envelope: BrowserCommandEnvelope, result: BrowserResult): void {
	post(
		createEnvelope(envelope.requestId, envelope.taskId, {
			type: "browser.result",
			commandId: envelope.message.commandId,
			result,
		}),
	);
}

async function activeTab(windowId = panelWindowId): Promise<chrome.tabs.Tab | undefined> {
	const [tab] =
		windowId === undefined
			? await chrome.tabs.query({ active: true, lastFocusedWindow: true })
			: await chrome.tabs.query({ active: true, windowId });
	return tab;
}

const currentPagesReady = chrome.tabs
	.query({ active: true })
	.then((tabs) => {
		for (const tab of tabs) syncCurrentPage(tab);
	})
	.catch(() => undefined);

async function authorizeActiveTab(): Promise<AuthorizedTab | undefined> {
	const tab = await activeTab();
	const origin = pageOrigin(tab?.url);
	if (isAuthorizedActiveTab(authorizedTab, tab?.id, origin)) {
		return authorizedTab;
	}
	if (!tab) {
		authorizedTab = undefined;
		return undefined;
	}
	await authorize(tab);
	return isAuthorizedActiveTab(authorizedTab, tab.id, origin) ? authorizedTab : undefined;
}

async function authorizeTaskTab(taskId: string): Promise<AuthorizedTab | undefined> {
	const target = taskTabs.get(taskId);
	if (!target) return authorizeActiveTab();
	const tab = await chrome.tabs.get(target.tabId).catch(() => undefined);
	if (!tab || tab.windowId !== target.windowId) return undefined;
	const visible = await activeTab(target.windowId);
	if (visible?.id !== tab.id) return undefined;
	const origin = pageOrigin(tab.url);
	if (isAuthorizedActiveTab(authorizedTab, tab.id, origin)) {
		return authorizedTab;
	}
	await authorize(tab);
	return isAuthorizedActiveTab(authorizedTab, tab.id, origin) ? authorizedTab : undefined;
}

function commandMayNavigate(command: BrowserCommand): boolean {
	return (
		command.type === "browser.search" ||
		command.type === "browser.next_page" ||
		command.type === "browser.click" ||
		(command.type === "browser.type_text" && command.submit)
	);
}

async function waitForTaskAuthorization(
	taskId: string,
	deadline = Date.now() + BROWSER_COMMAND_RETRY_TIMEOUT_MS,
): Promise<AuthorizedTab | undefined> {
	while (Date.now() < deadline) {
		const target = taskTabs.get(taskId);
		if (!target) return authorizeActiveTab();
		const [tab, visible] = await Promise.all([
			chrome.tabs.get(target.tabId).catch(() => undefined),
			activeTab(target.windowId),
		]);
		if (!tab || visible?.id !== target.tabId) return undefined;
		if (tab.status === "loading") {
			await new Promise<void>((resolveWait) => setTimeout(resolveWait, 200));
			continue;
		}
		const origin = pageOrigin(tab.url);
		if (isAuthorizedActiveTab(authorizedTab, tab.id, origin)) return authorizedTab;
		await authorize(tab);
		if (isAuthorizedActiveTab(authorizedTab, tab.id, origin)) return authorizedTab;
		await new Promise<void>((resolveWait) => setTimeout(resolveWait, 200));
	}
	return undefined;
}

async function recoveredNavigationResponse(tabId: number): Promise<Record<string, unknown>> {
	const response = record(
		await chrome.tabs.sendMessage(tabId, {
			channel: "agentw.browser.command",
			command: { type: "browser.inspect" },
		}),
	);
	const result = record(response.result);
	if (response.ok === true && result.type === "browser.snapshot" && typeof result.fingerprint === "string") {
		return {
			ok: true,
			result: {
				type: "browser.action",
				changed: true,
				fingerprint: `agentw-navigation-recovered-${Date.now()}`,
			},
		};
	}
	return response;
}

async function sendBrowserCommandWithRetry(
	envelope: BrowserCommandEnvelope,
	initialAuthorization: AuthorizedTab,
): Promise<Record<string, unknown>> {
	const deadline = Date.now() + BROWSER_COMMAND_RETRY_TIMEOUT_MS;
	const initialTab = await chrome.tabs.get(initialAuthorization.tabId).catch(() => undefined);
	const initialUrl = initialTab?.url;
	const mayNavigate = commandMayNavigate(envelope.message.command);
	let navigationObserved = false;
	let authorization = initialAuthorization;
	let lastError: Error | undefined;
	while (Date.now() < deadline) {
		try {
			return record(
				await chrome.tabs.sendMessage(authorization.tabId, {
					channel: "agentw.browser.command",
					command: envelope.message.command,
				}),
			);
		} catch (error) {
			lastError = error instanceof Error ? error : new Error("Browser page unavailable");
		}

		const target = taskTabs.get(envelope.taskId);
		if (target) {
			const [tab, visible] = await Promise.all([
				chrome.tabs.get(target.tabId).catch(() => undefined),
				activeTab(target.windowId),
			]);
			if (!tab || visible?.id !== target.tabId) {
				throw new AgentWError("PAGE_ACCESS_DENIED", "The task page is no longer the visible tab");
			}
			if (mayNavigate && (tab.status === "loading" || (initialUrl !== undefined && tab.url !== initialUrl))) {
				navigationObserved = true;
			}
			if (tab.status === "loading") {
				await new Promise<void>((resolveWait) => setTimeout(resolveWait, 200));
				continue;
			}
			if (navigationObserved) {
				authorizedTab = undefined;
				const refreshed = await waitForTaskAuthorization(envelope.taskId, deadline);
				if (refreshed) return recoveredNavigationResponse(refreshed.tabId);
			}
		}

		const refreshed = await authorizeTaskTab(envelope.taskId);
		if (refreshed) authorization = refreshed;
		await new Promise<void>((resolveWait) => setTimeout(resolveWait, 200));
	}
	throw lastError ?? new AgentWError("PAGE_ACCESS_DENIED", "Browser navigation did not finish");
}

async function executeBrowserReload(envelope: BrowserCommandEnvelope): Promise<void> {
	const authorization = await authorizeTaskTab(envelope.taskId);
	if (!authorization) {
		browserError(envelope, "PAGE_ACCESS_DENIED", "AgentW cannot reload this browser page");
		return;
	}
	try {
		authorizedTab = undefined;
		await chrome.tabs.reload(authorization.tabId);
		const refreshed = await waitForTaskAuthorization(envelope.taskId);
		if (!refreshed) {
			throw new AgentWError("PAGE_ACCESS_DENIED", "The reloaded page is unavailable");
		}
		const response = await recoveredNavigationResponse(refreshed.tabId);
		if (response.ok === true && isBrowserResult(response.result)) {
			browserResult(envelope, response.result);
			return;
		}
		throw new AgentWError("PAGE_ACCESS_DENIED", "The reloaded page could not be inspected");
	} catch (error) {
		const agentError = error instanceof AgentWError ? error : new AgentWError("PAGE_ACCESS_DENIED");
		browserError(envelope, agentError.code, error instanceof Error ? error.message : agentError.message);
	}
}

async function waitForGoogleSheetsTab(tabId: number): Promise<chrome.tabs.Tab | undefined> {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		const tab = await chrome.tabs.get(tabId).catch(() => undefined);
		const page = classifyGoogleSheetsPage(tab?.url);
		if (page === "login" || (page === "sheet" && tab?.status === "complete")) {
			return tab;
		}
		await new Promise<void>((resolveWait) => setTimeout(resolveWait, 250));
	}
	return chrome.tabs.get(tabId).catch(() => undefined);
}

async function executeGoogleSheetsWrite(envelope: BrowserCommandEnvelope): Promise<void> {
	const command = envelope.message.command;
	if (command.type !== "browser.google_sheets.write_products") return;
	try {
		let tab = await activeTab();
		const activePage = classifyGoogleSheetsPage(tab?.url);
		if (activePage === "login") {
			browserError(
				envelope,
				"PAGE_REQUIRES_USER_ACTION",
				"请先在已打开的 Google 页面完成登录，然后告诉 AgentW 继续写入。",
			);
			return;
		}
		if (activePage === "other") {
			tab = await chrome.tabs.create({ url: "https://docs.google.com/spreadsheets/create", active: true });
		} else if (activePage === "sheets-home" && tab?.id !== undefined) {
			tab = await chrome.tabs.update(tab.id, { url: "https://docs.google.com/spreadsheets/create", active: true });
		}
		if (tab?.id === undefined) {
			throw new AgentWError("PAGE_ACCESS_DENIED", "Unable to open Google Sheets");
		}
		tab = await waitForGoogleSheetsTab(tab.id);
		if (tab?.id === undefined || classifyGoogleSheetsPage(tab.url) !== "sheet") {
			browserError(
				envelope,
				"PAGE_REQUIRES_USER_ACTION",
				"Google Sheets 已打开。请先登录并打开一个可编辑表格，然后告诉 AgentW 继续写入。",
			);
			return;
		}
		const sheetTabId = tab.id;
		await inject(sheetTabId);
		const response = record(
			await chrome.tabs.sendMessage(sheetTabId, {
				channel: "agentw.google_sheets.write",
				records: command.records,
			}),
		);
		if (response.ok === true && isBrowserResult(response.result)) {
			browserResult(envelope, response.result);
			return;
		}
		const code =
			typeof response.code === "string" && ERROR_CODES.has(response.code as AgentWErrorCode)
				? (response.code as AgentWErrorCode)
				: "PAGE_ACCESS_DENIED";
		browserError(
			envelope,
			code,
			typeof response.message === "string" ? response.message : "Google Sheets write failed",
		);
	} catch (error) {
		const agentError = error instanceof AgentWError ? error : new AgentWError("PAGE_ACCESS_DENIED");
		browserError(envelope, agentError.code, error instanceof Error ? error.message : agentError.message);
	}
}

async function executeBrowserCommand(envelope: BrowserCommandEnvelope): Promise<void> {
	if (envelope.message.command.type === "browser.google_sheets.write_products") {
		await executeGoogleSheetsWrite(envelope);
		return;
	}
	if (envelope.message.command.type === "browser.reload") {
		await executeBrowserReload(envelope);
		return;
	}
	const initialAuthorization = await authorizeTaskTab(envelope.taskId);
	if (!initialAuthorization) {
		browserError(envelope, "PAGE_ACCESS_DENIED", "AgentW cannot read this browser page");
		return;
	}
	try {
		const response = await sendBrowserCommandWithRetry(envelope, initialAuthorization);
		if (!(await waitForTaskAuthorization(envelope.taskId))) {
			browserError(envelope, "PAGE_ACCESS_DENIED", "The active page changed; try the request again");
			return;
		}
		if (response.ok === true && isBrowserResult(response.result)) {
			browserResult(envelope, response.result);
			return;
		}
		const code =
			typeof response.code === "string" && ERROR_CODES.has(response.code as AgentWErrorCode)
				? (response.code as AgentWErrorCode)
				: "PAGE_ACCESS_DENIED";
		browserError(envelope, code, typeof response.message === "string" ? response.message : "The page command failed");
	} catch (error) {
		const agentError = error instanceof AgentWError ? error : new AgentWError("PAGE_ACCESS_DENIED");
		browserError(envelope, agentError.code, error instanceof Error ? error.message : agentError.message);
	}
}

function handleHostMessage(input: unknown): void {
	try {
		const envelope = parseEnvelope(input) as AgentWEnvelope<HostMessage>;
		if (envelope.message.type === "browser.command") {
			void executeBrowserCommand(envelope as BrowserCommandEnvelope);
		} else {
			if (envelope.message.type === "artifact.ready") {
				availableArtifacts.upsert(envelope.message);
			}
			notify({ channel: "agentw.host", envelope });
			if (envelope.message.type === "agent.event" && record(envelope.message.event).type === "agent_settled") {
				taskTabs.delete(envelope.taskId);
			}
		}
	} catch {
		return;
	}
}

async function inject(tabId: number): Promise<void> {
	await chrome.scripting.executeScript({ target: { tabId }, files: ["content-script.js"] });
}

async function authorize(tab: chrome.tabs.Tab): Promise<void> {
	const tabId = tab.id;
	const origin = pageOrigin(tab.url);
	if (tabId === undefined || !origin) {
		authorizedTab = undefined;
		notify({ channel: "agentw.authorization", authorized: false, message: "此页面不允许扩展读取。" });
		return;
	}
	try {
		await inject(tabId);
		authorizedTab = { tabId, origin };
		notify({ channel: "agentw.authorization", authorized: true, title: tab.title, url: tab.url });
	} catch (error) {
		authorizedTab = undefined;
		notify({
			channel: "agentw.authorization",
			authorized: false,
			message: error instanceof Error ? error.message : "无法读取当前网页。",
		});
	}
}

chrome.action.onClicked.addListener((tab) => {
	if (tab.id === undefined) return;
	void chrome.sidePanel.open({ tabId: tab.id });
	connectHost();
	syncCurrentPage(tab);
	void authorize(tab);
});

chrome.runtime.onMessage.addListener((input: unknown) => {
	const message = record(input);
	if (message.channel !== "agentw.client") return;
	if (typeof message.windowId === "number") {
		panelWindowId = message.windowId;
	}
	try {
		const envelope = parseEnvelope(message.envelope) as AgentWEnvelope<ClientMessage>;
		if (envelope.message.type === "chat.prompt") {
			void currentPagesReady.then(async () => {
				const requestedTabId = typeof message.tabId === "number" ? message.tabId : undefined;
				const requestedWindowId = typeof message.windowId === "number" ? message.windowId : undefined;
				const requestedTab =
					requestedTabId === undefined ? undefined : await chrome.tabs.get(requestedTabId).catch(() => undefined);
				const tab =
					requestedTab &&
					requestedWindowId !== undefined &&
					requestedTab.windowId === requestedWindowId &&
					(await activeTab(requestedWindowId))?.id === requestedTab.id
						? requestedTab
						: await activeTab(requestedWindowId);
				if (tab?.id !== undefined) {
					taskTabs.bind(envelope.taskId, { tabId: tab.id, windowId: tab.windowId });
					panelWindowId = tab.windowId;
					syncCurrentPage(tab);
				}
				post(
					createEnvelope(envelope.requestId, envelope.taskId, {
						type: "chat.prompt",
						text: addCurrentPageContext(
							envelope.message.type === "chat.prompt" ? envelope.message.text : "",
							tab ? { title: tab.title, url: tab.url } : {},
						),
					}),
				);
			});
		} else {
			if (envelope.message.type === "session.new") {
				taskTabs.clear();
				availableArtifacts.clear();
			}
			if (envelope.message.type === "artifact.list") {
				for (const artifact of availableArtifacts.list()) {
					const message: HostMessage = { type: "artifact.ready", ...artifact };
					notify({
						channel: "agentw.host",
						envelope: createEnvelope(envelope.requestId, envelope.taskId, message),
					});
				}
			}
			if (envelope.message.type === "artifact.downloaded") {
				availableArtifacts.remove(envelope.message.artifactId);
			}
			post(envelope);
		}
	} catch {
		notify({ channel: "agentw.native.disconnected" });
	}
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
	authorizedTab = undefined;
	void chrome.tabs
		.get(tabId)
		.then(async (tab) => {
			syncCurrentPage(tab);
			await authorize(tab);
		})
		.catch(() => undefined);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
	const current = authorizedTab;
	const origin = pageOrigin(changeInfo.url ?? tab.url);
	if (current?.tabId === tabId && (changeInfo.status === "loading" || !origin || origin !== current.origin)) {
		authorizedTab = undefined;
	}
	if (tab.active && (changeInfo.url !== undefined || changeInfo.title !== undefined)) {
		syncCurrentPage(tab);
	}
	if (tab.active && changeInfo.status === "complete") {
		syncCurrentPage(tab);
		void authorize(tab);
	}
});

chrome.tabs.onRemoved.addListener((tabId) => {
	if (authorizedTab?.tabId === tabId) {
		authorizedTab = undefined;
		notify({ channel: "agentw.authorization", authorized: false, message: "已授权的标签页已关闭。" });
	}
});

chrome.runtime.onInstalled.addListener(() => {
	void activeTab()
		.then(async (tab) => {
			syncCurrentPage(tab);
			await authorizeActiveTab();
		})
		.catch(() => undefined);
});

chrome.runtime.onStartup.addListener(() => {
	void activeTab()
		.then(async (tab) => {
			syncCurrentPage(tab);
			await authorizeActiveTab();
		})
		.catch(() => undefined);
});

chrome.windows.onFocusChanged.addListener((windowId) => {
	if (windowId === chrome.windows.WINDOW_ID_NONE) return;
	authorizedTab = undefined;
	void activeTab()
		.then(async (tab) => {
			syncCurrentPage(tab);
			if (tab) await authorize(tab);
		})
		.catch(() => undefined);
});
