import type { ArtifactDescriptor } from "../shared/product.ts";

export class ArtifactRegistry {
	private readonly artifacts = new Map<string, ArtifactDescriptor>();

	upsert(artifact: ArtifactDescriptor): void {
		this.artifacts.set(artifact.id, artifact);
	}

	remove(artifactId: string): void {
		this.artifacts.delete(artifactId);
	}

	clear(): void {
		this.artifacts.clear();
	}

	list(): ArtifactDescriptor[] {
		return [...this.artifacts.values()];
	}
}
