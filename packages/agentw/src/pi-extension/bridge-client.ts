import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import { connect } from "node:net";
import type { AgentWErrorCode } from "../shared/errors.ts";
import { AgentWError } from "../shared/errors.ts";
import type {
	ArtifactDescriptor,
	DatasetAppendResult,
	DocumentArtifactInput,
	ProductRecord,
} from "../shared/product.ts";
import type { BrowserCommand, BrowserResult } from "../shared/protocol.ts";
import { MAX_NATIVE_MESSAGE_BYTES } from "../shared/protocol.ts";

export interface AgentWBridge {
	appendProductDataset(taskId: string, records: ProductRecord[], signal?: AbortSignal): Promise<DatasetAppendResult>;
	exportDocument(taskId: string, input: DocumentArtifactInput, signal?: AbortSignal): Promise<ArtifactDescriptor>;
	exportExcel(taskId: string, records: ProductRecord[], signal?: AbortSignal): Promise<ArtifactDescriptor>;
	finalizeProductDataset(taskId: string, signal?: AbortSignal): Promise<ArtifactDescriptor>;
	requestBrowser(taskId: string, command: BrowserCommand, signal?: AbortSignal): Promise<BrowserResult>;
}

interface BridgeClientOptions {
	pipeName?: string;
	token?: string;
	connectTimeoutMs?: number;
}

interface PendingRequestBase {
	reject: (error: Error) => void;
	signal?: AbortSignal;
	abortListener?: () => void;
}

interface PendingBrowserRequest extends PendingRequestBase {
	kind: "browser";
	resolve: (result: BrowserResult) => void;
}

interface PendingArtifactRequest extends PendingRequestBase {
	kind: "artifact";
	resolve: (result: ArtifactDescriptor) => void;
}

interface PendingDatasetAppendRequest extends PendingRequestBase {
	kind: "dataset.append";
	resolve: (result: DatasetAppendResult) => void;
}

interface PendingDatasetFinalizeRequest extends PendingRequestBase {
	kind: "dataset.finalize";
	resolve: (result: ArtifactDescriptor) => void;
}

type PendingRequest =
	| PendingArtifactRequest
	| PendingBrowserRequest
	| PendingDatasetAppendRequest
	| PendingDatasetFinalizeRequest;

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
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

export class BridgeClient implements AgentWBridge {
	private readonly connectTimeoutMs: number;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly pipeName: string | undefined;
	private readonly token: string | undefined;
	private buffered = "";
	private connectPromise: Promise<void> | undefined;
	private disposed = false;
	private socket: Socket | undefined;

	constructor(options: BridgeClientOptions = {}) {
		this.pipeName = options.pipeName ?? process.env.AGENTW_BRIDGE_PIPE;
		this.token = options.token ?? process.env.AGENTW_BRIDGE_TOKEN;
		this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
	}

	async requestBrowser(taskId: string, command: BrowserCommand, signal?: AbortSignal): Promise<BrowserResult> {
		if (signal?.aborted) {
			throw new AgentWError("TASK_ABORTED");
		}
		await this.ensureConnected();
		if (signal?.aborted) {
			throw new AgentWError("TASK_ABORTED");
		}

		const id = randomUUID();
		return new Promise<BrowserResult>((resolveRequest, rejectRequest) => {
			const pending: PendingBrowserRequest = {
				kind: "browser",
				resolve: resolveRequest,
				reject: rejectRequest,
				signal,
			};
			if (signal) {
				pending.abortListener = () => {
					const request = this.takePending(id);
					if (!request) {
						return;
					}
					this.write({ type: "browser.cancel", id });
					request.reject(new AgentWError("TASK_ABORTED"));
				};
				signal.addEventListener("abort", pending.abortListener, { once: true });
			}
			this.pending.set(id, pending);
			try {
				this.write({ type: "browser.request", id, taskId, command });
			} catch (error) {
				this.takePending(id)?.reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	async appendProductDataset(
		taskId: string,
		records: ProductRecord[],
		signal?: AbortSignal,
	): Promise<DatasetAppendResult> {
		if (signal?.aborted) throw new AgentWError("TASK_ABORTED");
		await this.ensureConnected();
		const id = randomUUID();
		return new Promise<DatasetAppendResult>((resolveRequest, rejectRequest) => {
			const pending: PendingDatasetAppendRequest = {
				kind: "dataset.append",
				resolve: resolveRequest,
				reject: rejectRequest,
				signal,
			};
			if (signal) {
				pending.abortListener = () => {
					const request = this.takePending(id);
					if (!request) return;
					this.write({ type: "dataset.cancel", id });
					request.reject(new AgentWError("TASK_ABORTED"));
				};
				signal.addEventListener("abort", pending.abortListener, { once: true });
			}
			this.pending.set(id, pending);
			try {
				this.write({ type: "dataset.append", id, taskId, records });
			} catch (error) {
				this.takePending(id)?.reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	async exportExcel(taskId: string, records: ProductRecord[], signal?: AbortSignal): Promise<ArtifactDescriptor> {
		if (signal?.aborted) {
			throw new AgentWError("TASK_ABORTED");
		}
		await this.ensureConnected();
		if (signal?.aborted) {
			throw new AgentWError("TASK_ABORTED");
		}

		const id = randomUUID();
		return new Promise<ArtifactDescriptor>((resolveRequest, rejectRequest) => {
			const pending: PendingArtifactRequest = {
				kind: "artifact",
				resolve: resolveRequest,
				reject: rejectRequest,
				signal,
			};
			if (signal) {
				pending.abortListener = () => {
					const request = this.takePending(id);
					if (!request) {
						return;
					}
					this.write({ type: "artifact.cancel", id });
					request.reject(new AgentWError("TASK_ABORTED"));
				};
				signal.addEventListener("abort", pending.abortListener, { once: true });
			}
			this.pending.set(id, pending);
			try {
				this.write({ type: "artifact.export", id, taskId, records });
			} catch (error) {
				this.takePending(id)?.reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	async exportDocument(
		taskId: string,
		input: DocumentArtifactInput,
		signal?: AbortSignal,
	): Promise<ArtifactDescriptor> {
		if (signal?.aborted) {
			throw new AgentWError("TASK_ABORTED");
		}
		await this.ensureConnected();
		if (signal?.aborted) {
			throw new AgentWError("TASK_ABORTED");
		}

		const id = randomUUID();
		return new Promise<ArtifactDescriptor>((resolveRequest, rejectRequest) => {
			const pending: PendingArtifactRequest = {
				kind: "artifact",
				resolve: resolveRequest,
				reject: rejectRequest,
				signal,
			};
			if (signal) {
				pending.abortListener = () => {
					const request = this.takePending(id);
					if (!request) {
						return;
					}
					this.write({ type: "artifact.cancel", id });
					request.reject(new AgentWError("TASK_ABORTED"));
				};
				signal.addEventListener("abort", pending.abortListener, { once: true });
			}
			this.pending.set(id, pending);
			try {
				this.write({ type: "document.export", id, taskId, input });
			} catch (error) {
				this.takePending(id)?.reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	async finalizeProductDataset(taskId: string, signal?: AbortSignal): Promise<ArtifactDescriptor> {
		if (signal?.aborted) throw new AgentWError("TASK_ABORTED");
		await this.ensureConnected();
		const id = randomUUID();
		return new Promise<ArtifactDescriptor>((resolveRequest, rejectRequest) => {
			const pending: PendingDatasetFinalizeRequest = {
				kind: "dataset.finalize",
				resolve: resolveRequest,
				reject: rejectRequest,
				signal,
			};
			if (signal) {
				pending.abortListener = () => {
					const request = this.takePending(id);
					if (!request) return;
					this.write({ type: "dataset.cancel", id });
					request.reject(new AgentWError("TASK_ABORTED"));
				};
				signal.addEventListener("abort", pending.abortListener, { once: true });
			}
			this.pending.set(id, pending);
			try {
				this.write({ type: "dataset.finalize", id, taskId });
			} catch (error) {
				this.takePending(id)?.reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.disconnect(new AgentWError("HOST_DISCONNECTED"));
	}

	private ensureConnected(): Promise<void> {
		if (this.disposed) {
			return Promise.reject(new AgentWError("HOST_DISCONNECTED"));
		}
		if (this.connectPromise) {
			return this.connectPromise;
		}
		const pipeName = this.pipeName;
		const token = this.token;
		if (!pipeName || !token) {
			return Promise.reject(new AgentWError("HOST_DISCONNECTED", "AgentW bridge environment is missing"));
		}

		this.connectPromise = new Promise<void>((resolveConnection, rejectConnection) => {
			const socket = connect(pipeName);
			this.socket = socket;
			socket.setEncoding("utf8");
			let authenticated = false;
			const timeout = setTimeout(() => {
				rejectConnection(new AgentWError("HOST_DISCONNECTED", "AgentW bridge authentication timed out"));
				socket.destroy();
			}, this.connectTimeoutMs);
			const rejectInitialConnection = (error: Error): void => {
				clearTimeout(timeout);
				rejectConnection(error);
			};
			socket.once("connect", () => {
				this.write({ type: "auth", token });
			});
			socket.on("data", (chunk: string) => {
				this.buffered += chunk;
				if (Buffer.byteLength(this.buffered, "utf8") > MAX_NATIVE_MESSAGE_BYTES) {
					this.disconnect(new AgentWError("MESSAGE_TOO_LARGE"));
					return;
				}
				let newline = this.buffered.indexOf("\n");
				while (newline !== -1) {
					const line = this.buffered.slice(0, newline).trimEnd();
					this.buffered = this.buffered.slice(newline + 1);
					if (line.length > 0) {
						const message = this.parseRecord(line);
						if (message.type === "auth.ready") {
							authenticated = true;
							clearTimeout(timeout);
							resolveConnection();
						} else {
							this.handleResponse(message);
						}
					}
					newline = this.buffered.indexOf("\n");
				}
			});
			socket.once("error", rejectInitialConnection);
			socket.once("close", () => {
				const error = new AgentWError("HOST_DISCONNECTED");
				if (!authenticated) {
					rejectInitialConnection(error);
				}
				this.disconnect(error);
			});
		});
		return this.connectPromise;
	}

	private handleResponse(message: Record<string, unknown>): void {
		if (
			message.type !== "browser.response" &&
			message.type !== "artifact.response" &&
			message.type !== "dataset.response"
		) {
			this.disconnect(new AgentWError("INVALID_MESSAGE", "Invalid AgentW bridge response"));
			return;
		}
		if (typeof message.id !== "string") {
			this.disconnect(new AgentWError("INVALID_MESSAGE", "Invalid AgentW bridge response"));
			return;
		}
		const pending = this.takePending(message.id);
		if (!pending) {
			return;
		}
		if (
			pending.kind === "browser" &&
			message.type === "browser.response" &&
			message.success === true &&
			this.isBrowserResult(message.result)
		) {
			pending.resolve(message.result);
			return;
		}
		if (
			pending.kind === "artifact" &&
			message.type === "artifact.response" &&
			message.success === true &&
			this.isArtifactDescriptor(message.artifact)
		) {
			pending.resolve(message.artifact);
			return;
		}
		if (
			pending.kind === "dataset.append" &&
			message.type === "dataset.response" &&
			message.success === true &&
			this.isDatasetAppendResult(message.result)
		) {
			pending.resolve(message.result);
			return;
		}
		if (
			pending.kind === "dataset.finalize" &&
			message.type === "dataset.response" &&
			message.success === true &&
			this.isArtifactDescriptor(message.artifact)
		) {
			pending.resolve(message.artifact);
			return;
		}
		const error = this.asRecord(message.error);
		const code =
			typeof error.code === "string" && ERROR_CODES.has(error.code as AgentWErrorCode)
				? (error.code as AgentWErrorCode)
				: "HOST_DISCONNECTED";
		pending.reject(new AgentWError(code, typeof error.message === "string" ? error.message : code));
	}

	private disconnect(error: Error): void {
		const socket = this.socket;
		this.socket = undefined;
		this.connectPromise = undefined;
		this.buffered = "";
		if (socket && !socket.destroyed) {
			socket.destroy();
		}
		for (const id of [...this.pending.keys()]) {
			this.takePending(id)?.reject(error);
		}
	}

	private takePending(id: string): PendingRequest | undefined {
		const pending = this.pending.get(id);
		if (!pending) {
			return undefined;
		}
		this.pending.delete(id);
		if (pending.signal && pending.abortListener) {
			pending.signal.removeEventListener("abort", pending.abortListener);
		}
		return pending;
	}

	private write(message: unknown): void {
		const socket = this.socket;
		if (!socket || socket.destroyed) {
			throw new AgentWError("HOST_DISCONNECTED");
		}
		const line = `${JSON.stringify(message)}\n`;
		if (Buffer.byteLength(line, "utf8") > MAX_NATIVE_MESSAGE_BYTES) {
			throw new AgentWError("MESSAGE_TOO_LARGE");
		}
		socket.write(line);
	}

	private parseRecord(line: string): Record<string, unknown> {
		try {
			return this.asRecord(JSON.parse(line));
		} catch {
			return {};
		}
	}

	private asRecord(value: unknown): Record<string, unknown> {
		return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	}

	private isBrowserResult(value: unknown): value is BrowserResult {
		if (!value || typeof value !== "object") {
			return false;
		}
		const type = (value as { type?: unknown }).type;
		return (
			type === "browser.snapshot" ||
			type === "browser.products" ||
			type === "browser.action" ||
			type === "browser.google_sheets"
		);
	}

	private isArtifactDescriptor(value: unknown): value is ArtifactDescriptor {
		if (!value || typeof value !== "object") {
			return false;
		}
		const artifact = value as Record<string, unknown>;
		return (
			typeof artifact.id === "string" &&
			typeof artifact.name === "string" &&
			typeof artifact.size === "number" &&
			typeof artifact.sha256 === "string"
		);
	}

	private isDatasetAppendResult(value: unknown): value is DatasetAppendResult {
		if (!value || typeof value !== "object") return false;
		const result = value as Record<string, unknown>;
		return (
			typeof result.appended === "number" &&
			Number.isSafeInteger(result.appended) &&
			typeof result.total === "number" &&
			Number.isSafeInteger(result.total)
		);
	}
}
