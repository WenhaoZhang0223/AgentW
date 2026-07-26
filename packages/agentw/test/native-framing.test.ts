import { describe, expect, it } from "vitest";
import { encodeNativeMessage, NativeMessageReader } from "../src/host/native-framing.ts";
import { MAX_PRODUCT_RECORDS } from "../src/shared/product.ts";
import { type AgentWEnvelope, PROTOCOL_VERSION } from "../src/shared/protocol.ts";

const envelope: AgentWEnvelope = {
	protocolVersion: PROTOCOL_VERSION,
	requestId: "r1",
	taskId: "t1",
	message: { type: "chat.abort" },
};

describe("Native Messaging framing", () => {
	it("decodes a frame split across chunks", () => {
		const encoded = encodeNativeMessage(envelope);
		const reader = new NativeMessageReader();

		expect(reader.push(encoded.subarray(0, 3))).toEqual([]);
		expect(reader.push(encoded.subarray(3))).toEqual([envelope]);
	});

	it("decodes multiple frames from one chunk", () => {
		const encoded = Buffer.concat([encodeNativeMessage(envelope), encodeNativeMessage(envelope)]);

		expect(new NativeMessageReader().push(encoded)).toEqual([envelope, envelope]);
	});

	it("rejects payloads over 512 KiB", () => {
		const header = Buffer.alloc(4);
		header.writeUInt32LE(512 * 1024 + 1);

		expect(() => new NativeMessageReader().push(header)).toThrow("MESSAGE_TOO_LARGE");
	});

	it("encodes the maximum normalized product result below the frame limit", () => {
		const records = Array.from({ length: MAX_PRODUCT_RECORDS }, (_, index) => ({
			name: "商".repeat(256),
			price: "价".repeat(64),
			productionDate: "日".repeat(64),
			url: `https://shop.test/${"p".repeat(1_000)}${index}`,
			sourcePage: 10,
			capturedAt: "2".repeat(64),
		}));

		expect(() =>
			encodeNativeMessage({
				...envelope,
				message: {
					type: "browser.result",
					commandId: "command-1",
					result: { type: "browser.products", records, fingerprint: "f" },
				},
			}),
		).not.toThrow();
	});
});
