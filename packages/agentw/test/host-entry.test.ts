import { describe, expect, it } from "vitest";
import { resolveHostExtensionPath, shouldRunNativeHost } from "../src/host/main.ts";

describe("compiled Native Host entry", () => {
	it("starts inside Bun even though import.meta.url uses the virtual filesystem", () => {
		expect(
			shouldRunNativeHost({
				argv0: "bun",
				argv1: "B:\\~BUN\\root\\agentw-host.exe",
				execPath: "C:\\AgentW\\agentw-host.exe",
				isBun: true,
				moduleUrl: "file:///B:/%7EBUN/root/agentw-host.exe",
			}),
		).toBe(true);
	});

	it("does not start when Bun is directly executing the source module", () => {
		expect(
			shouldRunNativeHost({
				argv0: "C:\\Tools\\bun.exe",
				argv1: "C:\\AgentW\\src\\host\\main.ts",
				execPath: "C:\\Tools\\bun.exe",
				isBun: true,
				moduleUrl: "file:///C:/AgentW/src/host/main.ts",
			}),
		).toBe(false);
	});

	it("locates the external Pi extension beside the compiled Host", () => {
		expect(
			resolveHostExtensionPath({
				execPath: "C:\\AgentW\\agentw-host.exe",
				isBun: true,
				moduleUrl: "file:///$bunfs/root/main.js",
			}),
		).toBe("C:\\AgentW\\pi-extension\\index.js");
	});
});
