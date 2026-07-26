import { ZipFile } from "yazl";

export function createSkillZip(entries: Record<string, string>): Promise<Buffer> {
	return new Promise((resolveZip, rejectZip) => {
		const zip = new ZipFile();
		const chunks: Buffer[] = [];
		zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
		zip.outputStream.once("error", rejectZip);
		zip.outputStream.once("end", () => resolveZip(Buffer.concat(chunks)));
		for (const [name, content] of Object.entries(entries)) {
			zip.addBuffer(Buffer.from(content, "utf8"), name);
		}
		zip.end();
	});
}
