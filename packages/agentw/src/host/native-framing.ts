import { AgentWError } from "../shared/errors.ts";
import { type AgentWEnvelope, MAX_NATIVE_MESSAGE_BYTES, parseEnvelope } from "../shared/protocol.ts";

const HEADER_BYTES = 4;

export function encodeNativeMessage(envelope: AgentWEnvelope): Buffer {
	const payload = Buffer.from(JSON.stringify(envelope), "utf8");
	if (payload.byteLength > MAX_NATIVE_MESSAGE_BYTES) {
		throw new AgentWError("MESSAGE_TOO_LARGE");
	}
	const header = Buffer.allocUnsafe(HEADER_BYTES);
	header.writeUInt32LE(payload.byteLength, 0);
	return Buffer.concat([header, payload]);
}

export class NativeMessageReader {
	private buffered = Buffer.alloc(0);

	push(chunk: Uint8Array): AgentWEnvelope[] {
		this.buffered = Buffer.concat([this.buffered, Buffer.from(chunk)]);
		const messages: AgentWEnvelope[] = [];

		while (this.buffered.byteLength >= HEADER_BYTES) {
			const length = this.buffered.readUInt32LE(0);
			if (length > MAX_NATIVE_MESSAGE_BYTES) {
				throw new AgentWError("MESSAGE_TOO_LARGE");
			}
			const frameBytes = HEADER_BYTES + length;
			if (this.buffered.byteLength < frameBytes) {
				break;
			}
			const payload = this.buffered.subarray(HEADER_BYTES, frameBytes);
			this.buffered = this.buffered.subarray(frameBytes);
			messages.push(parseEnvelope(JSON.parse(payload.toString("utf8"))));
		}

		return messages;
	}
}
