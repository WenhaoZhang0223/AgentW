import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createArtifactTool } from "../src/pi-extension/artifact-tool.ts";

describe("artifact export tool", () => {
	it("exports fixed product records and returns the artifact descriptor", async () => {
		const exportExcel = vi.fn(async () => ({
			id: "artifact-1",
			name: "products.xlsx",
			size: 128,
			sha256: "a".repeat(64),
		}));
		const tool = createArtifactTool({ exportExcel }, "task-1");
		const records = [
			{
				name: "Tea",
				price: "$1",
				productionDate: "Not provided",
				url: "https://shop.test/tea",
				sourcePage: 1,
				capturedAt: "2026-07-23T10:00:00.000Z",
			},
		];

		const result = await tool.execute(
			"call-1",
			{ records },
			new AbortController().signal,
			undefined,
			{} as ExtensionContext,
		);

		expect(exportExcel).toHaveBeenCalledWith("task-1", records, expect.any(AbortSignal));
		expect(result.details).toMatchObject({ id: "artifact-1", name: "products.xlsx" });
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("click its Download button"),
		});
		expect(result.content[0]).not.toMatchObject({ text: expect.stringContaining("downloaded automatically") });
		expect(tool.promptGuidelines?.join(" ")).toContain("Never output sandbox:");
		const parameters = tool.parameters as {
			properties: { records: { maxItems?: number } };
		};
		expect(parameters.properties.records.maxItems).toBe(2_000);
	});
});
