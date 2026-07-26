import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, parseEnvelope } from "../src/shared/protocol.ts";

describe("parseEnvelope", () => {
	it("accepts a versioned prompt", () => {
		const value = parseEnvelope({
			protocolVersion: PROTOCOL_VERSION,
			requestId: "request-1",
			taskId: "task-1",
			message: { type: "chat.prompt", text: "提取两页商品" },
		});

		expect(value.message).toEqual({ type: "chat.prompt", text: "提取两页商品" });
	});

	it("accepts an artifact recovery request", () => {
		const value = parseEnvelope({
			protocolVersion: PROTOCOL_VERSION,
			requestId: "request-2",
			taskId: "task-2",
			message: { type: "artifact.list" },
		});

		expect(value.message).toEqual({ type: "artifact.list" });
	});

	it("rejects an unsupported protocol version", () => {
		expect(() =>
			parseEnvelope({
				protocolVersion: 2,
				requestId: "request-1",
				taskId: "task-1",
				message: { type: "chat.abort" },
			}),
		).toThrow("UNSUPPORTED_PROTOCOL");
	});

	it("rejects an unknown message type", () => {
		expect(() =>
			parseEnvelope({
				protocolVersion: PROTOCOL_VERSION,
				requestId: "request-1",
				taskId: "task-1",
				message: { type: "unknown" },
			}),
		).toThrow("INVALID_MESSAGE");
	});
});
