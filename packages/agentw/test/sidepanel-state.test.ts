import { describe, expect, it } from "vitest";
import { initialSidePanelState, reduceSidePanelState } from "../src/edge/state.ts";

describe("side panel state", () => {
	it("streams assistant text and exposes an artifact", () => {
		const streaming = reduceSidePanelState(initialSidePanelState, {
			type: "assistant.delta",
			text: "已提取",
		});
		const ready = reduceSidePanelState(streaming, {
			type: "artifact.ready",
			id: "a1",
			name: "products.xlsx",
			size: 120,
			sha256: "abc",
		});

		expect(ready.assistantDraft).toBe("已提取");
		expect(ready.artifacts).toHaveLength(1);
	});

	it("marks a stopped task without dropping prior messages", () => {
		const stopped = reduceSidePanelState(
			{ ...initialSidePanelState, messages: [{ id: "m1", role: "user", text: "start" }] },
			{ type: "task.stopped" },
		);

		expect(stopped.messages).toHaveLength(1);
		expect(stopped.status).toBe("stopped");
	});

	it("shows the Native Host connection error", () => {
		const disconnected = reduceSidePanelState(initialSidePanelState, {
			type: "host.disconnected",
			message: "Specified native messaging host not found.",
		});

		expect(disconnected.status).toBe("error");
		expect(disconnected.statusText).toContain("Specified native messaging host not found.");
	});

	it("keeps internal JSON datasets out of the user file list", () => {
		const ready = reduceSidePanelState(initialSidePanelState, {
			type: "artifact.ready",
			id: "internal-json",
			name: "data.json",
			size: 120,
			sha256: "abc",
		});

		expect(ready.artifacts).toEqual([]);
	});

	it("commits the streamed assistant draft when a task settles", () => {
		const settled = reduceSidePanelState(
			{ ...initialSidePanelState, assistantDraft: "完成", status: "running" },
			{ type: "task.settled", messageId: "m2" },
		);

		expect(settled.assistantDraft).toBe("");
		expect(settled.messages).toContainEqual({ id: "m2", role: "assistant", text: "完成" });
		expect(settled.status).toBe("idle");
	});
});
