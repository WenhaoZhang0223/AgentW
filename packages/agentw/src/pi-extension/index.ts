import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createArtifactTool } from "./artifact-tool.ts";
import type { AgentWBridge } from "./bridge-client.ts";
import { BridgeClient } from "./bridge-client.ts";
import { createBrowserTools } from "./browser-tools.ts";
import { createDocumentTool } from "./document-tool.ts";
import { createProductCollectionTool } from "./product-collection-tool.ts";
import { createRestrictedReadTool } from "./restricted-read-tool.ts";
import type { AgentWToolDefinition } from "./tool-definition.ts";

interface AgentWToolOptions {
	skillRoot?: string;
	taskId?: string;
}

export function createAgentWTools(bridge: AgentWBridge, options: AgentWToolOptions = {}): AgentWToolDefinition[] {
	const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
	const skillRoot = options.skillRoot ?? join(localAppData, "AgentW", "skills");
	return [
		...createBrowserTools(bridge, options.taskId),
		createProductCollectionTool(bridge, options.taskId),
		createArtifactTool(bridge, options.taskId),
		createDocumentTool(bridge, options.taskId),
		createRestrictedReadTool(skillRoot),
	];
}

export { createArtifactTool } from "./artifact-tool.ts";
export type { AgentWBridge } from "./bridge-client.ts";
export { BridgeClient } from "./bridge-client.ts";
export { createBrowserTools } from "./browser-tools.ts";
export { createDocumentTool } from "./document-tool.ts";
export { createProductCollectionTool } from "./product-collection-tool.ts";
export { createRestrictedReadTool } from "./restricted-read-tool.ts";

export default function agentWExtension(pi: ExtensionAPI): void {
	const bridge = new BridgeClient();
	for (const tool of createAgentWTools(bridge)) {
		pi.registerTool(tool);
	}
	pi.on("session_shutdown", () => {
		bridge.dispose();
	});
}
