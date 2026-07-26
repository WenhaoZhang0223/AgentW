import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createRestrictedReadTool } from "../src/pi-extension/restricted-read-tool.ts";

describe("restricted read tool", () => {
	const roots: string[] = [];

	afterEach(async () => {
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	});

	it("reads UTF-8 text inside the Skill root", async () => {
		const root = await mkdtemp(join(tmpdir(), "agentw-read-"));
		roots.push(root);
		const skillDir = join(root, "skills", "catalog");
		await mkdir(skillDir, { recursive: true });
		await writeFile(join(skillDir, "SKILL.md"), "line one\nline two\nline three", "utf8");
		const tool = createRestrictedReadTool(join(root, "skills"));

		const result = await tool.execute(
			"call-1",
			{ path: "catalog/SKILL.md", offset: 2, limit: 1 },
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect(result.content[0]).toMatchObject({ type: "text", text: "line two" });
	});

	it("rejects traversal and executable files", async () => {
		const root = await mkdtemp(join(tmpdir(), "agentw-read-"));
		roots.push(root);
		const skillRoot = join(root, "skills");
		await mkdir(skillRoot);
		await writeFile(join(root, "outside.md"), "outside", "utf8");
		await writeFile(join(skillRoot, "run.ps1"), "Write-Host bad", "utf8");
		const tool = createRestrictedReadTool(skillRoot);

		await expect(
			tool.execute("call-2", { path: "../outside.md" }, undefined, undefined, {} as ExtensionContext),
		).rejects.toThrow("READ_ACCESS_DENIED");
		await expect(
			tool.execute("call-3", { path: "run.ps1" }, undefined, undefined, {} as ExtensionContext),
		).rejects.toThrow("READ_FILE_TYPE_DENIED");
		await expect(
			tool.execute("call-4", { path: "run.ps1:payload.md" }, undefined, undefined, {} as ExtensionContext),
		).rejects.toThrow("READ_ACCESS_DENIED");
	});
});
