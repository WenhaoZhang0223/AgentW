import { createHash, randomUUID } from "node:crypto";
import { appendFile, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { AgentWError } from "../shared/errors.ts";
import {
	type ArtifactDescriptor,
	type DocumentArtifactInput,
	type ProductRecord,
	sortProductsByPriceAscending,
} from "../shared/product.ts";
import { MAX_BINARY_CHUNK_BYTES } from "../shared/protocol.ts";
import { writeDocx } from "./docx-writer.ts";
import type { TaskWorkspaceManager } from "./task-workspace.ts";

export interface ArtifactChunk {
	index: number;
	data: string;
}

interface StoredArtifact {
	descriptor: ArtifactDescriptor;
	path: string;
	taskId: string;
}

interface ProductDataset {
	count: number;
	id: string;
	path: string;
	seen: Set<string>;
	taskId: string;
}

export class ArtifactStore {
	private readonly artifacts = new Map<string, StoredArtifact>();
	private readonly datasets = new Map<string, ProductDataset>();
	private readonly workspaces: TaskWorkspaceManager;

	constructor(workspaces: TaskWorkspaceManager) {
		this.workspaces = workspaces;
	}

	async appendProductDataset(
		taskId: string,
		records: ProductRecord[],
		signal?: AbortSignal,
	): Promise<{ appended: number; total: number }> {
		if (signal?.aborted) throw new AgentWError("TASK_ABORTED");
		const dataset = await this.getOrCreateDataset(taskId);
		const unique: ProductRecord[] = [];
		for (const record of records) {
			const key = record.url
				? `url:${record.url}`
				: `name:${record.name.toLocaleLowerCase()}\u0000${record.packaging ?? ""}\u0000${record.price}`;
			if (dataset.seen.has(key)) continue;
			dataset.seen.add(key);
			unique.push(record);
		}
		if (unique.length > 0) {
			const prefix = dataset.count === 0 ? "" : ",";
			await appendFile(dataset.path, `${prefix}${unique.map((record) => JSON.stringify(record)).join(",")}`, "utf8");
			dataset.count += unique.length;
		}
		if (signal?.aborted) throw new AgentWError("TASK_ABORTED");
		return { appended: unique.length, total: dataset.count };
	}

	async finalizeProductDataset(
		taskId: string,
		signal?: AbortSignal,
		retainArtifact = true,
	): Promise<ArtifactDescriptor> {
		if (signal?.aborted) throw new AgentWError("TASK_ABORTED");
		const dataset = await this.getOrCreateDataset(taskId);
		await appendFile(dataset.path, "]", "utf8");
		const finalPath = dataset.path.replace(/\.part$/, "");
		await rename(dataset.path, finalPath);
		this.datasets.delete(taskId);
		const data = await readFile(finalPath);
		const details = await stat(finalPath);
		if (signal?.aborted) {
			await rm(finalPath, { force: true });
			throw new AgentWError("TASK_ABORTED");
		}
		const descriptor: ArtifactDescriptor = {
			id: dataset.id,
			name: "data.json",
			size: details.size,
			sha256: createHash("sha256").update(data).digest("hex"),
		};
		if (retainArtifact) {
			this.artifacts.set(dataset.id, { descriptor, path: finalPath, taskId });
		} else {
			await rm(finalPath, { force: true });
		}
		return descriptor;
	}

	async createExcel(taskId: string, records: ProductRecord[], signal?: AbortSignal): Promise<ArtifactDescriptor> {
		if (signal?.aborted) throw new AgentWError("TASK_ABORTED");
		const workspace = this.workspaces.get(taskId);
		if (!workspace) throw new AgentWError("EXPORT_FAILED", "Task workspace is unavailable");
		const id = randomUUID();
		const path = join(workspace, `${id}.xlsx`);
		const temporaryPath = `${path}.tmp`;
		try {
			const workbook = new ExcelJS.Workbook();
			workbook.creator = "AgentW";
			workbook.created = new Date();
			const sheet = workbook.addWorksheet("Products", {
				views: [{ state: "frozen", ySplit: 1 }],
			});
			sheet.columns = [
				{ header: "商品名称", key: "name", width: 30 },
				{ header: "包装规格", key: "packaging", width: 18 },
				{ header: "价格", key: "price", width: 16 },
				{ header: "生产日期", key: "productionDate", width: 18 },
				{ header: "商品链接", key: "url", width: 46 },
				{ header: "来源页码", key: "sourcePage", width: 12 },
				{ header: "抓取时间", key: "capturedAt", width: 26 },
			];
			sheet.autoFilter = "A1:G1";
			sheet.getRow(1).font = { bold: true };
			for (const record of sortProductsByPriceAscending(records)) sheet.addRow(record);
			await workbook.xlsx.writeFile(temporaryPath);
			if (signal?.aborted) throw new AgentWError("TASK_ABORTED");
			await rename(temporaryPath, path);
			const data = await readFile(path);
			const details = await stat(path);
			if (signal?.aborted) throw new AgentWError("TASK_ABORTED");
			const descriptor: ArtifactDescriptor = {
				id,
				name: "products.xlsx",
				size: details.size,
				sha256: createHash("sha256").update(data).digest("hex"),
			};
			this.artifacts.set(id, { descriptor, path, taskId });
			return descriptor;
		} catch (error) {
			await Promise.all([rm(temporaryPath, { force: true }), rm(path, { force: true })]);
			throw error instanceof AgentWError
				? error
				: new AgentWError("EXPORT_FAILED", error instanceof Error ? error.message : String(error));
		}
	}

	async createDocument(
		taskId: string,
		input: DocumentArtifactInput,
		signal?: AbortSignal,
	): Promise<ArtifactDescriptor> {
		if (signal?.aborted) throw new AgentWError("TASK_ABORTED");
		const workspace = this.workspaces.get(taskId);
		if (!workspace) throw new AgentWError("EXPORT_FAILED", "Task workspace is unavailable");
		const id = randomUUID();
		const path = join(workspace, `${id}.docx`);
		const temporaryPath = `${path}.tmp`;
		const requestedName = (input.fileName || input.title || "document")
			.replace(/\.docx?$/i, "")
			.replace(/[\\/:*?"<>|]/g, "-")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 120);
		const name = `${requestedName || "document"}.docx`;
		try {
			await writeDocx(temporaryPath, input);
			if (signal?.aborted) throw new AgentWError("TASK_ABORTED");
			await rename(temporaryPath, path);
			const data = await readFile(path);
			const details = await stat(path);
			if (signal?.aborted) throw new AgentWError("TASK_ABORTED");
			const descriptor: ArtifactDescriptor = {
				id,
				name,
				size: details.size,
				sha256: createHash("sha256").update(data).digest("hex"),
			};
			this.artifacts.set(id, { descriptor, path, taskId });
			return descriptor;
		} catch (error) {
			await Promise.all([rm(temporaryPath, { force: true }), rm(path, { force: true })]);
			throw error instanceof AgentWError
				? error
				: new AgentWError("EXPORT_FAILED", error instanceof Error ? error.message : String(error));
		}
	}

	async *chunks(artifactId: string): AsyncIterable<ArtifactChunk> {
		const artifact = this.artifacts.get(artifactId);
		if (!artifact) throw new AgentWError("EXPORT_FAILED", "Artifact not found");
		const data = await readFile(artifact.path);
		let index = 0;
		for (let offset = 0; offset < data.byteLength; offset += MAX_BINARY_CHUNK_BYTES) {
			yield {
				index: index++,
				data: data.subarray(offset, offset + MAX_BINARY_CHUNK_BYTES).toString("base64"),
			};
		}
	}

	async acknowledgeDownload(artifactId: string): Promise<string | undefined> {
		const artifact = this.artifacts.get(artifactId);
		if (!artifact) return undefined;
		this.artifacts.delete(artifactId);
		await rm(artifact.path, { force: true });
		return artifact.taskId;
	}

	async discardTask(taskId: string): Promise<void> {
		const artifacts = [...this.artifacts.entries()].filter(([, artifact]) => artifact.taskId === taskId);
		const dataset = this.datasets.get(taskId);
		this.datasets.delete(taskId);
		for (const [artifactId] of artifacts) {
			this.artifacts.delete(artifactId);
		}
		await Promise.all([
			...artifacts.map(([, artifact]) => rm(artifact.path, { force: true })),
			dataset ? rm(dataset.path, { force: true }) : Promise.resolve(),
		]);
	}

	async discardAll(): Promise<void> {
		const artifacts = [...this.artifacts.values()];
		const datasets = [...this.datasets.values()];
		this.artifacts.clear();
		this.datasets.clear();
		await Promise.all([
			...artifacts.map((artifact) => rm(artifact.path, { force: true })),
			...datasets.map((dataset) => rm(dataset.path, { force: true })),
		]);
	}

	hasPendingForTask(taskId: string): boolean {
		return [...this.artifacts.values()].some((artifact) => artifact.taskId === taskId);
	}

	listPending(): ArtifactDescriptor[] {
		return [...this.artifacts.values()].map((artifact) => artifact.descriptor);
	}

	private async getOrCreateDataset(taskId: string): Promise<ProductDataset> {
		const existing = this.datasets.get(taskId);
		if (existing) return existing;
		const workspace = this.workspaces.get(taskId);
		if (!workspace) throw new AgentWError("EXPORT_FAILED", "Task workspace is unavailable");
		const id = randomUUID();
		const dataset: ProductDataset = {
			count: 0,
			id,
			path: join(workspace, `${id}.json.part`),
			seen: new Set(),
			taskId,
		};
		await writeFile(dataset.path, "[", { encoding: "utf8", flag: "wx" });
		this.datasets.set(taskId, dataset);
		return dataset;
	}
}
