import { AgentWError, type AgentWErrorCode } from "./errors.ts";
import type { ArtifactDescriptor, InstalledSkill, ProductRecord } from "./product.ts";

export const PROTOCOL_VERSION = 1;
export const MAX_NATIVE_MESSAGE_BYTES = 512 * 1024;
export const MAX_BINARY_CHUNK_BYTES = 350 * 1024;
export const MAX_BROWSER_INPUT_CHARACTERS = 10_000;
export const MAX_SEARCH_QUERY_CHARACTERS = 500;
export const MAX_ELEMENT_REFERENCE_CHARACTERS = 128;

export interface PageLink {
	text: string;
	url: string;
	ref?: string;
	rel?: string;
}

export interface PageField {
	label: string;
	ref: string;
	type: string;
}

export interface PageSnapshot {
	title: string;
	url: string;
	fingerprint: string;
	text: string;
	links: PageLink[];
	fields: PageField[];
}

export type BrowserCommand =
	| { type: "browser.inspect" }
	| { type: "browser.click"; reference?: string; text?: string }
	| { type: "browser.type_text"; reference: string; text: string; submit: boolean }
	| { type: "browser.search"; query: string }
	| { type: "browser.extract_products"; pageNumber: number }
	| { type: "browser.next_page" }
	| { type: "browser.reload" }
	| { type: "browser.wait_for_change"; previousFingerprint: string; timeoutMs: number }
	| { type: "browser.google_sheets.write_products"; records: ProductRecord[] };

export type BrowserResult =
	| ({ type: "browser.snapshot" } & PageSnapshot)
	| { type: "browser.products"; records: ProductRecord[]; fingerprint: string }
	| { type: "browser.action"; changed: boolean; fingerprint: string }
	| { type: "browser.google_sheets"; url: string; rowsWritten: number };

export type ClientMessage =
	| { type: "chat.prompt"; text: string }
	| { type: "chat.abort" }
	| { type: "session.new" }
	| { type: "model.list" }
	| { type: "model.set"; provider: string; modelId: string }
	| { type: "browser.result"; commandId: string; result: BrowserResult }
	| { type: "browser.error"; commandId: string; code: AgentWErrorCode; message: string }
	| { type: "artifact.list" }
	| { type: "artifact.download"; artifactId: string }
	| { type: "artifact.downloaded"; artifactId: string }
	| {
			type: "skill.upload.begin";
			uploadId: string;
			name: string;
			format: "files" | "zip";
			totalBytes: number;
			overwrite: boolean;
	  }
	| { type: "skill.upload.chunk"; uploadId: string; index: number; data: string; relativePath?: string }
	| { type: "skill.upload.finish"; uploadId: string }
	| { type: "skill.list" }
	| { type: "skill.enable"; name: string }
	| { type: "skill.disable"; name: string }
	| { type: "skill.delete"; name: string };

export interface ModelSummary {
	provider: string;
	id: string;
	name: string;
}

export type HostMessage =
	| { type: "host.ready"; sessionId: string }
	| { type: "agent.event"; event: unknown }
	| { type: "model.list"; models: ModelSummary[]; selected?: Pick<ModelSummary, "provider" | "id"> }
	| { type: "browser.command"; commandId: string; command: BrowserCommand }
	| ({ type: "artifact.ready" } & ArtifactDescriptor)
	| { type: "artifact.chunk"; artifactId: string; index: number; data: string }
	| { type: "artifact.complete"; artifactId: string }
	| { type: "skill.installed"; name: string }
	| { type: "skill.list"; skills: InstalledSkill[] }
	| { type: "error"; code: AgentWErrorCode; message: string };

export interface AgentWEnvelope<TMessage extends ClientMessage | HostMessage = ClientMessage | HostMessage> {
	protocolVersion: typeof PROTOCOL_VERSION;
	requestId: string;
	taskId: string;
	message: TMessage;
}

const MESSAGE_TYPES = new Set<ClientMessage["type"] | HostMessage["type"]>([
	"chat.prompt",
	"chat.abort",
	"session.new",
	"model.list",
	"model.set",
	"browser.result",
	"browser.error",
	"artifact.list",
	"artifact.download",
	"artifact.downloaded",
	"skill.upload.begin",
	"skill.upload.chunk",
	"skill.upload.finish",
	"skill.list",
	"skill.enable",
	"skill.disable",
	"skill.delete",
	"host.ready",
	"agent.event",
	"browser.command",
	"artifact.ready",
	"artifact.chunk",
	"artifact.complete",
	"skill.installed",
	"error",
]);

export function parseEnvelope(input: unknown): AgentWEnvelope {
	if (!input || typeof input !== "object") {
		throw new AgentWError("INVALID_MESSAGE");
	}
	const value = input as Record<string, unknown>;
	if (value.protocolVersion !== PROTOCOL_VERSION) {
		throw new AgentWError("UNSUPPORTED_PROTOCOL");
	}
	if (
		typeof value.requestId !== "string" ||
		value.requestId.length === 0 ||
		typeof value.taskId !== "string" ||
		value.taskId.length === 0 ||
		!value.message ||
		typeof value.message !== "object"
	) {
		throw new AgentWError("INVALID_MESSAGE");
	}
	const messageType = (value.message as { type?: unknown }).type;
	if (typeof messageType !== "string" || !MESSAGE_TYPES.has(messageType as ClientMessage["type"])) {
		throw new AgentWError("INVALID_MESSAGE");
	}
	return value as unknown as AgentWEnvelope;
}

export function createEnvelope<TMessage extends ClientMessage | HostMessage>(
	requestId: string,
	taskId: string,
	message: TMessage,
): AgentWEnvelope<TMessage> {
	return { protocolVersion: PROTOCOL_VERSION, requestId, taskId, message };
}
