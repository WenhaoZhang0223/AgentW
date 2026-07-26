import type { defineTool, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

export type AgentWToolDefinition = ReturnType<typeof defineTool>;

export function defineAgentWTool<TParams extends TSchema, TDetails = unknown>(
	tool: ToolDefinition<TParams, TDetails>,
): ToolDefinition<TParams, TDetails> & AgentWToolDefinition {
	return tool as ToolDefinition<TParams, TDetails> & AgentWToolDefinition;
}
