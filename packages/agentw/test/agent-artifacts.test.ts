import { describe, expect, it } from "vitest";
import { artifactsFromAgentEvent } from "../src/edge/agent-artifacts.ts";

describe("agent artifact recovery", () => {
	it("recovers a direct document artifact from a completed tool event", () => {
		expect(
			artifactsFromAgentEvent({
				type: "tool_execution_end",
				result: {
					details: {
						id: "doc-1",
						name: "jobs.docx",
						size: 512,
						sha256: "abc",
					},
				},
			}),
		).toEqual([{ id: "doc-1", name: "jobs.docx", size: 512, sha256: "abc" }]);
	});

	it("recovers the nested Excel artifact from product collection", () => {
		expect(
			artifactsFromAgentEvent({
				type: "tool_execution_end",
				result: {
					details: {
						excelArtifact: {
							id: "excel-1",
							name: "products.xlsx",
							size: 1_024,
							sha256: "def",
						},
						total: 247,
					},
				},
			}),
		).toEqual([{ id: "excel-1", name: "products.xlsx", size: 1_024, sha256: "def" }]);
	});

	it("ignores unrelated tool details", () => {
		expect(
			artifactsFromAgentEvent({
				type: "tool_execution_end",
				result: { details: { total: 247 } },
			}),
		).toEqual([]);
	});
});
