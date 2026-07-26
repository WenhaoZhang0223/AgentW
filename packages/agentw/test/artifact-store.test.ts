import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { afterEach, describe, expect, it } from "vitest";
import { fromBufferPromise } from "yauzl";
import { ArtifactStore } from "../src/host/artifact-store.ts";
import { TaskWorkspaceManager } from "../src/host/task-workspace.ts";

describe("ArtifactStore", () => {
	const roots: string[] = [];

	afterEach(async () => {
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	});

	it("creates the seven-column workbook and deletes it after acknowledgement", async () => {
		const root = await mkdtemp(join(tmpdir(), "agentw-artifact-"));
		roots.push(root);
		const workspaces = new TaskWorkspaceManager(root);
		const workspace = await workspaces.create("task-1");
		const store = new ArtifactStore(workspaces);
		const artifact = await store.createExcel("task-1", [
			{
				name: "Tea",
				price: "$1",
				productionDate: "网页未提供",
				url: "https://shop.test/tea",
				sourcePage: 1,
				capturedAt: "2026-07-23T10:00:00+01:00",
			},
		]);
		const chunks: Buffer[] = [];
		for await (const chunk of store.chunks(artifact.id)) {
			chunks.push(Buffer.from(chunk.data, "base64"));
		}
		const workbook = new ExcelJS.Workbook();
		await workbook.xlsx.load(Buffer.concat(chunks));

		expect(workbook.worksheets[0]?.getRow(1).values).toEqual([
			undefined,
			"商品名称",
			"包装规格",
			"价格",
			"生产日期",
			"商品链接",
			"来源页码",
			"抓取时间",
		]);
		expect(Buffer.concat(chunks).byteLength).toBe(artifact.size);

		await expect(store.acknowledgeDownload(artifact.id)).resolves.toBe("task-1");
		expect(await readdir(workspace)).toEqual([]);
	});

	it("sorts exported product rows by numeric price ascending", async () => {
		const root = await mkdtemp(join(tmpdir(), "agentw-artifact-"));
		roots.push(root);
		const workspaces = new TaskWorkspaceManager(root);
		await workspaces.create("task-sorted");
		const store = new ArtifactStore(workspaces);
		const prices = ["¥39.8", "¥77.4", "¥14.9", "€0,89", "$1,234.56", "Price unavailable"];
		const artifact = await store.createExcel(
			"task-sorted",
			prices.map((price, index) => ({
				name: `Product ${index}`,
				price,
				productionDate: "Not provided",
				url: `https://shop.test/${index}`,
				sourcePage: 1,
				capturedAt: "now",
			})),
		);
		const chunks: Buffer[] = [];
		for await (const chunk of store.chunks(artifact.id)) chunks.push(Buffer.from(chunk.data, "base64"));
		const workbook = new ExcelJS.Workbook();
		await workbook.xlsx.load(Buffer.concat(chunks));

		expect(
			workbook.worksheets[0]
				?.getColumn(3)
				.values.slice(2)
				.map((value) => String(value)),
		).toEqual(["€0,89", "¥14.9", "¥39.8", "¥77.4", "$1,234.56", "Price unavailable"]);
	});

	it("discards pending artifacts when their session is replaced", async () => {
		const root = await mkdtemp(join(tmpdir(), "agentw-artifact-"));
		roots.push(root);
		const workspaces = new TaskWorkspaceManager(root);
		const workspace = await workspaces.create("task-2");
		const store = new ArtifactStore(workspaces);
		await store.createExcel("task-2", []);

		await store.discardAll();

		expect(store.hasPendingForTask("task-2")).toBe(false);
		expect(await readdir(workspace)).toEqual([]);
	});

	it("creates a valid downloadable Word document and deletes the temporary file after acknowledgement", async () => {
		const root = await mkdtemp(join(tmpdir(), "agentw-artifact-"));
		roots.push(root);
		const workspaces = new TaskWorkspaceManager(root);
		const workspace = await workspaces.create("task-docx");
		const store = new ArtifactStore(workspaces);
		const artifact = await store.createDocument("task-docx", {
			title: "AI Agent 岗位汇总",
			content: "# 岗位一\n- 公司：Research & Development\n- 工作地点：重庆",
			fileName: "重庆 AI Agent 岗位.docx",
		});
		expect(store.listPending()).toEqual([artifact]);
		const chunks: Buffer[] = [];
		for await (const chunk of store.chunks(artifact.id)) chunks.push(Buffer.from(chunk.data, "base64"));
		const data = Buffer.concat(chunks);
		const zip = await fromBufferPromise(data);
		const names: string[] = [];
		let documentXml = "";
		for await (const entry of zip.eachEntry()) {
			names.push(entry.fileName);
			if (entry.fileName !== "word/document.xml") continue;
			const stream = await zip.openReadStreamPromise(entry);
			const xmlChunks: Buffer[] = [];
			for await (const chunk of stream) {
				xmlChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
			}
			documentXml = Buffer.concat(xmlChunks).toString("utf8");
		}
		zip.close();

		expect(artifact.name).toBe("重庆 AI Agent 岗位.docx");
		expect(names).toEqual(
			expect.arrayContaining(["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml"]),
		);
		expect(documentXml).toContain("AI Agent 岗位汇总");
		expect(documentXml).toContain("Research &amp; Development");
		expect(data.byteLength).toBe(artifact.size);

		await expect(store.acknowledgeDownload(artifact.id)).resolves.toBe("task-docx");
		expect(store.listPending()).toEqual([]);
		expect(await readdir(workspace)).toEqual([]);
	});

	it("streams product pages into a valid data.json artifact", async () => {
		const root = await mkdtemp(join(tmpdir(), "agentw-artifact-"));
		roots.push(root);
		const workspaces = new TaskWorkspaceManager(root);
		await workspaces.create("task-json");
		const store = new ArtifactStore(workspaces);
		const record = {
			name: "Tea",
			packaging: "20 bags",
			price: "€0,89",
			productionDate: "网页未提供",
			url: "https://shop.test/tea",
			sourcePage: 1,
			capturedAt: "now",
		};

		await expect(store.appendProductDataset("task-json", [record])).resolves.toEqual({ appended: 1, total: 1 });
		await expect(store.appendProductDataset("task-json", [record])).resolves.toEqual({ appended: 0, total: 1 });
		const artifact = await store.finalizeProductDataset("task-json");
		const chunks: Buffer[] = [];
		for await (const chunk of store.chunks(artifact.id)) chunks.push(Buffer.from(chunk.data, "base64"));

		expect(artifact.name).toBe("data.json");
		expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toEqual([record]);
		expect(await readFile(join(workspaces.get("task-json") ?? "", `${artifact.id}.json`), "utf8")).toContain(
			'"packaging":"20 bags"',
		);
	});

	it("deletes an internal product dataset immediately after finalization", async () => {
		const root = await mkdtemp(join(tmpdir(), "agentw-artifact-"));
		roots.push(root);
		const workspaces = new TaskWorkspaceManager(root);
		const workspace = await workspaces.create("task-internal-json");
		const store = new ArtifactStore(workspaces);
		await store.appendProductDataset("task-internal-json", [
			{
				name: "Tea",
				price: "$1",
				productionDate: "Not provided",
				url: "https://shop.test/tea",
				sourcePage: 1,
				capturedAt: "now",
			},
		]);

		const descriptor = await store.finalizeProductDataset("task-internal-json", undefined, false);

		expect(descriptor.name).toBe("data.json");
		expect(store.listPending()).toEqual([]);
		expect(await readdir(workspace)).toEqual([]);
	});
});
