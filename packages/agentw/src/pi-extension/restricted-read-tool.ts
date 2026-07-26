import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { Type } from "typebox";
import { AgentWError } from "../shared/errors.ts";
import { normalizeSkillRelativePath } from "../shared/skill-path.ts";
import { defineAgentWTool } from "./tool-definition.ts";

const MAX_READ_BYTES = 1024 * 1024;
const MAX_READ_LINES = 1_000;
const DENIED_EXTENSIONS = new Set([
	".exe",
	".dll",
	".com",
	".bat",
	".cmd",
	".ps1",
	".js",
	".mjs",
	".cjs",
	".ts",
	".tsx",
	".vbs",
	".py",
	".sh",
	".wasm",
]);

function assertNotAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new AgentWError("TASK_ABORTED");
	}
}

function isContained(root: string, candidate: string): boolean {
	const relativePath = relative(root, candidate);
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export function createRestrictedReadTool(skillRoot: string) {
	const configuredRoot = resolve(skillRoot);
	return defineAgentWTool({
		name: "read",
		label: "Read Skill file",
		description: "Read UTF-8 text files only from AgentW's installed Skill directory.",
		promptSnippet: "Read supporting text from installed AgentW Skills.",
		parameters: Type.Object(
			{
				path: Type.String({ minLength: 1, description: "Path below the installed AgentW Skill directory" }),
				offset: Type.Optional(Type.Integer({ minimum: 1, description: "First line to return, starting at 1" })),
				limit: Type.Optional(
					Type.Integer({ minimum: 1, maximum: MAX_READ_LINES, description: "Maximum lines to return" }),
				),
			},
			{ additionalProperties: false },
		),
		executionMode: "parallel",
		async execute(_toolCallId, params, signal) {
			assertNotAborted(signal);
			const normalizedPath = normalizeSkillRelativePath(params.path);
			if (!normalizedPath) {
				throw new Error("READ_ACCESS_DENIED");
			}
			const lexicalPath = resolve(configuredRoot, normalizedPath);
			if (!isContained(configuredRoot, lexicalPath)) {
				throw new Error("READ_ACCESS_DENIED");
			}
			if (DENIED_EXTENSIONS.has(extname(lexicalPath).toLowerCase())) {
				throw new Error("READ_FILE_TYPE_DENIED");
			}

			const [resolvedRoot, resolvedPath] = await Promise.all([realpath(configuredRoot), realpath(lexicalPath)]);
			if (!isContained(resolvedRoot, resolvedPath)) {
				throw new Error("READ_ACCESS_DENIED");
			}
			const details = await stat(resolvedPath);
			if (!details.isFile() || details.size > MAX_READ_BYTES) {
				throw new Error("READ_FILE_NOT_SUPPORTED");
			}

			assertNotAborted(signal);
			const data = await readFile(resolvedPath);
			assertNotAborted(signal);
			let text: string;
			try {
				text = new TextDecoder("utf-8", { fatal: true }).decode(data);
			} catch {
				throw new Error("READ_FILE_NOT_UTF8");
			}
			const lines = text.split(/\r?\n/);
			const start = (params.offset ?? 1) - 1;
			const limit = params.limit ?? 200;
			const selected = lines.slice(start, start + limit);

			return {
				content: [{ type: "text", text: selected.join("\n") }],
				details: {
					path: resolvedPath,
					totalLines: lines.length,
					startLine: start + 1,
					endLine: start + selected.length,
				},
			};
		},
	});
}
