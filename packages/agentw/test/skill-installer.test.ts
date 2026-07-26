import { readdir } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { SkillInstaller } from "../src/host/skill-installer.ts";
import { createSkillZip } from "./support/create-skill-zip.ts";

describe("SkillInstaller", () => {
	const installers: SkillInstaller[] = [];

	afterEach(async () => {
		await Promise.all(installers.splice(0).map((installer) => installer.disposeForTest()));
	});

	it("installs, disables, and enables a markdown-only skill with valid frontmatter", async () => {
		const installer = SkillInstaller.forTest();
		installers.push(installer);
		const zip = await createSkillZip({
			"my-skill/SKILL.md": "---\nname: my-skill\ndescription: Extract products.\n---\n# Skill",
		});

		await expect(installer.installZip(zip)).resolves.toEqual({ name: "my-skill", enabled: true });
		await expect(installer.list()).resolves.toEqual([{ name: "my-skill", enabled: true }]);
		await installer.disable("my-skill");
		await expect(installer.list()).resolves.toEqual([{ name: "my-skill", enabled: false }]);
		await installer.enable("my-skill");
		await expect(installer.list()).resolves.toEqual([{ name: "my-skill", enabled: true }]);
	});

	it("rejects path traversal and executable files without leaving validation files", async () => {
		const installer = SkillInstaller.forTest();
		installers.push(installer);
		await expect(
			installer.installFiles([{ relativePath: "../escape.md", data: Buffer.from("bad") }]),
		).rejects.toThrow("SKILL_VALIDATION_FAILED");
		await expect(
			installer.installFiles([
				{
					relativePath: "bad/SKILL.md",
					data: Buffer.from("---\nname: bad\ndescription: bad\n---"),
				},
				{ relativePath: "bad/run.ps1:payload.md", data: Buffer.from("bad") },
			]),
		).rejects.toThrow("SKILL_VALIDATION_FAILED");
		const executable = await createSkillZip({
			"bad/SKILL.md": "---\nname: bad\ndescription: bad\n---",
			"bad/run.ps1": "Write-Host bad",
		});
		await expect(installer.installZip(executable)).rejects.toThrow("SKILL_VALIDATION_FAILED");
		await expect(readdir(installer.validationRootForTest())).resolves.toEqual([]);
	});

	it("requires explicit overwrite for an existing skill", async () => {
		const installer = SkillInstaller.forTest();
		installers.push(installer);
		const first = await createSkillZip({
			"same/SKILL.md": "---\nname: same\ndescription: First.\n---\n# First",
		});
		const second = await createSkillZip({
			"same/SKILL.md": "---\nname: same\ndescription: Second.\n---\n# Second",
		});
		await installer.installZip(first);

		await expect(installer.installZip(second)).rejects.toThrow("Skill already exists");
		await expect(installer.installZip(second, { overwrite: true })).resolves.toMatchObject({ name: "same" });
	});
});
