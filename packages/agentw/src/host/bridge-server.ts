import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Server, Socket } from "node:net";
import { createServer } from "node:net";
import { AgentWError } from "../shared/errors.ts";
import type {
	ArtifactDescriptor,
	DatasetAppendResult,
	DocumentArtifactInput,
	ProductRecord,
} from "../shared/product.ts";
import {
	MAX_CAPTURED_AT_CHARACTERS,
	MAX_DOCUMENT_CONTENT_CHARACTERS,
	MAX_DOCUMENT_FILE_NAME_CHARACTERS,
	MAX_DOCUMENT_TITLE_CHARACTERS,
	MAX_PRODUCT_BATCH_RECORDS,
	MAX_PRODUCT_DATE_CHARACTERS,
	MAX_PRODUCT_NAME_CHARACTERS,
	MAX_PRODUCT_PACKAGING_CHARACTERS,
	MAX_PRODUCT_PRICE_CHARACTERS,
	MAX_PRODUCT_RECORDS,
	MAX_PRODUCT_URL_CHARACTERS,
} from "../shared/product.ts";
import type { BrowserCommand, BrowserResult } from "../shared/protocol.ts";
import {
	MAX_BROWSER_INPUT_CHARACTERS,
	MAX_ELEMENT_REFERENCE_CHARACTERS,
	MAX_NATIVE_MESSAGE_BYTES,
	MAX_SEARCH_QUERY_CHARACTERS,
} from "../shared/protocol.ts";
import type { HostRouter } from "./host-router.ts";

interface BridgeServerOptions {
	appendProductDataset?: (
		taskId: string,
		records: ProductRecord[],
		signal: AbortSignal,
	) => Promise<DatasetAppendResult>;
	exportDocument?: (taskId: string, input: DocumentArtifactInput, signal: AbortSignal) => Promise<ArtifactDescriptor>;
	exportExcel?: (taskId: string, records: ProductRecord[], signal: AbortSignal) => Promise<ArtifactDescriptor>;
	finalizeProductDataset?: (taskId: string, signal: AbortSignal) => Promise<ArtifactDescriptor>;
	getActiveTaskId: () => string | undefined;
	token?: string;
	pipeName?: string;
}

interface PendingBridgeRequest {
	controller: AbortController;
	socket: Socket;
	taskId: string;
}

export class BridgeServer {
	readonly token: string;
	private readonly appendProductDataset:
		| ((taskId: string, records: ProductRecord[], signal: AbortSignal) => Promise<DatasetAppendResult>)
		| undefined;
	private readonly exportExcel:
		| ((taskId: string, records: ProductRecord[], signal: AbortSignal) => Promise<ArtifactDescriptor>)
		| undefined;
	private readonly exportDocument:
		| ((taskId: string, input: DocumentArtifactInput, signal: AbortSignal) => Promise<ArtifactDescriptor>)
		| undefined;
	private readonly getActiveTaskId: () => string | undefined;
	private readonly finalizeProductDataset:
		| ((taskId: string, signal: AbortSignal) => Promise<ArtifactDescriptor>)
		| undefined;
	private readonly pipeName: string;
	private readonly router: HostRouter;
	private activeSocket: Socket | undefined;
	private readonly pending = new Map<string, PendingBridgeRequest>();
	private server: Server | undefined;

	constructor(router: HostRouter, options: BridgeServerOptions) {
		this.router = router;
		this.appendProductDataset = options.appendProductDataset;
		this.exportDocument = options.exportDocument;
		this.exportExcel = options.exportExcel;
		this.finalizeProductDataset = options.finalizeProductDataset;
		this.getActiveTaskId = options.getActiveTaskId;
		this.token = options.token ?? randomBytes(32).toString("hex");
		this.pipeName = options.pipeName ?? String.raw`\\.\pipe\agentw-${randomUUID()}`;
	}

	async start(): Promise<string> {
		if (this.server) {
			throw new Error("BRIDGE_ALREADY_STARTED");
		}
		const server = createServer((socket) => this.accept(socket));
		this.server = server;
		await new Promise<void>((resolveStart, rejectStart) => {
			const handleError = (error: Error): void => {
				server.off("listening", handleListening);
				rejectStart(error);
			};
			const handleListening = (): void => {
				server.off("error", handleError);
				resolveStart();
			};
			server.once("error", handleError);
			server.once("listening", handleListening);
			server.listen(this.pipeName);
		});
		return this.pipeName;
	}

	async dispose(): Promise<void> {
		for (const request of this.pending.values()) {
			request.controller.abort();
		}
		this.pending.clear();
		this.activeSocket?.destroy();
		this.activeSocket = undefined;
		const server = this.server;
		this.server = undefined;
		if (!server?.listening) {
			return;
		}
		await new Promise<void>((resolveClose) => {
			server.close(() => resolveClose());
		});
	}

	abortTask(taskId: string): void {
		for (const request of this.pending.values()) {
			if (request.taskId === taskId) {
				request.controller.abort();
			}
		}
	}

	private accept(socket: Socket): void {
		if (this.activeSocket && !this.activeSocket.destroyed) {
			socket.destroy();
			return;
		}

		let authenticated = false;
		let buffered = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buffered += chunk;
			if (Buffer.byteLength(buffered, "utf8") > MAX_NATIVE_MESSAGE_BYTES) {
				socket.destroy();
				return;
			}
			let newline = buffered.indexOf("\n");
			while (newline !== -1) {
				const line = buffered.slice(0, newline).trimEnd();
				buffered = buffered.slice(newline + 1);
				if (line.length > 0) {
					if (!authenticated) {
						authenticated = this.authenticate(socket, line);
						if (!authenticated) {
							return;
						}
					} else {
						void this.handleRequest(socket, line);
					}
				}
				newline = buffered.indexOf("\n");
			}
		});
		socket.once("close", () => {
			for (const [id, request] of this.pending) {
				if (request.socket === socket) {
					request.controller.abort();
					this.pending.delete(id);
				}
			}
			if (this.activeSocket === socket) {
				this.activeSocket = undefined;
			}
		});
	}

	private authenticate(socket: Socket, line: string): boolean {
		const message = this.parseRecord(line);
		if (message.type !== "auth" || typeof message.token !== "string" || !this.tokensMatch(message.token)) {
			socket.destroy();
			return false;
		}
		if (this.activeSocket && this.activeSocket !== socket && !this.activeSocket.destroyed) {
			socket.destroy();
			return false;
		}
		this.activeSocket = socket;
		this.write(socket, { type: "auth.ready" });
		return true;
	}

	private async handleRequest(socket: Socket, line: string): Promise<void> {
		const message = this.parseRecord(line);
		if (
			(message.type === "browser.cancel" ||
				message.type === "artifact.cancel" ||
				message.type === "dataset.cancel") &&
			typeof message.id === "string"
		) {
			const pending = this.pending.get(message.id);
			if (pending?.socket === socket) {
				pending.controller.abort();
			}
			return;
		}
		if (message.type === "artifact.export" || message.type === "document.export") {
			await this.handleArtifactExport(socket, message);
			return;
		}
		if (message.type === "dataset.append" || message.type === "dataset.finalize") {
			await this.handleDatasetRequest(socket, message);
			return;
		}
		if (message.type !== "browser.request" || typeof message.id !== "string" || typeof message.taskId !== "string") {
			this.writeError(
				socket,
				typeof message.id === "string" ? message.id : "",
				new AgentWError("INVALID_MESSAGE"),
				"browser.response",
			);
			return;
		}

		const command = this.parseBrowserCommand(message.command);
		if (!command) {
			this.writeError(socket, message.id, new AgentWError("INVALID_MESSAGE"), "browser.response");
			return;
		}
		const activeTaskId = this.getActiveTaskId();
		if (!activeTaskId || (message.taskId !== "active" && message.taskId !== activeTaskId)) {
			this.writeError(
				socket,
				message.id,
				new AgentWError("TASK_ABORTED", "No matching active task"),
				"browser.response",
			);
			return;
		}
		if (this.pending.has(message.id)) {
			this.writeError(
				socket,
				message.id,
				new AgentWError("INVALID_MESSAGE", "Duplicate bridge request"),
				"browser.response",
			);
			return;
		}

		const controller = new AbortController();
		this.pending.set(message.id, { controller, socket, taskId: activeTaskId });
		try {
			const result = await this.router.requestBrowser(activeTaskId, command, controller.signal);
			this.writeBrowserResult(socket, message.id, result);
		} catch (error) {
			this.writeError(socket, message.id, error, "browser.response");
		} finally {
			this.pending.delete(message.id);
		}
	}

	private async handleArtifactExport(socket: Socket, message: Record<string, unknown>): Promise<void> {
		const id = typeof message.id === "string" ? message.id : "";
		if (typeof message.id !== "string" || typeof message.taskId !== "string") {
			this.writeError(socket, id, new AgentWError("INVALID_MESSAGE"), "artifact.response");
			return;
		}
		const records =
			message.type === "artifact.export"
				? this.parseProductRecords(message.records, MAX_PRODUCT_BATCH_RECORDS)
				: undefined;
		const documentInput = message.type === "document.export" ? this.parseDocumentInput(message.input) : undefined;
		if (
			(message.type === "artifact.export" && (!records || !this.exportExcel)) ||
			(message.type === "document.export" && (!documentInput || !this.exportDocument))
		) {
			this.writeError(socket, id, new AgentWError("INVALID_MESSAGE"), "artifact.response");
			return;
		}
		const activeTaskId = this.getActiveTaskId();
		if (!activeTaskId || (message.taskId !== "active" && message.taskId !== activeTaskId)) {
			this.writeError(socket, id, new AgentWError("TASK_ABORTED", "No matching active task"), "artifact.response");
			return;
		}
		if (this.pending.has(id)) {
			this.writeError(
				socket,
				id,
				new AgentWError("INVALID_MESSAGE", "Duplicate bridge request"),
				"artifact.response",
			);
			return;
		}
		const controller = new AbortController();
		this.pending.set(id, { controller, socket, taskId: activeTaskId });
		try {
			const artifact =
				message.type === "artifact.export" && records && this.exportExcel
					? await this.exportExcel(activeTaskId, records, controller.signal)
					: documentInput && this.exportDocument
						? await this.exportDocument(activeTaskId, documentInput, controller.signal)
						: undefined;
			if (!artifact) throw new AgentWError("INVALID_MESSAGE");
			if (controller.signal.aborted) {
				throw new AgentWError("TASK_ABORTED");
			}
			this.write(socket, { type: "artifact.response", id, success: true, artifact });
		} catch (error) {
			this.writeError(socket, id, error, "artifact.response");
		} finally {
			this.pending.delete(id);
		}
	}

	private async handleDatasetRequest(socket: Socket, message: Record<string, unknown>): Promise<void> {
		const id = typeof message.id === "string" ? message.id : "";
		if (typeof message.id !== "string" || typeof message.taskId !== "string") {
			this.writeError(socket, id, new AgentWError("INVALID_MESSAGE"), "dataset.response");
			return;
		}
		const activeTaskId = this.getActiveTaskId();
		if (!activeTaskId || (message.taskId !== "active" && message.taskId !== activeTaskId)) {
			this.writeError(socket, id, new AgentWError("TASK_ABORTED", "No matching active task"), "dataset.response");
			return;
		}
		if (this.pending.has(id)) {
			this.writeError(
				socket,
				id,
				new AgentWError("INVALID_MESSAGE", "Duplicate bridge request"),
				"dataset.response",
			);
			return;
		}
		const records = message.type === "dataset.append" ? this.parseProductRecords(message.records) : undefined;
		if (
			(message.type === "dataset.append" && (!records || !this.appendProductDataset)) ||
			(message.type === "dataset.finalize" && !this.finalizeProductDataset)
		) {
			this.writeError(socket, id, new AgentWError("INVALID_MESSAGE"), "dataset.response");
			return;
		}
		const controller = new AbortController();
		this.pending.set(id, { controller, socket, taskId: activeTaskId });
		try {
			if (message.type === "dataset.append" && records && this.appendProductDataset) {
				const result = await this.appendProductDataset(activeTaskId, records, controller.signal);
				this.write(socket, { type: "dataset.response", id, success: true, result });
			} else if (this.finalizeProductDataset) {
				const artifact = await this.finalizeProductDataset(activeTaskId, controller.signal);
				this.write(socket, { type: "dataset.response", id, success: true, artifact });
			}
		} catch (error) {
			this.writeError(socket, id, error, "dataset.response");
		} finally {
			this.pending.delete(id);
		}
	}

	private writeBrowserResult(socket: Socket, id: string, result: BrowserResult): void {
		this.write(socket, { type: "browser.response", id, success: true, result });
	}

	private writeError(
		socket: Socket,
		id: string,
		error: unknown,
		type: "artifact.response" | "browser.response" | "dataset.response",
	): void {
		const agentError = error instanceof AgentWError ? error : new AgentWError("HOST_DISCONNECTED");
		this.write(socket, {
			type,
			id,
			success: false,
			error: { code: agentError.code, message: agentError.message },
		});
	}

	private write(socket: Socket, message: unknown): void {
		if (socket.destroyed) {
			return;
		}
		const line = `${JSON.stringify(message)}\n`;
		if (Buffer.byteLength(line, "utf8") > MAX_NATIVE_MESSAGE_BYTES) {
			throw new AgentWError("MESSAGE_TOO_LARGE");
		}
		socket.write(line);
	}

	private parseRecord(line: string): Record<string, unknown> {
		try {
			const value: unknown = JSON.parse(line);
			return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
		} catch {
			return {};
		}
	}

	private parseBrowserCommand(value: unknown): BrowserCommand | undefined {
		if (!value || typeof value !== "object") {
			return undefined;
		}
		const command = value as Record<string, unknown>;
		switch (command.type) {
			case "browser.inspect":
				return { type: "browser.inspect" };
			case "browser.click": {
				const reference =
					typeof command.reference === "string" &&
					command.reference.length > 0 &&
					command.reference.length <= MAX_ELEMENT_REFERENCE_CHARACTERS
						? command.reference
						: undefined;
				const text =
					typeof command.text === "string" && command.text.length > 0 && command.text.length <= 200
						? command.text
						: undefined;
				return reference || text ? { type: "browser.click", reference, text } : undefined;
			}
			case "browser.type_text":
				return typeof command.reference === "string" &&
					command.reference.length > 0 &&
					command.reference.length <= MAX_ELEMENT_REFERENCE_CHARACTERS &&
					typeof command.text === "string" &&
					command.text.length <= MAX_BROWSER_INPUT_CHARACTERS &&
					typeof command.submit === "boolean"
					? {
							type: "browser.type_text",
							reference: command.reference,
							text: command.text,
							submit: command.submit,
						}
					: undefined;
			case "browser.search":
				return typeof command.query === "string" &&
					command.query.length > 0 &&
					command.query.length <= MAX_SEARCH_QUERY_CHARACTERS
					? { type: "browser.search", query: command.query }
					: undefined;
			case "browser.extract_products":
				return Number.isInteger(command.pageNumber) &&
					Number(command.pageNumber) >= 1 &&
					Number(command.pageNumber) <= 1_000
					? { type: "browser.extract_products", pageNumber: Number(command.pageNumber) }
					: undefined;
			case "browser.next_page":
				return { type: "browser.next_page" };
			case "browser.reload":
				return { type: "browser.reload" };
			case "browser.wait_for_change":
				return typeof command.previousFingerprint === "string" &&
					typeof command.timeoutMs === "number" &&
					command.timeoutMs > 0 &&
					command.timeoutMs <= 30_000
					? {
							type: "browser.wait_for_change",
							previousFingerprint: command.previousFingerprint,
							timeoutMs: command.timeoutMs,
						}
					: undefined;
			case "browser.google_sheets.write_products": {
				const records = this.parseProductRecords(command.records, MAX_PRODUCT_BATCH_RECORDS);
				return records ? { type: "browser.google_sheets.write_products", records } : undefined;
			}
			default:
				return undefined;
		}
	}

	private parseProductRecords(value: unknown, maximum = MAX_PRODUCT_RECORDS): ProductRecord[] | undefined {
		if (!Array.isArray(value) || value.length > maximum) {
			return undefined;
		}
		const records: ProductRecord[] = [];
		for (const item of value) {
			if (!item || typeof item !== "object") {
				return undefined;
			}
			const record = item as Record<string, unknown>;
			if (
				typeof record.name !== "string" ||
				(record.packaging !== undefined && typeof record.packaging !== "string") ||
				typeof record.price !== "string" ||
				typeof record.productionDate !== "string" ||
				typeof record.url !== "string" ||
				!Number.isInteger(record.sourcePage) ||
				Number(record.sourcePage) < 1 ||
				typeof record.capturedAt !== "string" ||
				record.name.length > MAX_PRODUCT_NAME_CHARACTERS ||
				(typeof record.packaging === "string" && record.packaging.length > MAX_PRODUCT_PACKAGING_CHARACTERS) ||
				record.price.length > MAX_PRODUCT_PRICE_CHARACTERS ||
				record.productionDate.length > MAX_PRODUCT_DATE_CHARACTERS ||
				record.url.length > MAX_PRODUCT_URL_CHARACTERS ||
				record.capturedAt.length > MAX_CAPTURED_AT_CHARACTERS
			) {
				return undefined;
			}
			records.push({
				name: record.name,
				packaging: typeof record.packaging === "string" ? record.packaging : undefined,
				price: record.price,
				productionDate: record.productionDate,
				url: record.url,
				sourcePage: Number(record.sourcePage),
				capturedAt: record.capturedAt,
			});
		}
		return records;
	}

	private parseDocumentInput(value: unknown): DocumentArtifactInput | undefined {
		if (!value || typeof value !== "object") return undefined;
		const input = value as Record<string, unknown>;
		if (
			typeof input.title !== "string" ||
			input.title.trim().length === 0 ||
			input.title.length > MAX_DOCUMENT_TITLE_CHARACTERS ||
			typeof input.content !== "string" ||
			input.content.trim().length === 0 ||
			input.content.length > MAX_DOCUMENT_CONTENT_CHARACTERS ||
			(input.fileName !== undefined &&
				(typeof input.fileName !== "string" ||
					input.fileName.trim().length === 0 ||
					input.fileName.length > MAX_DOCUMENT_FILE_NAME_CHARACTERS))
		) {
			return undefined;
		}
		return {
			title: input.title,
			content: input.content,
			fileName: typeof input.fileName === "string" ? input.fileName : undefined,
		};
	}

	private tokensMatch(candidate: string): boolean {
		const expected = Buffer.from(this.token, "utf8");
		const received = Buffer.from(candidate, "utf8");
		return expected.byteLength === received.byteLength && timingSafeEqual(expected, received);
	}
}
