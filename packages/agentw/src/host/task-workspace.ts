import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const TASK_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const EXPIRED_AFTER_MS = 24 * 60 * 60 * 1000;

export class TaskWorkspaceManager {
	readonly root: string;
	private readonly workspaces = new Map<string, string>();

	constructor(root: string) {
		this.root = resolve(root);
	}

	async create(taskId: string): Promise<string> {
		this.assertTaskId(taskId);
		const existing = this.workspaces.get(taskId);
		if (existing) {
			return existing;
		}
		await mkdir(this.root, { recursive: true });
		const path = await mkdtemp(join(this.root, `${taskId}-`));
		this.assertOwnedPath(path);
		this.workspaces.set(taskId, path);
		return path;
	}

	get(taskId: string): string | undefined {
		return this.workspaces.get(taskId);
	}

	async cleanup(taskId: string): Promise<void> {
		const path = this.workspaces.get(taskId);
		if (!path) {
			return;
		}
		this.assertOwnedPath(path);
		this.workspaces.delete(taskId);
		await rm(path, { recursive: true, force: true });
	}

	async cleanupAll(): Promise<void> {
		await Promise.all([...this.workspaces.keys()].map((taskId) => this.cleanup(taskId)));
	}

	async cleanupExpired(now: Date): Promise<string[]> {
		await mkdir(this.root, { recursive: true });
		const entries = await readdir(this.root, { withFileTypes: true });
		const removed: string[] = [];

		for (const entry of entries) {
			if (!entry.isDirectory() || !TASK_ID_PATTERN.test(entry.name)) {
				continue;
			}
			const path = join(this.root, entry.name);
			this.assertOwnedPath(path);
			const details = await stat(path);
			if (now.getTime() - details.mtimeMs <= EXPIRED_AFTER_MS) {
				continue;
			}
			await rm(path, { recursive: true, force: true });
			removed.push(path);
		}

		return removed.sort();
	}

	private assertTaskId(taskId: string): void {
		if (!TASK_ID_PATTERN.test(taskId)) {
			throw new Error("INVALID_TASK_ID");
		}
	}

	private assertOwnedPath(path: string): void {
		const resolved = resolve(path);
		if (dirname(resolved) !== this.root || resolved === this.root) {
			throw new Error("UNSAFE_TEMP_PATH");
		}
	}
}
