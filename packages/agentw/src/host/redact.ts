const SENSITIVE_KEY_PATTERN = /(api[-_]?key|authorization|cookie|password|token|secret)/i;

export function redactDiagnostic(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => redactDiagnostic(item));
	}
	if (!value || typeof value !== "object") {
		return value;
	}

	const clone: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		clone[key] = SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : redactDiagnostic(item);
	}
	return clone;
}
