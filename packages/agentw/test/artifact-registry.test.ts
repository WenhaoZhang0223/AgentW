import { describe, expect, it } from "vitest";
import { ArtifactRegistry } from "../src/edge/artifact-registry.ts";

describe("artifact registry", () => {
	it("retains artifacts until the download is acknowledged", () => {
		const registry = new ArtifactRegistry();
		registry.upsert({ id: "a1", name: "products.xlsx", size: 120, sha256: "abc" });

		expect(registry.list()).toEqual([{ id: "a1", name: "products.xlsx", size: 120, sha256: "abc" }]);

		registry.remove("a1");
		expect(registry.list()).toEqual([]);
	});
});
