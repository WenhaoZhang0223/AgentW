import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ArtifactDownloads } from "../src/edge/artifact-download.ts";

describe("ArtifactDownloads", () => {
	it("reassembles ordered chunks and verifies size and sha256", async () => {
		const content = Buffer.from("AgentW workbook bytes");
		const downloads = new ArtifactDownloads();
		downloads.begin({
			id: "artifact-1",
			name: "products.xlsx",
			size: content.byteLength,
			sha256: createHash("sha256").update(content).digest("hex"),
		});
		downloads.addChunk("artifact-1", 1, content.subarray(8).toString("base64"));
		downloads.addChunk("artifact-1", 0, content.subarray(0, 8).toString("base64"));

		await expect(downloads.complete("artifact-1")).resolves.toEqual(new Uint8Array(content));
	});

	it("rejects incomplete or corrupted downloads", async () => {
		const downloads = new ArtifactDownloads();
		downloads.begin({
			id: "artifact-2",
			name: "products.xlsx",
			size: 3,
			sha256: "0".repeat(64),
		});
		downloads.addChunk("artifact-2", 0, Buffer.from("bad").toString("base64"));

		await expect(downloads.complete("artifact-2")).rejects.toThrow("Artifact checksum mismatch");
	});

	it("cancels an interrupted download so the same artifact can be retried", async () => {
		const content = Buffer.from("retry");
		const descriptor = {
			id: "artifact-retry",
			name: "jobs.docx",
			size: content.byteLength,
			sha256: createHash("sha256").update(content).digest("hex"),
		};
		const downloads = new ArtifactDownloads();
		downloads.begin(descriptor);
		downloads.cancel(descriptor.id);
		downloads.begin(descriptor);
		downloads.addChunk(descriptor.id, 0, content.toString("base64"));

		await expect(downloads.complete(descriptor.id)).resolves.toEqual(new Uint8Array(content));
	});
});
