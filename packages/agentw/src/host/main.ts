import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentWError } from "../shared/errors.ts";
import type { AgentWEnvelope, ClientMessage, HostMessage, ModelSummary } from "../shared/protocol.ts";
import { createEnvelope } from "../shared/protocol.ts";
import { ArtifactStore } from "./artifact-store.ts";
import { BridgeServer } from "./bridge-server.ts";
import { HostRouter } from "./host-router.ts";
import { encodeNativeMessage, NativeMessageReader } from "./native-framing.ts";
import { PiProcess } from "./pi-process.ts";
import { redactDiagnostic } from "./redact.ts";
import { SkillInstaller } from "./skill-installer.ts";
import { SkillUploadManager } from "./skill-upload.ts";
import { TaskWorkspaceManager } from "./task-workspace.ts";

interface ActiveTask {
	taskId: string;
	requestId: string;
}

interface HostRuntimePaths {
	execPath: string;
	isBun: boolean;
	moduleUrl: string;
}

interface HostEntryRuntime extends HostRuntimePaths {
	argv0: string | undefined;
	argv1: string | undefined;
}

export function resolveHostExtensionPath(runtime: HostRuntimePaths): string {
	return runtime.isBun
		? resolve(dirname(runtime.execPath), "pi-extension", "index.js")
		: resolve(dirname(fileURLToPath(runtime.moduleUrl)), "../pi-extension/index.js");
}

export function shouldRunNativeHost(runtime: HostEntryRuntime): boolean {
	if (runtime.isBun) {
		return (
			runtime.argv0 === "bun" ||
			(runtime.argv1 !== undefined && resolve(runtime.argv1) === resolve(runtime.execPath)) ||
			runtime.moduleUrl.includes("/$bunfs/root/") ||
			runtime.moduleUrl.toLowerCase().includes("/%7ebun/root/")
		);
	}
	return runtime.argv1 !== undefined && resolve(runtime.argv1) === fileURLToPath(runtime.moduleUrl);
}

function diagnostic(value: unknown): void {
	const redacted = redactDiagnostic(value);
	process.stderr.write(`${typeof redacted === "string" ? redacted : JSON.stringify(redacted)}\n`);
}

export async function runNativeHost(): Promise<void> {
	const versions = process.versions as NodeJS.ProcessVersions & { bun?: string };
	const runtimePaths: HostRuntimePaths = {
		execPath: process.execPath,
		isBun: versions.bun !== undefined,
		moduleUrl: import.meta.url,
	};
	const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
	const agentWRoot = join(localAppData, "AgentW");
	const workspaces = new TaskWorkspaceManager(join(agentWRoot, "tasks"));
	await workspaces.cleanupExpired(new Date());
	const artifactStore = new ArtifactStore(workspaces);
	const skillRoot = join(agentWRoot, "skills");
	const skillInstaller = new SkillInstaller({
		enabledRoot: skillRoot,
		disabledRoot: join(agentWRoot, "skills-disabled"),
		validationRoot: join(agentWRoot, "skill-validation"),
	});
	await skillInstaller.cleanupValidation();
	const skillUploads = new SkillUploadManager(skillInstaller);

	let activeTask: ActiveTask | undefined;
	let closing: Promise<void> | undefined;
	let piProcess: PiProcess | undefined;
	let bridgeServer: BridgeServer | undefined;

	const writeHostMessage = (requestId: string, taskId: string, message: HostMessage): void => {
		process.stdout.write(encodeNativeMessage(createEnvelope(requestId, taskId, message)));
	};
	const router = new HostRouter((taskId, message) => {
		writeHostMessage(randomUUID(), taskId, message);
	});

	const cleanupActiveTask = async (taskId?: string, preserveArtifacts = false): Promise<void> => {
		const target = taskId ?? activeTask?.taskId;
		if (!target) {
			return;
		}
		router.abortTask(target);
		bridgeServer?.abortTask(target);
		if (!preserveArtifacts || !artifactStore.hasPendingForTask(target)) {
			await artifactStore.discardTask(target);
			await workspaces.cleanup(target);
		}
		if (activeTask?.taskId === target) {
			activeTask = undefined;
		}
	};

	const shutdown = (): Promise<void> => {
		if (closing) {
			return closing;
		}
		closing = (async () => {
			router.dispose();
			piProcess?.dispose();
			await bridgeServer?.dispose();
			skillUploads.clear();
			await skillInstaller.cleanupValidation();
			await workspaces.cleanupAll();
		})();
		return closing;
	};

	const handleAgentEvent = (event: unknown): void => {
		const task = activeTask;
		if (!task) {
			return;
		}
		const eventType =
			event && typeof event === "object" && typeof (event as { type?: unknown }).type === "string"
				? (event as { type: string }).type
				: "";
		if (eventType === "agentw_timeout") {
			writeHostMessage(task.requestId, task.taskId, {
				type: "error",
				code: "AGENT_TIMEOUT",
				message: "Agent task timed out",
			});
			void cleanupActiveTask(task.taskId).catch(diagnostic);
			return;
		}
		if (eventType === "agentw_failure") {
			writeHostMessage(task.requestId, task.taskId, {
				type: "error",
				code: "HOST_DISCONNECTED",
				message: "Local Pi process stopped",
			});
			void cleanupActiveTask(task.taskId).catch(diagnostic);
			return;
		}

		writeHostMessage(task.requestId, task.taskId, { type: "agent.event", event });
		if (eventType === "agent_settled") {
			void cleanupActiveTask(task.taskId, true).catch(diagnostic);
		}
	};

	try {
		bridgeServer = new BridgeServer(router, {
			getActiveTaskId: () => activeTask?.taskId,
			appendProductDataset: async (taskId, records, signal) => {
				const task = activeTask;
				if (!task || task.taskId !== taskId) {
					throw new AgentWError("TASK_ABORTED");
				}
				return artifactStore.appendProductDataset(taskId, records, signal);
			},
			finalizeProductDataset: async (taskId, signal) => {
				const task = activeTask;
				if (!task || task.taskId !== taskId) {
					throw new AgentWError("TASK_ABORTED");
				}
				const artifact = await artifactStore.finalizeProductDataset(taskId, signal, false);
				if (signal.aborted) {
					await artifactStore.acknowledgeDownload(artifact.id);
					throw new AgentWError("TASK_ABORTED");
				}
				return artifact;
			},
			exportExcel: async (taskId, records, signal) => {
				const task = activeTask;
				if (!task || task.taskId !== taskId) {
					throw new AgentWError("TASK_ABORTED");
				}
				const artifact = await artifactStore.createExcel(taskId, records, signal);
				if (signal.aborted) {
					await artifactStore.acknowledgeDownload(artifact.id);
					throw new AgentWError("TASK_ABORTED");
				}
				writeHostMessage(task.requestId, taskId, { type: "artifact.ready", ...artifact });
				return artifact;
			},
			exportDocument: async (taskId, input, signal) => {
				const task = activeTask;
				if (!task || task.taskId !== taskId) {
					throw new AgentWError("TASK_ABORTED");
				}
				const artifact = await artifactStore.createDocument(taskId, input, signal);
				if (signal.aborted) {
					await artifactStore.acknowledgeDownload(artifact.id);
					throw new AgentWError("TASK_ABORTED");
				}
				writeHostMessage(task.requestId, taskId, { type: "artifact.ready", ...artifact });
				return artifact;
			},
		});
		const bridgePipe = await bridgeServer.start();
		piProcess = new PiProcess({
			onEvent: handleAgentEvent,
			onDiagnostic: (message) => diagnostic({ source: "pi", message }),
		});
		await piProcess.start({
			bridgePipe,
			bridgeToken: bridgeServer.token,
			extensionPath: resolveHostExtensionPath(runtimePaths),
			sessionDir: join(agentWRoot, "sessions"),
			agentDir: process.env.AGENTW_PI_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
			skillDir: skillRoot,
		});
	} catch (error) {
		await shutdown();
		throw error;
	}

	const sendError = (envelope: AgentWEnvelope, error: unknown): void => {
		const agentError = error instanceof AgentWError ? error : new AgentWError("HOST_DISCONNECTED");
		writeHostMessage(envelope.requestId, envelope.taskId, {
			type: "error",
			code: agentError.code,
			message: error instanceof Error ? error.message : agentError.message,
		});
	};

	const sendModels = async (envelope: AgentWEnvelope, selected?: ModelSummary): Promise<void> => {
		const models = await piProcess?.listModels();
		writeHostMessage(envelope.requestId, envelope.taskId, {
			type: "model.list",
			models: models ?? [],
			selected,
		});
	};

	const handleMessage = async (envelope: AgentWEnvelope): Promise<void> => {
		const message = envelope.message as ClientMessage;
		switch (message.type) {
			case "chat.prompt":
				if (activeTask) {
					throw new AgentWError("PAGE_REQUIRES_USER_ACTION", "Wait for the current task or stop it first");
				}
				activeTask = { taskId: envelope.taskId, requestId: envelope.requestId };
				await workspaces.create(envelope.taskId);
				try {
					await piProcess?.prompt(message.text);
				} catch (error) {
					await cleanupActiveTask(envelope.taskId);
					throw error;
				}
				return;
			case "chat.abort":
				router.abortTask(envelope.taskId);
				try {
					await piProcess?.abort();
				} finally {
					await cleanupActiveTask(envelope.taskId);
				}
				return;
			case "session.new":
				if (activeTask) {
					await cleanupActiveTask(activeTask.taskId);
				}
				await artifactStore.discardAll();
				await workspaces.cleanupAll();
				await piProcess?.newSession();
				writeHostMessage(envelope.requestId, envelope.taskId, {
					type: "host.ready",
					sessionId: randomUUID(),
				});
				return;
			case "model.list":
				await sendModels(envelope);
				return;
			case "model.set": {
				const selected = await piProcess?.setModel(message.provider, message.modelId);
				await sendModels(envelope, selected);
				return;
			}
			case "browser.result":
				if (!router.handleBrowserResult(message.commandId, message.result)) {
					throw new AgentWError("INVALID_MESSAGE", "Unknown browser command");
				}
				return;
			case "browser.error":
				if (!router.handleBrowserError(message.commandId, message.code, message.message)) {
					throw new AgentWError("INVALID_MESSAGE", "Unknown browser command");
				}
				return;
			case "artifact.list":
				for (const artifact of artifactStore.listPending()) {
					writeHostMessage(envelope.requestId, envelope.taskId, { type: "artifact.ready", ...artifact });
				}
				return;
			case "artifact.download":
				for await (const chunk of artifactStore.chunks(message.artifactId)) {
					writeHostMessage(envelope.requestId, envelope.taskId, {
						type: "artifact.chunk",
						artifactId: message.artifactId,
						index: chunk.index,
						data: chunk.data,
					});
				}
				writeHostMessage(envelope.requestId, envelope.taskId, {
					type: "artifact.complete",
					artifactId: message.artifactId,
				});
				return;
			case "artifact.downloaded": {
				const artifactTaskId = await artifactStore.acknowledgeDownload(message.artifactId);
				if (
					artifactTaskId &&
					activeTask?.taskId !== artifactTaskId &&
					!artifactStore.hasPendingForTask(artifactTaskId)
				) {
					await workspaces.cleanup(artifactTaskId);
				}
				return;
			}
			case "skill.upload.begin":
				if ((message.format !== "zip" && message.format !== "files") || typeof message.overwrite !== "boolean") {
					throw new AgentWError("INVALID_MESSAGE");
				}
				skillUploads.begin({
					uploadId: message.uploadId,
					format: message.format,
					totalBytes: message.totalBytes,
					overwrite: message.overwrite,
				});
				return;
			case "skill.upload.chunk":
				skillUploads.addChunk({
					uploadId: message.uploadId,
					index: message.index,
					data: message.data,
					relativePath: message.relativePath,
				});
				return;
			case "skill.upload.finish": {
				const installed = await skillUploads.finish(message.uploadId);
				writeHostMessage(envelope.requestId, envelope.taskId, { type: "skill.installed", name: installed.name });
				writeHostMessage(envelope.requestId, envelope.taskId, {
					type: "skill.list",
					skills: await skillInstaller.list(),
				});
				return;
			}
			case "skill.list":
				writeHostMessage(envelope.requestId, envelope.taskId, {
					type: "skill.list",
					skills: await skillInstaller.list(),
				});
				return;
			case "skill.enable":
				await skillInstaller.enable(message.name);
				writeHostMessage(envelope.requestId, envelope.taskId, {
					type: "skill.list",
					skills: await skillInstaller.list(),
				});
				return;
			case "skill.disable":
				await skillInstaller.disable(message.name);
				writeHostMessage(envelope.requestId, envelope.taskId, {
					type: "skill.list",
					skills: await skillInstaller.list(),
				});
				return;
			case "skill.delete":
				await skillInstaller.delete(message.name);
				writeHostMessage(envelope.requestId, envelope.taskId, {
					type: "skill.list",
					skills: await skillInstaller.list(),
				});
				return;
			default:
				throw new AgentWError("INVALID_MESSAGE", "Unsupported message");
		}
	};

	const reader = new NativeMessageReader();
	let handling = Promise.resolve();
	process.stdin.on("data", (chunk: Buffer) => {
		try {
			for (const envelope of reader.push(chunk)) {
				handling = handling
					.then(() => handleMessage(envelope))
					.catch((error: unknown) => {
						sendError(envelope, error);
					});
			}
		} catch (error) {
			diagnostic(error);
			void shutdown();
		}
	});
	process.stdin.once("end", () => {
		void shutdown();
	});
	process.stdin.once("close", () => {
		void shutdown();
	});
	process.once("SIGINT", () => {
		void shutdown();
	});
	process.once("SIGTERM", () => {
		void shutdown();
	});

	writeHostMessage(randomUUID(), "host", { type: "host.ready", sessionId: randomUUID() });
}

const runtimeVersions = process.versions as NodeJS.ProcessVersions & { bun?: string };
if (
	shouldRunNativeHost({
		argv0: process.argv[0],
		argv1: process.argv[1],
		execPath: process.execPath,
		isBun: runtimeVersions.bun !== undefined,
		moduleUrl: import.meta.url,
	})
) {
	void runNativeHost().catch((error: unknown) => {
		diagnostic(error);
		process.exitCode = 1;
	});
}
