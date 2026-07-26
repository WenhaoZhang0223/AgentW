export type AgentWErrorCode =
	| "PAGE_ACCESS_DENIED"
	| "PAGE_REQUIRES_USER_ACTION"
	| "STALE_ELEMENT_REFERENCE"
	| "NEXT_PAGE_NOT_FOUND"
	| "HOST_DISCONNECTED"
	| "AGENT_TIMEOUT"
	| "EXPORT_FAILED"
	| "SKILL_VALIDATION_FAILED"
	| "TASK_ABORTED"
	| "INVALID_MESSAGE"
	| "UNSUPPORTED_PROTOCOL"
	| "MESSAGE_TOO_LARGE";

export class AgentWError extends Error {
	readonly code: AgentWErrorCode;

	constructor(code: AgentWErrorCode, message: string = code) {
		super(message);
		this.name = "AgentWError";
		this.code = code;
	}
}
