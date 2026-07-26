import { mkdir, mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskWorkspaceManager } from "../src/host/task-workspace.ts";

describe("TaskWorkspaceManager", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "agentw-workspace-test-"));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("creates a contained directory and removes it", async () => {
		const manager = new TaskWorkspaceManager(root);
		const path = await manager.create("task-1");

		expect(path.startsWith(root)).toBe(true);
		await manager.cleanup("task-1");
		await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("removes only AgentW directories older than 24 hours", async () => {
		const manager = new TaskWorkspaceManager(root);
		const oldPath = join(root, "task-old");
		const freshPath = join(root, "task-fresh");
		await mkdir(oldPath);
		await mkdir(freshPath);
		const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
		await utimes(oldPath, old, old);

		const removed = await manager.cleanupExpired(new Date());

		expect(removed).toEqual([oldPath]);
		await expect(stat(freshPath)).resolves.toBeDefined();
	});

	it("rejects unsafe task identifiers", async () => {
		const manager = new TaskWorkspaceManager(root);

		await expect(manager.create("../escape")).rejects.toThrow("INVALID_TASK_ID");
	});
});
