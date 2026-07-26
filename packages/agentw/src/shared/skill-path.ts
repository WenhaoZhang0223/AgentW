const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const WINDOWS_FORBIDDEN_CHARACTER = /[<>:"|?*\u0000-\u001f]/;

export function normalizeSkillRelativePath(input: string): string | undefined {
	if (!input) return undefined;
	const normalized = input.replaceAll("\\", "/");
	if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) return undefined;
	const segments = normalized.split("/");
	if (
		segments.some(
			(segment) =>
				segment.length === 0 ||
				segment === "." ||
				segment === ".." ||
				segment.endsWith(".") ||
				segment.endsWith(" ") ||
				WINDOWS_FORBIDDEN_CHARACTER.test(segment) ||
				WINDOWS_RESERVED_NAME.test(segment),
		)
	) {
		return undefined;
	}
	return segments.join("/");
}
