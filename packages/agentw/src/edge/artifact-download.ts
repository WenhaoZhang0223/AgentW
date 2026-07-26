import type { ArtifactDescriptor } from "../shared/product.ts";

const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;

interface PendingArtifactDownload {
	descriptor: ArtifactDescriptor;
	chunks: Map<number, Uint8Array>;
	totalBytes: number;
}

function decodeBase64(data: string): Uint8Array {
	const decoded = atob(data);
	const bytes = new Uint8Array(decoded.length);
	for (let index = 0; index < decoded.length; index++) {
		bytes[index] = decoded.charCodeAt(index);
	}
	return bytes;
}

function toHex(bytes: ArrayBuffer): string {
	return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export class ArtifactDownloads {
	private readonly pending = new Map<string, PendingArtifactDownload>();

	begin(descriptor: ArtifactDescriptor): void {
		if (
			!Number.isSafeInteger(descriptor.size) ||
			descriptor.size < 0 ||
			descriptor.size > MAX_ARTIFACT_BYTES ||
			!/^[a-f0-9]{64}$/i.test(descriptor.sha256)
		) {
			throw new Error("Invalid artifact descriptor");
		}
		this.pending.set(descriptor.id, { descriptor, chunks: new Map(), totalBytes: 0 });
	}

	addChunk(artifactId: string, index: number, data: string): void {
		const download = this.pending.get(artifactId);
		if (!download || !Number.isSafeInteger(index) || index < 0 || download.chunks.has(index)) {
			throw new Error("Invalid artifact chunk");
		}
		const bytes = decodeBase64(data);
		if (download.totalBytes + bytes.byteLength > download.descriptor.size) {
			throw new Error("Artifact exceeds declared size");
		}
		download.chunks.set(index, bytes);
		download.totalBytes += bytes.byteLength;
	}

	cancel(artifactId: string): void {
		this.pending.delete(artifactId);
	}

	async complete(artifactId: string): Promise<Uint8Array> {
		const download = this.pending.get(artifactId);
		if (!download) {
			throw new Error("Artifact download was not started");
		}
		this.pending.delete(artifactId);
		const bytes = new Uint8Array(download.totalBytes);
		let offset = 0;
		for (let index = 0; index < download.chunks.size; index++) {
			const chunk = download.chunks.get(index);
			if (!chunk) {
				throw new Error("Artifact download is incomplete");
			}
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		if (bytes.byteLength !== download.descriptor.size) {
			throw new Error("Artifact size mismatch");
		}
		const sha256 = toHex(await crypto.subtle.digest("SHA-256", bytes));
		if (sha256 !== download.descriptor.sha256.toLowerCase()) {
			throw new Error("Artifact checksum mismatch");
		}
		return bytes;
	}
}
