import type { ArtifactDescriptor } from "../shared/product.ts";

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function artifactDescriptor(value: unknown): ArtifactDescriptor | undefined {
	const candidate = record(value);
	if (
		typeof candidate.id !== "string" ||
		typeof candidate.name !== "string" ||
		typeof candidate.size !== "number" ||
		!Number.isSafeInteger(candidate.size) ||
		candidate.size < 0 ||
		typeof candidate.sha256 !== "string"
	) {
		return undefined;
	}
	return {
		id: candidate.id,
		name: candidate.name,
		size: candidate.size,
		sha256: candidate.sha256,
	};
}

export function artifactsFromAgentEvent(input: unknown): ArtifactDescriptor[] {
	const event = record(input);
	if (event.type !== "tool_execution_end") return [];
	const details = record(record(event.result).details);
	const artifacts = new Map<string, ArtifactDescriptor>();
	for (const candidate of [details, ...Object.values(details)]) {
		const artifact = artifactDescriptor(candidate);
		if (artifact) artifacts.set(artifact.id, artifact);
	}
	return [...artifacts.values()];
}
