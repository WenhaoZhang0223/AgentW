const MARKDOWN_SANDBOX_LINK = /\[([^\]]+)\]\(\s*sandbox:\/mnt\/data\/[^)\r\n]+\s*\)/giu;
const BARE_SANDBOX_PATH = /`?sandbox:\/mnt\/data\/[^\s)`]+`?/giu;

export function normalizeAssistantText(text: string): string {
	return text
		.replace(MARKDOWN_SANDBOX_LINK, "$1（真实文件由 AgentW 下载区处理）")
		.replace(BARE_SANDBOX_PATH, "AgentW 下载区")
		.replace(/\n{3,}/g, "\n\n");
}
