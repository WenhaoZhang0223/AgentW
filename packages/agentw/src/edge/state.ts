import type { ArtifactDescriptor } from "../shared/product.ts";
import type { ModelSummary } from "../shared/protocol.ts";

export type TaskStatus = "connecting" | "idle" | "running" | "stopped" | "error";

export interface ConversationMessage {
	id: string;
	role: "user" | "assistant";
	text: string;
}

export interface SidePanelState {
	messages: ConversationMessage[];
	assistantDraft: string;
	status: TaskStatus;
	statusText: string;
	artifacts: ArtifactDescriptor[];
	models: ModelSummary[];
	selectedModel?: Pick<ModelSummary, "provider" | "id">;
}

export type SidePanelEvent =
	| { type: "host.ready" }
	| { type: "host.disconnected"; message?: string }
	| { type: "user.sent"; message: ConversationMessage }
	| { type: "assistant.delta"; text: string }
	| { type: "task.started"; text?: string }
	| { type: "task.settled"; messageId: string }
	| { type: "task.stopped" }
	| { type: "task.error"; message: string }
	| ({ type: "artifact.ready" } & ArtifactDescriptor)
	| { type: "model.list"; models: ModelSummary[]; selected?: Pick<ModelSummary, "provider" | "id"> }
	| { type: "session.new" };

export const initialSidePanelState: SidePanelState = {
	messages: [],
	assistantDraft: "",
	status: "connecting",
	statusText: "正在连接本地 AgentW…",
	artifacts: [],
	models: [],
};

export function reduceSidePanelState(state: SidePanelState, event: SidePanelEvent): SidePanelState {
	switch (event.type) {
		case "host.ready":
			return { ...state, status: "idle", statusText: "已连接" };
		case "host.disconnected":
			return {
				...state,
				status: "error",
				statusText: event.message ? `本地 AgentW 未连接：${event.message}` : "本地 AgentW 未连接",
			};
		case "user.sent":
			return {
				...state,
				messages: [...state.messages, event.message],
				assistantDraft: "",
				status: "running",
				statusText: "AgentW 正在处理…",
			};
		case "assistant.delta":
			return { ...state, assistantDraft: state.assistantDraft + event.text, status: "running" };
		case "task.started":
			return { ...state, status: "running", statusText: event.text ?? "AgentW 正在处理…" };
		case "task.settled":
			return {
				...state,
				messages:
					state.assistantDraft.length > 0
						? [...state.messages, { id: event.messageId, role: "assistant", text: state.assistantDraft }]
						: state.messages,
				assistantDraft: "",
				status: "idle",
				statusText: "已完成",
			};
		case "task.stopped":
			return { ...state, status: "stopped", statusText: "已停止" };
		case "task.error":
			return { ...state, status: "error", statusText: event.message };
		case "artifact.ready":
			if (event.name.toLowerCase().endsWith(".json")) return state;
			return { ...state, artifacts: [...state.artifacts.filter((item) => item.id !== event.id), event] };
		case "model.list":
			return { ...state, models: event.models, selectedModel: event.selected };
		case "session.new":
			return {
				...initialSidePanelState,
				status: state.status === "error" ? "error" : "idle",
				statusText: state.status === "error" ? state.statusText : "新对话",
				models: state.models,
				selectedModel: state.selectedModel,
			};
	}
}
