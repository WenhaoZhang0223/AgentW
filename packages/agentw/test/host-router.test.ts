import { afterEach, describe, expect, it, vi } from "vitest";
import { HostRouter } from "../src/host/host-router.ts";
import type { HostMessage } from "../src/shared/protocol.ts";

type BrowserCommandMessage = Extract<HostMessage, { type: "browser.command" }>;

describe("HostRouter", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("correlates a browser result with the emitted command", async () => {
		const sent: Array<{ taskId: string; message: BrowserCommandMessage }> = [];
		const router = new HostRouter((taskId, message) => {
			sent.push({ taskId, message });
		});

		const resultPromise = router.requestBrowser("task-1", { type: "browser.inspect" });
		expect(sent).toHaveLength(1);
		expect(sent[0]?.taskId).toBe("task-1");
		const commandId = sent[0]?.message.commandId;
		expect(commandId).toBeTypeOf("string");

		const handled = router.handleBrowserResult(commandId ?? "", {
			type: "browser.snapshot",
			title: "Products",
			url: "https://example.com/products",
			fingerprint: "page-1",
			text: "Example product",
			links: [],
			fields: [],
		});

		expect(handled).toBe(true);
		await expect(resultPromise).resolves.toMatchObject({ type: "browser.snapshot", fingerprint: "page-1" });
	});

	it("aborts only requests belonging to the selected task", async () => {
		const sent: BrowserCommandMessage[] = [];
		const router = new HostRouter((_taskId, message) => {
			sent.push(message);
		});
		const first = router.requestBrowser("task-1", { type: "browser.inspect" });
		const second = router.requestBrowser("task-2", { type: "browser.inspect" });
		const firstRejection = expect(first).rejects.toMatchObject({ code: "TASK_ABORTED" });

		router.abortTask("task-1");
		const secondCommandId = sent[1]?.commandId ?? "";
		router.handleBrowserResult(secondCommandId, {
			type: "browser.action",
			changed: true,
			fingerprint: "page-2",
		});

		await firstRejection;
		await expect(second).resolves.toMatchObject({ type: "browser.action", changed: true });
	});

	it("rejects a browser request after the configured page timeout", async () => {
		vi.useFakeTimers();
		const router = new HostRouter(() => undefined, { pageTimeoutMs: 30_000 });
		const result = router.requestBrowser("task-1", { type: "browser.inspect" });
		const rejection = expect(result).rejects.toMatchObject({ code: "AGENT_TIMEOUT" });

		await vi.advanceTimersByTimeAsync(30_000);

		await rejection;
	});

	it("rejects a correlated browser command error", async () => {
		const sent: BrowserCommandMessage[] = [];
		const router = new HostRouter((_taskId, message) => {
			sent.push(message);
		});
		const result = router.requestBrowser("task-1", { type: "browser.inspect" });
		const rejection = expect(result).rejects.toMatchObject({ code: "PAGE_ACCESS_DENIED" });

		const handled = router.handleBrowserError(
			sent[0]?.commandId ?? "",
			"PAGE_ACCESS_DENIED",
			"Authorize this page from the toolbar",
		);

		expect(handled).toBe(true);
		await rejection;
	});
});
