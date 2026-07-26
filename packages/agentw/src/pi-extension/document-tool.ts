import { Type } from "typebox";
import type { DocumentArtifactInput } from "../shared/product.ts";
import {
	MAX_DOCUMENT_CONTENT_CHARACTERS,
	MAX_DOCUMENT_FILE_NAME_CHARACTERS,
	MAX_DOCUMENT_TITLE_CHARACTERS,
} from "../shared/product.ts";
import type { AgentWBridge } from "./bridge-client.ts";
import type { AgentWToolDefinition } from "./tool-definition.ts";
import { defineAgentWTool } from "./tool-definition.ts";

type DocumentBridge = Pick<AgentWBridge, "exportDocument">;

export function createDocumentTool(
	bridge: DocumentBridge,
	taskId = process.env.AGENTW_TASK_ID ?? "active",
): AgentWToolDefinition {
	return defineAgentWTool({
		name: "artifact_export_docx",
		label: "Export Word document",
		description:
			"Create a real downloadable .docx attachment from collected or composed content. Supports titles, #/## headings, paragraphs and bullet lines.",
		promptSnippet:
			"When the user asks for a Word, DOC, or DOCX file, collect the requested information and call artifact_export_docx instead of only pasting document text into chat.",
		promptGuidelines: [
			"Use artifact_export_docx whenever the user requests a downloadable Word, DOC, or DOCX attachment.",
			"Never claim that the environment cannot create a Word attachment while this tool is available.",
			"After this tool succeeds, AgentW displays the real attachment with a Download button. Never output sandbox:/mnt/data paths, sandbox Markdown links, or invented local paths.",
			"After success, state the exact returned file name and tell the user to click its Download button. Never claim that the file downloaded automatically.",
			"Keep source URLs in the document when the content came from web pages.",
		],
		parameters: Type.Object(
			{
				title: Type.String({
					minLength: 1,
					maxLength: MAX_DOCUMENT_TITLE_CHARACTERS,
					description: "Document title",
				}),
				content: Type.String({
					minLength: 1,
					maxLength: MAX_DOCUMENT_CONTENT_CHARACTERS,
					description: "Document body using plain text with optional #/## headings and bullet lines",
				}),
				fileName: Type.Optional(
					Type.String({
						minLength: 1,
						maxLength: MAX_DOCUMENT_FILE_NAME_CHARACTERS,
						description: "Download file name; .docx is added automatically",
					}),
				),
			},
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			const artifact = await bridge.exportDocument(taskId, params as DocumentArtifactInput, signal);
			return {
				content: [
					{
						type: "text",
						text: `Real Word attachment ready: ${artifact.name}. Tell the user to click its Download button. Do not output a sandbox link or claim an automatic download.`,
					},
				],
				details: artifact,
			};
		},
	});
}
