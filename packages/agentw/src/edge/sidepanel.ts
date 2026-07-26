/// <reference types="chrome" />

import type { ArtifactDescriptor, InstalledSkill } from "../shared/product.ts";
import type { AgentWEnvelope, ClientMessage, HostMessage } from "../shared/protocol.ts";
import { createEnvelope, MAX_BINARY_CHUNK_BYTES, parseEnvelope } from "../shared/protocol.ts";
import { artifactsFromAgentEvent } from "./agent-artifacts.ts";
import { ArtifactDownloads } from "./artifact-download.ts";
import { normalizeAssistantText } from "./assistant-text.ts";
import type { ConversationMessage, SidePanelEvent, SidePanelState } from "./state.ts";
import { initialSidePanelState, reduceSidePanelState } from "./state.ts";

function element<T extends HTMLElement>(id: string): T {
	const value = document.getElementById(id);
	if (!value) throw new Error(`Missing side-panel element: ${id}`);
	return value as T;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

const conversation = element<HTMLElement>("conversation");
const composer = element<HTMLFormElement>("composer");
const promptInput = element<HTMLTextAreaElement>("prompt");
const sendButton = element<HTMLButtonElement>("send");
const stopButton = element<HTMLButtonElement>("stop");
const modelSelect = element<HTMLSelectElement>("model-select");
const settingsPanel = element<HTMLElement>("settings-panel");
const taskStatus = element<HTMLDetailsElement>("task-status");
const statusText = element<HTMLElement>("status-text");
const authorizationText = element<HTMLElement>("authorization-text");
const versionText = element<HTMLElement>("version");
const skillList = element<HTMLElement>("skill-list");
const skillStatus = element<HTMLElement>("skill-status");
const artifactDownloads = new ArtifactDownloads();
const requestedArtifacts = new Map<string, ArtifactDescriptor>();
const downloadedArtifactIds = new Set<string>();

versionText.textContent = `v${chrome.runtime.getManifest().version}`;

let state: SidePanelState = initialSidePanelState;
let currentTaskId = crypto.randomUUID();
let installedSkills: InstalledSkill[] = [];

function dispatch(event: SidePanelEvent): void {
	state = reduceSidePanelState(state, event);
	render();
}

function messageNode(message: ConversationMessage, streaming = false): HTMLElement {
	const node = document.createElement("article");
	node.className = `message ${message.role}${streaming ? " streaming" : ""}`;
	node.textContent = message.role === "assistant" ? normalizeAssistantText(message.text) : message.text;
	return node;
}

function renderConversation(): void {
	conversation.replaceChildren();
	if (state.messages.length === 0 && state.assistantDraft.length === 0 && state.artifacts.length === 0) {
		const empty = document.createElement("div");
		empty.className = "empty";
		const title = document.createElement("strong");
		title.textContent = "当前网页，需要我帮你做什么？";
		const description = document.createElement("span");
		description.textContent = "可以提取商品、整理网页信息，或直接聊天。";
		empty.append(title, description);
		conversation.append(empty);
		return;
	}
	let latestAssistantIndex = -1;
	for (let index = state.messages.length - 1; index >= 0; index--) {
		if (state.messages[index]?.role === "assistant") {
			latestAssistantIndex = index;
			break;
		}
	}
	for (const [index, message] of state.messages.entries()) {
		conversation.append(messageNode(message));
		if (!state.assistantDraft && index === latestAssistantIndex) appendArtifactCards(conversation);
	}
	if (state.assistantDraft) {
		conversation.append(messageNode({ id: "draft", role: "assistant", text: state.assistantDraft }, true));
		appendArtifactCards(conversation);
	} else if (latestAssistantIndex === -1) {
		appendArtifactCards(conversation);
	}
	conversation.scrollTop = conversation.scrollHeight;
}

function downloadArtifact(artifact: ArtifactDescriptor): void {
	if (requestedArtifacts.has(artifact.id) || downloadedArtifactIds.has(artifact.id)) return;
	try {
		artifactDownloads.begin(artifact);
		requestedArtifacts.set(artifact.id, artifact);
		renderConversation();
		void send({ type: "artifact.download", artifactId: artifact.id }).catch((error: unknown) => {
			artifactDownloads.cancel(artifact.id);
			requestedArtifacts.delete(artifact.id);
			renderConversation();
			showError(error);
		});
	} catch (error) {
		showError(error);
	}
}

async function finishArtifactDownload(artifactId: string): Promise<void> {
	const artifact = requestedArtifacts.get(artifactId);
	if (!artifact) {
		throw new Error("Artifact download was not requested");
	}
	try {
		const bytes = await artifactDownloads.complete(artifactId);
		const lowerName = artifact.name.toLowerCase();
		const blob = new Blob([bytes.slice().buffer], {
			type: lowerName.endsWith(".json")
				? "application/json"
				: lowerName.endsWith(".docx")
					? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
					: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		});
		const url = URL.createObjectURL(blob);
		try {
			await chrome.downloads.download({
				url,
				filename: artifact.name,
				saveAs: false,
				conflictAction: "uniquify",
			});
		} finally {
			URL.revokeObjectURL(url);
		}
		downloadedArtifactIds.add(artifactId);
		requestedArtifacts.delete(artifactId);
		renderConversation();
		await send({ type: "artifact.downloaded", artifactId });
	} catch (error) {
		artifactDownloads.cancel(artifactId);
		requestedArtifacts.delete(artifactId);
		renderConversation();
		throw error;
	}
}

function appendArtifactCards(parent: HTMLElement): void {
	if (state.artifacts.length === 0) return;
	const list = document.createElement("section");
	list.className = "artifacts";
	list.setAttribute("aria-label", "生成的文件");
	for (const item of state.artifacts) {
		const card = document.createElement("article");
		card.className = "artifact";
		const name = document.createElement("p");
		name.textContent = `${item.name} · ${Math.ceil(item.size / 1024)} KB`;
		const button = document.createElement("button");
		button.type = "button";
		const downloaded = downloadedArtifactIds.has(item.id);
		const requested = requestedArtifacts.has(item.id);
		button.textContent = downloaded ? "已下载" : requested ? "下载中…" : "下载";
		button.disabled = downloaded || requested;
		button.addEventListener("click", () => downloadArtifact(item));
		card.append(name, button);
		list.append(card);
	}
	parent.append(list);
}

function renderModels(): void {
	const selected = state.selectedModel ? JSON.stringify([state.selectedModel.provider, state.selectedModel.id]) : "";
	modelSelect.replaceChildren();
	for (const model of state.models) {
		const option = document.createElement("option");
		option.value = JSON.stringify([model.provider, model.id]);
		option.textContent = `${model.name} · ${model.provider}`;
		option.selected = option.value === selected;
		modelSelect.append(option);
	}
	if (state.models.length === 0) {
		const option = document.createElement("option");
		option.textContent = "暂无可用模型";
		modelSelect.append(option);
	}
}

function renderSkills(): void {
	skillList.replaceChildren();
	for (const skill of installedSkills) {
		const row = document.createElement("div");
		row.className = "skill-row";
		const name = document.createElement("span");
		name.textContent = `${skill.name} · ${skill.enabled ? "已启用" : "已停用"}`;
		const toggle = document.createElement("button");
		toggle.type = "button";
		toggle.textContent = skill.enabled ? "停用" : "启用";
		toggle.addEventListener("click", () => {
			void send({ type: skill.enabled ? "skill.disable" : "skill.enable", name: skill.name }).catch(showError);
		});
		const remove = document.createElement("button");
		remove.type = "button";
		remove.textContent = "删除";
		remove.addEventListener("click", () => {
			if (window.confirm(`确定删除 Skill “${skill.name}”吗？`)) {
				void send({ type: "skill.delete", name: skill.name }).catch(showError);
			}
		});
		row.append(name, toggle, remove);
		skillList.append(row);
	}
}

function render(): void {
	taskStatus.dataset.status = state.status;
	statusText.textContent = state.statusText;
	taskStatus.open = state.status === "error";
	stopButton.disabled = state.status !== "running";
	sendButton.disabled = state.status === "running" || !promptInput.value.trim();
	renderConversation();
	renderModels();
	renderSkills();
}

async function send(message: ClientMessage): Promise<void> {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	authorizationText.textContent =
		tab?.url && (tab.url.startsWith("http://") || tab.url.startsWith("https://"))
			? `当前页面：${tab.title || tab.url}\n${tab.url}`
			: "当前页面不可读取，请切换到普通 http/https 网页。";
	await chrome.runtime.sendMessage({
		channel: "agentw.client",
		tabId: tab?.id,
		windowId: tab?.windowId,
		title: tab?.title,
		url: tab?.url,
		envelope: createEnvelope(crypto.randomUUID(), currentTaskId, message),
	});
}

function showError(error: unknown): void {
	dispatch({ type: "task.error", message: error instanceof Error ? error.message : String(error) });
}

function encodeBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < bytes.byteLength; offset += 32_768) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
	}
	return btoa(binary);
}

async function uploadSkillFiles(files: File[], format: "files" | "zip"): Promise<void> {
	if (files.length === 0 || files.length > 200) {
		throw new Error("Skill 文件数量必须在 1 到 200 之间");
	}
	const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
	const maximum = format === "zip" ? 10 * 1024 * 1024 : 50 * 1024 * 1024;
	if (totalBytes <= 0 || totalBytes > maximum) {
		throw new Error(format === "zip" ? "Skill ZIP 不能超过 10 MiB" : "Skill 文件夹不能超过 50 MiB");
	}
	const overwrite = window.confirm("如果存在同名 Skill，是否允许覆盖？取消仍会安装新的 Skill，但不会覆盖已有内容。");
	const uploadId = crypto.randomUUID();
	const firstPath = files[0]?.webkitRelativePath || files[0]?.name || "skill";
	await send({
		type: "skill.upload.begin",
		uploadId,
		name: firstPath.split("/")[0] ?? "skill",
		format,
		totalBytes,
		overwrite,
	});
	let index = 0;
	for (const file of files) {
		const bytes = new Uint8Array(await file.arrayBuffer());
		for (let offset = 0; offset < bytes.byteLength; offset += MAX_BINARY_CHUNK_BYTES) {
			const chunk = bytes.subarray(offset, offset + MAX_BINARY_CHUNK_BYTES);
			await send({
				type: "skill.upload.chunk",
				uploadId,
				index: index++,
				data: encodeBase64(chunk),
				relativePath: format === "files" ? file.webkitRelativePath || file.name : undefined,
			});
		}
	}
	skillStatus.textContent = "正在验证并安装 Skill…";
	await send({ type: "skill.upload.finish", uploadId });
}

function handleAgentEvent(input: unknown): void {
	const event = record(input);
	if (event.type === "message_update") {
		const update = record(event.assistantMessageEvent);
		if (update.type === "text_delta" && typeof update.delta === "string") {
			dispatch({ type: "assistant.delta", text: update.delta });
		}
	} else if (event.type === "tool_execution_start") {
		dispatch({
			type: "task.started",
			text: typeof event.toolName === "string" ? `正在执行 ${event.toolName}…` : undefined,
		});
	} else if (event.type === "agent_start") {
		dispatch({ type: "task.started" });
	} else if (event.type === "tool_execution_end") {
		for (const artifact of artifactsFromAgentEvent(input)) {
			dispatch({ type: "artifact.ready", ...artifact });
		}
	} else if (event.type === "agent_settled") {
		dispatch({ type: "task.settled", messageId: crypto.randomUUID() });
		void send({ type: "artifact.list" }).catch(showError);
	}
}

function handleHost(envelope: AgentWEnvelope<HostMessage>): void {
	const message = envelope.message;
	switch (message.type) {
		case "host.ready":
			dispatch({ type: "host.ready" });
			void send({ type: "artifact.list" }).catch(showError);
			break;
		case "agent.event":
			handleAgentEvent(message.event);
			break;
		case "model.list":
			dispatch({ type: "model.list", models: message.models, selected: message.selected });
			break;
		case "artifact.ready":
			dispatch(message);
			break;
		case "artifact.chunk":
			artifactDownloads.addChunk(message.artifactId, message.index, message.data);
			break;
		case "artifact.complete":
			void finishArtifactDownload(message.artifactId).catch(showError);
			break;
		case "skill.installed":
			skillStatus.textContent = `已安装 ${message.name}，将在下一次新对话中可用。`;
			break;
		case "skill.list":
			installedSkills = message.skills;
			renderSkills();
			break;
		case "error":
			dispatch({ type: "task.error", message: message.message });
			break;
	}
}

composer.addEventListener("submit", (event) => {
	event.preventDefault();
	const text = promptInput.value.trim();
	if (!text || state.status === "running") return;
	currentTaskId = crypto.randomUUID();
	dispatch({ type: "user.sent", message: { id: crypto.randomUUID(), role: "user", text } });
	promptInput.value = "";
	void send({ type: "chat.prompt", text }).catch(showError);
});

promptInput.addEventListener("input", () => {
	promptInput.style.height = "auto";
	promptInput.style.height = `${Math.min(promptInput.scrollHeight, 180)}px`;
	sendButton.disabled = state.status === "running" || !promptInput.value.trim();
});

promptInput.addEventListener("keydown", (event) => {
	if (event.key === "Enter" && !event.shiftKey) {
		event.preventDefault();
		composer.requestSubmit();
	}
});

stopButton.addEventListener("click", () => {
	void send({ type: "chat.abort" }).catch(showError);
	dispatch({ type: "task.stopped" });
});

element<HTMLButtonElement>("new-chat").addEventListener("click", () => {
	currentTaskId = crypto.randomUUID();
	dispatch({ type: "session.new" });
	void send({ type: "session.new" }).catch(showError);
});

element<HTMLButtonElement>("settings-toggle").addEventListener("click", () => {
	settingsPanel.hidden = !settingsPanel.hidden;
});

modelSelect.addEventListener("change", () => {
	try {
		const selected: unknown = JSON.parse(modelSelect.value);
		if (Array.isArray(selected) && typeof selected[0] === "string" && typeof selected[1] === "string") {
			void send({ type: "model.set", provider: selected[0], modelId: selected[1] }).catch(showError);
		}
	} catch (error) {
		showError(error);
	}
});

element<HTMLButtonElement>("skill-zip-button").addEventListener("click", () =>
	element<HTMLInputElement>("skill-zip-input").click(),
);
element<HTMLButtonElement>("skill-folder-button").addEventListener("click", () =>
	element<HTMLInputElement>("skill-folder-input").click(),
);
element<HTMLInputElement>("skill-zip-input").addEventListener("change", (event) => {
	const input = event.currentTarget as HTMLInputElement;
	const file = input.files?.[0];
	if (file) {
		void uploadSkillFiles([file], "zip").catch(showError);
	}
	input.value = "";
});
element<HTMLInputElement>("skill-folder-input").addEventListener("change", (event) => {
	const input = event.currentTarget as HTMLInputElement;
	if (input.files) {
		void uploadSkillFiles([...input.files], "files").catch(showError);
	}
	input.value = "";
});

chrome.runtime.onMessage.addListener((input: unknown) => {
	const message = record(input);
	if (message.channel === "agentw.host") {
		try {
			handleHost(parseEnvelope(message.envelope) as AgentWEnvelope<HostMessage>);
		} catch (error) {
			showError(error);
		}
	} else if (message.channel === "agentw.native.disconnected") {
		dispatch({
			type: "host.disconnected",
			message: typeof message.message === "string" ? message.message : undefined,
		});
	} else if (message.channel === "agentw.authorization") {
		authorizationText.textContent =
			message.authorized === true
				? typeof message.url === "string"
					? `当前页面：${typeof message.title === "string" && message.title ? message.title : message.url}\n${message.url}`
					: "已自动同步当前网页。切换网站或标签后会实时更新。"
				: typeof message.message === "string"
					? message.message
					: "当前页面不可读取，请切换到普通 http/https 网页。";
	} else if (message.channel === "agentw.page.context") {
		authorizationText.textContent =
			typeof message.url === "string"
				? `当前页面：${typeof message.title === "string" && message.title ? message.title : message.url}\n${message.url}`
				: "当前页面不可读取，请切换到普通 http/https 网页。";
	}
});

render();
void send({ type: "model.list" }).catch(showError);
void send({ type: "skill.list" }).catch(showError);
void send({ type: "artifact.list" }).catch(showError);
