import { describe, expect, it } from "vitest";
import { normalizeAssistantText } from "../src/edge/assistant-text.ts";

describe("assistant attachment text", () => {
	it("removes fake sandbox download links while preserving the file name", () => {
		expect(
			normalizeAssistantText("已生成：\n[下载重庆_Java岗位_前7个.docx](sandbox:/mnt/data/重庆_Java岗位_前7个.docx)"),
		).toBe("已生成：\n下载重庆_Java岗位_前7个.docx（真实文件由 AgentW 下载区处理）");
	});

	it("removes bare sandbox paths", () => {
		expect(normalizeAssistantText("文件在 `sandbox:/mnt/data/jobs.docx`")).toBe("文件在 AgentW 下载区");
	});
});
