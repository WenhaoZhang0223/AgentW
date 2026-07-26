import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createDocumentTool } from "../src/pi-extension/document-tool.ts";

describe("Word document export tool", () => {
	it("creates a downloadable DOCX instead of returning only document text", async () => {
		const exportDocument = vi.fn(async () => ({
			id: "document-1",
			name: "ai-agent-jobs.docx",
			size: 256,
			sha256: "d".repeat(64),
		}));
		const tool = createDocumentTool({ exportDocument }, "task-1");
		const input = {
			title: "AI Agent 岗位汇总",
			content: "# 岗位\n- AI Agent Engineer\n- 工作地点：重庆",
			fileName: "ai-agent-jobs",
		};

		const result = await tool.execute(
			"call-document",
			input,
			new AbortController().signal,
			undefined,
			{} as ExtensionContext,
		);

		expect(exportDocument).toHaveBeenCalledWith("task-1", input, expect.any(AbortSignal));
		expect(result.details).toMatchObject({ id: "document-1", name: "ai-agent-jobs.docx" });
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("click its Download button"),
		});
		expect(result.content[0]).not.toMatchObject({ text: expect.stringContaining("downloaded automatically") });
		expect(tool.promptGuidelines?.join(" ")).toContain("Never claim");
		expect(tool.promptGuidelines?.join(" ")).toContain("Never output sandbox:");
	});
});
