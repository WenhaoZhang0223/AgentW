import { describe, expect, it } from "vitest";
import { TaskTabRegistry } from "../src/edge/task-tabs.ts";

describe("task tab registry", () => {
	it("keeps concurrent task tabs isolated", () => {
		const tabs = new TaskTabRegistry();
		tabs.bind("github-task", { tabId: 17, windowId: 3 });
		tabs.bind("bilibili-task", { tabId: 42, windowId: 3 });

		expect(tabs.get("github-task")).toEqual({ tabId: 17, windowId: 3 });
		expect(tabs.get("bilibili-task")).toEqual({ tabId: 42, windowId: 3 });
	});

	it("removes a settled task without changing another task", () => {
		const tabs = new TaskTabRegistry();
		tabs.bind("old-task", { tabId: 7, windowId: 1 });
		tabs.bind("active-task", { tabId: 8, windowId: 1 });

		tabs.delete("old-task");

		expect(tabs.get("old-task")).toBeUndefined();
		expect(tabs.get("active-task")).toEqual({ tabId: 8, windowId: 1 });
	});
});
