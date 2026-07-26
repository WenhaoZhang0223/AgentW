import { randomUUID } from "node:crypto";
import type { AgentWErrorCode } from "../shared/errors.ts";
import { AgentWError } from "../shared/errors.ts";
import type { BrowserCommand, BrowserResult, HostMessage } from "../shared/protocol.ts";

type BrowserCommandMessage = Extract<HostMessage, { type: "browser.command" }>;
type SendBrowserCommand = (taskId: string, message: BrowserCommandMessage) => void | Promise<void>;

interface HostRouterOptions {
	pageTimeoutMs?: number;
}

interface PendingBrowserRequest {
	taskId: string;
	resolve: (result: BrowserResult) => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
	signal?: AbortSignal;
	abortListener?: () => void;
}

const DEFAULT_PAGE_TIMEOUT_MS = 30_000;

export class HostRouter {
	private readonly pending = new Map<string, PendingBrowserRequest>();
	private readonly pageTimeoutMs: number;
	private readonly sendBrowserCommand: SendBrowserCommand;

	constructor(sendBrowserCommand: SendBrowserCommand, options: HostRouterOptions = {}) {
		this.sendBrowserCommand = sendBrowserCommand;
		this.pageTimeoutMs = options.pageTimeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS;
	}

	requestBrowser(taskId: string, command: BrowserCommand, signal?: AbortSignal): Promise<BrowserResult> {
		if (signal?.aborted) {
			return Promise.reject(new AgentWError("TASK_ABORTED"));
		}

		const commandId = randomUUID();
		return new Promise<BrowserResult>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.rejectRequest(commandId, new AgentWError("AGENT_TIMEOUT", "Browser request timed out"));
			}, this.pageTimeoutMs);
			const pending: PendingBrowserRequest = { taskId, resolve, reject, timeout, signal };
			if (signal) {
				pending.abortListener = () => {
					this.rejectRequest(commandId, new AgentWError("TASK_ABORTED"));
				};
				signal.addEventListener("abort", pending.abortListener, { once: true });
			}
			this.pending.set(commandId, pending);

			try {
				const sending = this.sendBrowserCommand(taskId, { type: "browser.command", commandId, command });
				Promise.resolve(sending).catch(() => {
					this.rejectRequest(commandId, new AgentWError("HOST_DISCONNECTED"));
				});
			} catch {
				this.rejectRequest(commandId, new AgentWError("HOST_DISCONNECTED"));
			}
		});
	}

	handleBrowserResult(commandId: string, result: BrowserResult): boolean {
		const pending = this.takeRequest(commandId);
		if (!pending) {
			return false;
		}
		pending.resolve(result);
		return true;
	}

	handleBrowserError(commandId: string, code: AgentWErrorCode, message: string): boolean {
		const pending = this.takeRequest(commandId);
		if (!pending) {
			return false;
		}
		pending.reject(new AgentWError(code, message));
		return true;
	}

	abortTask(taskId: string): number {
		const commandIds = [...this.pending.entries()]
			.filter(([, pending]) => pending.taskId === taskId)
			.map(([commandId]) => commandId);
		for (const commandId of commandIds) {
			this.rejectRequest(commandId, new AgentWError("TASK_ABORTED"));
		}
		return commandIds.length;
	}

	dispose(): void {
		for (const commandId of [...this.pending.keys()]) {
			this.rejectRequest(commandId, new AgentWError("HOST_DISCONNECTED"));
		}
	}

	private rejectRequest(commandId: string, error: Error): void {
		const pending = this.takeRequest(commandId);
		pending?.reject(error);
	}

	private takeRequest(commandId: string): PendingBrowserRequest | undefined {
		const pending = this.pending.get(commandId);
		if (!pending) {
			return undefined;
		}
		this.pending.delete(commandId);
		clearTimeout(pending.timeout);
		if (pending.signal && pending.abortListener) {
			pending.signal.removeEventListener("abort", pending.abortListener);
		}
		return pending;
	}
}
