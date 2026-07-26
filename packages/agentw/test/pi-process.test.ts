import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiProcess, resolvePiLaunch } from "../src/host/pi-process.ts";

class FakePiChild extends EventEmitter {
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly kill = vi.fn(() => true);
}

describe("PiProcess", () => {
	const roots: string[] = [];

	afterEach(async () => {
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	});

	it("refuses to recursively launch a compiled Bun Host when pi.exe is missing", () => {
		expect(() =>
			resolvePiLaunch({
				execPath: "C:\\AgentW\\agentw-host.exe",
				isBun: true,
				resolveRpcEntry: () => "C:\\AgentW\\rpc-entry.js",
				siblingExists: false,
			}),
		).toThrow("AGENTW_PI_EXECUTABLE_NOT_FOUND");
	});

	it("uses the sibling pi.exe from a compiled Host distribution", () => {
		expect(
			resolvePiLaunch({
				execPath: "C:\\AgentW\\agentw-host.exe",
				isBun: true,
				resolveRpcEntry: () => "unused",
				siblingExists: true,
			}),
		).toEqual({ command: "C:\\AgentW\\pi.exe", prefixArgs: [] });
	});

	it("sends prompt JSONL, correlates its response, and forwards agent events", async () => {
		const root = await mkdtemp(join(tmpdir(), "agentw-pi-process-"));
		roots.push(root);
		const child = new FakePiChild();
		const writes: string[] = [];
		child.stdin.on("data", (chunk: Buffer) => writes.push(chunk.toString("utf8")));
		const events: unknown[] = [];
		const process = new PiProcess({
			onEvent: (event) => events.push(event),
			spawnProcess: () => child,
		});
		await process.start({
			bridgePipe: String.raw`\\.\pipe\agentw-test`,
			bridgeToken: "test-token",
			extensionPath: join(root, "pi-extension", "index.js"),
			sessionDir: join(root, "sessions"),
			agentDir: join(root, "agent"),
			executable: "C:\\AgentW\\pi.exe",
		});

		const pending = process.prompt("hello");
		const command = JSON.parse(writes[0] ?? "") as { id: string; type: string; message: string };
		expect(command).toMatchObject({ type: "prompt", message: "hello" });
		child.stdout.write(`${JSON.stringify({ type: "response", id: command.id, command: "prompt", success: true })}\n`);
		await pending;

		child.stdout.write(
			`${JSON.stringify({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "ok" },
			})}\n`,
		);
		expect(events).toHaveLength(1);
		process.dispose();
	});

	it("rejects a failed RPC response without forwarding it as an event", async () => {
		const root = await mkdtemp(join(tmpdir(), "agentw-pi-process-"));
		roots.push(root);
		const child = new FakePiChild();
		const writes: string[] = [];
		child.stdin.on("data", (chunk: Buffer) => writes.push(chunk.toString("utf8")));
		const events: unknown[] = [];
		const process = new PiProcess({
			onEvent: (event) => events.push(event),
			spawnProcess: () => child,
		});
		await process.start({
			bridgePipe: "pipe",
			bridgeToken: "token",
			extensionPath: join(root, "extension.js"),
			sessionDir: join(root, "sessions"),
			agentDir: join(root, "agent"),
			executable: "pi.exe",
		});

		const pending = process.setModel("provider", "missing-model");
		const command = JSON.parse(writes[0] ?? "") as { id: string };
		child.stdout.write(
			`${JSON.stringify({
				type: "response",
				id: command.id,
				command: "set_model",
				success: false,
				error: "Model not found",
			})}\n`,
		);

		await expect(pending).rejects.toThrow("Model not found");
		expect(events).toEqual([]);
		process.dispose();
	});

	it("terminates the child when stdout is not strict JSONL", async () => {
		const root = await mkdtemp(join(tmpdir(), "agentw-pi-process-"));
		roots.push(root);
		const child = new FakePiChild();
		const events: unknown[] = [];
		const process = new PiProcess({
			onEvent: (event) => events.push(event),
			spawnProcess: () => child,
		});
		await process.start({
			bridgePipe: "pipe",
			bridgeToken: "token",
			extensionPath: join(root, "extension.js"),
			sessionDir: join(root, "sessions"),
			agentDir: join(root, "agent"),
			executable: "pi.exe",
		});

		const pending = process.prompt("hello");
		child.stdout.write("not-json\n");

		await expect(pending).rejects.toThrow("PI_RPC_INVALID_JSON");
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		expect(events).toContainEqual({ type: "agentw_failure", message: "PI_RPC_INVALID_JSON" });
	});
});
