export interface TaskTab {
	tabId: number;
	windowId: number;
}

export class TaskTabRegistry {
	private readonly tabs = new Map<string, TaskTab>();

	bind(taskId: string, tab: TaskTab): void {
		this.tabs.set(taskId, tab);
	}

	get(taskId: string): TaskTab | undefined {
		return this.tabs.get(taskId);
	}

	delete(taskId: string): void {
		this.tabs.delete(taskId);
	}

	clear(): void {
		this.tabs.clear();
	}
}
