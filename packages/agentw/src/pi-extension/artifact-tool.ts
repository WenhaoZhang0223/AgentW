import { Type } from "typebox";
import type { ProductRecord } from "../shared/product.ts";
import {
	MAX_CAPTURED_AT_CHARACTERS,
	MAX_PRODUCT_BATCH_RECORDS,
	MAX_PRODUCT_DATE_CHARACTERS,
	MAX_PRODUCT_NAME_CHARACTERS,
	MAX_PRODUCT_PACKAGING_CHARACTERS,
	MAX_PRODUCT_PRICE_CHARACTERS,
	MAX_PRODUCT_URL_CHARACTERS,
} from "../shared/product.ts";
import type { AgentWBridge } from "./bridge-client.ts";
import type { AgentWToolDefinition } from "./tool-definition.ts";
import { defineAgentWTool } from "./tool-definition.ts";

type ArtifactBridge = Pick<AgentWBridge, "exportExcel">;

export function createArtifactTool(
	bridge: ArtifactBridge,
	taskId = process.env.AGENTW_TASK_ID ?? "active",
): AgentWToolDefinition {
	return defineAgentWTool({
		name: "artifact_export_excel",
		label: "Export products to Excel",
		description: "Create a downloadable Excel workbook from fixed product records.",
		promptSnippet: "Export the collected product records to an Excel workbook when the user asks.",
		promptGuidelines: [
			"After this tool succeeds, AgentW displays the real workbook with a Download button. Never output sandbox:/mnt/data paths, sandbox Markdown links, or invented local paths.",
			"After success, state the exact returned file name and tell the user to click its Download button. Never claim that the file downloaded automatically.",
		],
		parameters: Type.Object(
			{
				records: Type.Array(
					Type.Object(
						{
							name: Type.String({ maxLength: MAX_PRODUCT_NAME_CHARACTERS }),
							packaging: Type.Optional(Type.String({ maxLength: MAX_PRODUCT_PACKAGING_CHARACTERS })),
							price: Type.String({ maxLength: MAX_PRODUCT_PRICE_CHARACTERS }),
							productionDate: Type.String({ maxLength: MAX_PRODUCT_DATE_CHARACTERS }),
							url: Type.String({ maxLength: MAX_PRODUCT_URL_CHARACTERS }),
							sourcePage: Type.Integer({ minimum: 1 }),
							capturedAt: Type.String({ maxLength: MAX_CAPTURED_AT_CHARACTERS }),
						},
						{ additionalProperties: false },
					),
					{ maxItems: MAX_PRODUCT_BATCH_RECORDS },
				),
			},
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			const artifact = await bridge.exportExcel(taskId, params.records as ProductRecord[], signal);
			return {
				content: [
					{
						type: "text",
						text: `Real Excel file ready: ${artifact.name}. Tell the user to click its Download button. Do not output a sandbox link or claim an automatic download.`,
					},
				],
				details: artifact,
			};
		},
	});
}
