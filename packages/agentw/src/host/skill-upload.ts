import { AgentWError } from "../shared/errors.ts";
import type { InstalledSkill } from "../shared/product.ts";
import { MAX_BINARY_CHUNK_BYTES } from "../shared/protocol.ts";
import type { SkillInstaller, SkillUploadFile } from "./skill-installer.ts";

export interface SkillUploadBegin {
	uploadId: string;
	format: "files" | "zip";
	totalBytes: number;
	overwrite: boolean;
}

export interface SkillUploadChunk {
	uploadId: string;
	index: number;
	data: string;
	relativePath?: string;
}

interface PendingUpload extends SkillUploadBegin {
	nextIndex: number;
	receivedBytes: number;
	zipChunks: Buffer[];
	fileChunks: Map<string, Buffer[]>;
}

const MAX_COMPRESSED_BYTES = 10 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 50 * 1024 * 1024;
const MAX_CONCURRENT_UPLOADS = 4;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export class SkillUploadManager {
	private readonly installer: SkillInstaller;
	private readonly uploads = new Map<string, PendingUpload>();

	constructor(installer: SkillInstaller) {
		this.installer = installer;
	}

	begin(input: SkillUploadBegin): void {
		const maximum = input.format === "zip" ? MAX_COMPRESSED_BYTES : MAX_EXPANDED_BYTES;
		if (
			!input.uploadId ||
			this.uploads.has(input.uploadId) ||
			this.uploads.size >= MAX_CONCURRENT_UPLOADS ||
			!Number.isSafeInteger(input.totalBytes) ||
			input.totalBytes <= 0 ||
			input.totalBytes > maximum
		) {
			throw new AgentWError("INVALID_MESSAGE", "Invalid Skill upload");
		}
		this.uploads.set(input.uploadId, {
			...input,
			nextIndex: 0,
			receivedBytes: 0,
			zipChunks: [],
			fileChunks: new Map(),
		});
	}

	addChunk(input: SkillUploadChunk): void {
		const upload = this.uploads.get(input.uploadId);
		try {
			if (!upload || input.index !== upload.nextIndex) {
				throw new AgentWError("INVALID_MESSAGE", "Invalid upload chunk sequence");
			}
			if (!input.data || !BASE64.test(input.data)) {
				throw new AgentWError("INVALID_MESSAGE", "Invalid upload chunk data");
			}
			const chunk = Buffer.from(input.data, "base64");
			if (chunk.byteLength === 0 || chunk.byteLength > MAX_BINARY_CHUNK_BYTES) {
				throw new AgentWError("MESSAGE_TOO_LARGE", "Invalid upload chunk size");
			}
			if (upload.receivedBytes + chunk.byteLength > upload.totalBytes) {
				throw new AgentWError("MESSAGE_TOO_LARGE", "Skill upload exceeds declared size");
			}
			if (upload.format === "zip") {
				if (input.relativePath !== undefined) {
					throw new AgentWError("INVALID_MESSAGE", "ZIP chunks cannot have a relative path");
				}
				upload.zipChunks.push(chunk);
			} else {
				if (!input.relativePath) {
					throw new AgentWError("INVALID_MESSAGE", "Directory chunks require a relative path");
				}
				const chunks = upload.fileChunks.get(input.relativePath) ?? [];
				chunks.push(chunk);
				upload.fileChunks.set(input.relativePath, chunks);
			}
			upload.receivedBytes += chunk.byteLength;
			upload.nextIndex++;
		} catch (error) {
			this.uploads.delete(input.uploadId);
			throw error;
		}
	}

	async finish(uploadId: string): Promise<InstalledSkill> {
		const upload = this.uploads.get(uploadId);
		this.uploads.delete(uploadId);
		if (!upload || upload.receivedBytes !== upload.totalBytes) {
			throw new AgentWError("INVALID_MESSAGE", "Skill upload is incomplete");
		}
		if (upload.format === "zip") {
			return this.installer.installZip(Buffer.concat(upload.zipChunks), { overwrite: upload.overwrite });
		}
		const files: SkillUploadFile[] = [...upload.fileChunks].map(([relativePath, chunks]) => ({
			relativePath,
			data: Buffer.concat(chunks),
		}));
		return this.installer.installFiles(files, { overwrite: upload.overwrite });
	}

	clear(): void {
		this.uploads.clear();
	}
}
