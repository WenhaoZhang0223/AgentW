import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type { ModelSummary } from "../shared/protocol.ts";

interface PiChildProcess {
	stdin: Writable;
	stdout: Readable;
	stderr: Readable;
	once(event: "error", listener: (error: Error) => void): this;
	once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	kill(signal?: NodeJS.Signals | number): boolean;
}

interface PiSpawnOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
}

type SpawnPiProcess = (command: string, args: string[], options: PiSpawnOptions) => PiChildProcess;

export interface PiProcessOptions {
	onEvent: (event: unknown) => void;
	onDiagnostic?: (message: string) => void;
	spawnProcess?: SpawnPiProcess;
	responseTimeoutMs?: number;
	taskTimeoutMs?: number;
}

export interface PiStartOptions {
	bridgePipe: string;
	bridgeToken: string;
	extensionPath?: string;
	sessionDir?: string;
	agentDir?: string;
	skillDir?: string;
	cwd?: string;
	executable?: string;
}

interface PendingResponse {
	resolve: (response: RpcResponse) => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
}

interface RpcResponse {
	type: "response";
	id: string;
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
}

type RpcCommandBody =
	| { type: "prompt"; message: string }
	| { type: "abort" }
	| { type: "new_session" }
	| { type: "get_available_models" }
	| { type: "set_model"; provider: string; modelId: string };

const DEFAULT_RESPONSE_TIMEOUT_MS = 30_000;
const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_JSONL_BUFFER_BYTES = 512 * 1024;
const require = createRequire(import.meta.url);

export interface PiLaunchOptions {
	configured?: string;
	execPath: string;
	isBun: boolean;
	resolveRpcEntry: () => string;
	siblingExists?: boolean;
}

export function resolvePiLaunch(options: PiLaunchOptions): { command: string; prefixArgs: string[] } {
	if (options.configured) {
		return { command: resolve(options.configured), prefixArgs: [] };
	}
	const siblingExecutable = join(dirname(options.execPath), "pi.exe");
	if (options.siblingExists ?? existsSync(siblingExecutable)) {
		return { command: siblingExecutable, prefixArgs: [] };
	}
	if (options.isBun) {
		throw new Error("AGENTW_PI_EXECUTABLE_NOT_FOUND");
	}
	return {
		command: options.execPath,
		prefixArgs: [options.resolveRpcEntry()],
	};
}

function spawnPiProcess(command: string, args: string[], options: PiSpawnOptions): PiChildProcess {
	return spawn(command, args, {
		cwd: options.cwd,
		env: options.env,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
}

export class PiProcess {
	private readonly decoder = new StringDecoder("utf8");
	private readonly onDiagnostic: (message: string) => void;
	private readonly onEvent: (event: unknown) => void;
	private readonly pending = new Map<string, PendingResponse>();
	private readonly responseTimeoutMs: number;
	private readonly spawnProcess: SpawnPiProcess;
	private readonly taskTimeoutMs: number;
	private child: PiChildProcess | undefined;
	private disposed = false;
	private lineBuffer = "";
	private requestSequence = 0;
	private taskTimeout: ReturnType<typeof setTimeout> | undefined;

	constructor(options: PiProcessOptions) {
		this.onEvent = options.onEvent;
		this.onDiagnostic = options.onDiagnostic ?? (() => undefined);
		this.spawnProcess = options.spawnProcess ?? spawnPiProcess;
		this.responseTimeoutMs = options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
		this.taskTimeoutMs = options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
	}

	async start(options: PiStartOptions): Promise<void> {
		if (this.child) {
			throw new Error("PI_PROCESS_ALREADY_STARTED");
		}
		this.disposed = false;

		const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
		const sessionDir = resolve(options.sessionDir ?? join(localAppData, "AgentW", "sessions"));
		const agentDir = resolve(options.agentDir ?? join(localAppData, "AgentW", "agent"));
		const skillDir = resolve(options.skillDir ?? join(localAppData, "AgentW", "skills"));
		const extensionPath = resolve(
			options.extensionPath ?? fileURLToPath(new URL("../pi-extension/index.js", import.meta.url)),
		);
		const cwd = resolve(options.cwd ?? process.cwd());
		await Promise.all([
			mkdir(sessionDir, { recursive: true }),
			mkdir(agentDir, { recursive: true }),
			mkdir(skillDir, { recursive: true }),
		]);

		const launch = this.resolveLaunch(options.executable);
		const args = [
			...launch.prefixArgs,
			"--mode",
			"rpc",
			"--no-builtin-tools",
			"--no-extensions",
			"--extension",
			extensionPath,
			"--skill",
			skillDir,
			"--session-dir",
			sessionDir,
		];
		const env: NodeJS.ProcessEnv = {
			...process.env,
			AGENTW_BRIDGE_PIPE: options.bridgePipe,
			AGENTW_BRIDGE_TOKEN: options.bridgeToken,
			AGENTW_TASK_ID: "active",
			PI_CODING_AGENT_DIR: agentDir,
			PI_CODING_AGENT_SESSION_DIR: sessionDir,
		};
		const child = this.spawnProcess(launch.command, args, { cwd, env });
		this.child = child;
		child.stdout.on("data", this.handleStdoutData);
		child.stderr.on("data", this.handleStderrData);
		child.once("error", this.handleProcessError);
		child.once("exit", this.handleProcessExit);
	}

	async prompt(message: string): Promise<void> {
		this.startTaskTimeout();
		try {
			await this.send({ type: "prompt", message });
		} catch (error) {
			this.clearTaskTimeout();
			throw error;
		}
	}

	async abort(): Promise<void> {
		this.clearTaskTimeout();
		await this.send({ type: "abort" });
	}

	async newSession(): Promise<{ cancelled: boolean }> {
		this.clearTaskTimeout();
		const response = await this.send({ type: "new_session" });
		const data = this.asRecord(response.data);
		return { cancelled: data.cancelled === true };
	}

	async listModels(): Promise<ModelSummary[]> {
		const response = await this.send({ type: "get_available_models" });
		const data = this.asRecord(response.data);
		if (!Array.isArray(data.models)) {
			return [];
		}
		return data.models.flatMap((model) => {
			const value = this.asRecord(model);
			if (typeof value.provider !== "string" || typeof value.id !== "string") {
				return [];
			}
			return [
				{ provider: value.provider, id: value.id, name: typeof value.name === "string" ? value.name : value.id },
			];
		});
	}

	async setModel(provider: string, modelId: string): Promise<ModelSummary> {
		const response = await this.send({ type: "set_model", provider, modelId });
		const data = this.asRecord(response.data);
		return {
			provider: typeof data.provider === "string" ? data.provider : provider,
			id: typeof data.id === "string" ? data.id : modelId,
			name: typeof data.name === "string" ? data.name : modelId,
		};
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.clearTaskTimeout();
		this.rejectPending(new Error("PI_PROCESS_DISCONNECTED"));
		const child = this.child;
		this.child = undefined;
		if (!child) {
			return;
		}
		child.stdout.off("data", this.handleStdoutData);
		child.stderr.off("data", this.handleStderrData);
		child.kill("SIGTERM");
	}

	private readonly handleStdoutData = (chunk: Buffer | string): void => {
		this.lineBuffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
		if (Buffer.byteLength(this.lineBuffer, "utf8") > MAX_JSONL_BUFFER_BYTES) {
			this.handleProcessFailure(new Error("PI_RPC_MESSAGE_TOO_LARGE"));
			return;
		}

		let newlineIndex = this.lineBuffer.indexOf("\n");
		while (newlineIndex !== -1) {
			const line = this.lineBuffer.slice(0, newlineIndex).trimEnd();
			this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
			if (line.length > 0) {
				this.handleLine(line);
			}
			newlineIndex = this.lineBuffer.indexOf("\n");
		}
	};

	private readonly handleStderrData = (chunk: Buffer | string): void => {
		this.onDiagnostic(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
	};

	private readonly handleProcessError = (error: Error): void => {
		this.handleProcessFailure(error);
	};

	private readonly handleProcessExit = (code: number | null, signal: NodeJS.Signals | null): void => {
		if (!this.disposed) {
			this.handleProcessFailure(new Error(`Pi exited (code=${code}, signal=${signal})`));
		}
	};

	private handleLine(line: string): void {
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			this.handleProcessFailure(new Error("PI_RPC_INVALID_JSON"));
			return;
		}

		const record = this.asRecord(value);
		if (record.type === "response") {
			this.handleResponse(record);
			return;
		}
		if (record.type === "agent_settled") {
			this.clearTaskTimeout();
		}
		this.onEvent(value);
	}

	private handleResponse(record: Record<string, unknown>): void {
		if (typeof record.id !== "string") {
			this.onDiagnostic("Ignored Pi RPC response without id");
			return;
		}
		const pending = this.pending.get(record.id);
		if (!pending) {
			return;
		}
		this.pending.delete(record.id);
		clearTimeout(pending.timeout);
		if (record.success !== true) {
			pending.reject(new Error(typeof record.error === "string" ? record.error : "PI_RPC_COMMAND_FAILED"));
			return;
		}
		pending.resolve({
			type: "response",
			id: record.id,
			command: typeof record.command === "string" ? record.command : "unknown",
			success: true,
			data: record.data,
		});
	}

	private send(command: RpcCommandBody): Promise<RpcResponse> {
		const child = this.child;
		if (!child || this.disposed) {
			return Promise.reject(new Error("PI_PROCESS_NOT_STARTED"));
		}
		const id = `agentw_${++this.requestSequence}`;
		return new Promise<RpcResponse>((resolveResponse, rejectResponse) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				rejectResponse(new Error(`PI_RPC_TIMEOUT:${command.type}`));
			}, this.responseTimeoutMs);
			this.pending.set(id, { resolve: resolveResponse, reject: rejectResponse, timeout });
			try {
				child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
			} catch (error) {
				this.pending.delete(id);
				clearTimeout(timeout);
				rejectResponse(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private startTaskTimeout(): void {
		this.clearTaskTimeout();
		this.taskTimeout = setTimeout(() => {
			this.taskTimeout = undefined;
			this.onEvent({ type: "agentw_timeout" });
			void this.send({ type: "abort" }).catch((error: unknown) => {
				this.onDiagnostic(error instanceof Error ? error.message : String(error));
			});
		}, this.taskTimeoutMs);
	}

	private clearTaskTimeout(): void {
		if (this.taskTimeout) {
			clearTimeout(this.taskTimeout);
			this.taskTimeout = undefined;
		}
	}

	private handleProcessFailure(error: Error): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.clearTaskTimeout();
		this.rejectPending(error);
		this.onDiagnostic(error.message);
		this.onEvent({ type: "agentw_failure", message: error.message });
		const child = this.child;
		this.child = undefined;
		if (child) {
			child.stdout.off("data", this.handleStdoutData);
			child.stderr.off("data", this.handleStderrData);
			child.kill("SIGTERM");
		}
	}

	private rejectPending(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
		this.pending.clear();
	}

	private resolveLaunch(executable: string | undefined): { command: string; prefixArgs: string[] } {
		const versions = process.versions as NodeJS.ProcessVersions & { bun?: string };
		return resolvePiLaunch({
			configured: executable ?? process.env.AGENTW_PI_EXECUTABLE,
			execPath: process.execPath,
			isBun: versions.bun !== undefined,
			resolveRpcEntry: () => require.resolve("@earendil-works/pi-coding-agent/rpc-entry"),
		});
	}

	private asRecord(value: unknown): Record<string, unknown> {
		return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	}
}
