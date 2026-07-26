import { afterEach, describe, expect, it } from "vitest";
import { SkillInstaller } from "../src/host/skill-installer.ts";
import { SkillUploadManager } from "../src/host/skill-upload.ts";
import { createSkillZip } from "./support/create-skill-zip.ts";

describe("SkillUploadManager", () => {
	const installers: SkillInstaller[] = [];

	afterEach(async () => {
		await Promise.all(installers.splice(0).map((installer) => installer.disposeForTest()));
	});

	it("assembles sequential ZIP chunks and installs the skill", async () => {
		const installer = SkillInstaller.forTest();
		installers.push(installer);
		const uploads = new SkillUploadManager(installer);
		const zip = await createSkillZip({
			"uploaded/SKILL.md": "---\nname: uploaded\ndescription: Uploaded skill.\n---\n# Skill",
		});
		uploads.begin({
			uploadId: "upload-1",
			format: "zip",
			totalBytes: zip.byteLength,
			overwrite: false,
		});
		uploads.addChunk({
			uploadId: "upload-1",
			index: 0,
			data: zip.subarray(0, 20).toString("base64"),
		});
		uploads.addChunk({
			uploadId: "upload-1",
			index: 1,
			data: zip.subarray(20).toString("base64"),
		});

		await expect(uploads.finish("upload-1")).resolves.toEqual({ name: "uploaded", enabled: true });
	});

	it("rejects out-of-order chunks", () => {
		const installer = SkillInstaller.forTest();
		installers.push(installer);
		const uploads = new SkillUploadManager(installer);
		uploads.begin({ uploadId: "upload-2", format: "files", totalBytes: 3, overwrite: false });

		expect(() =>
			uploads.addChunk({
				uploadId: "upload-2",
				index: 1,
				relativePath: "skill/SKILL.md",
				data: Buffer.from("bad").toString("base64"),
			}),
		).toThrow("Invalid upload chunk sequence");
	});
});
