import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { createPageSnapshot, PageElementRegistry } from "../src/edge/page-snapshot.ts";
import { encodeNativeMessage } from "../src/host/native-framing.ts";
import { createEnvelope } from "../src/shared/protocol.ts";

describe("createPageSnapshot", () => {
	it("keeps visible text and links while excluding scripts and password values", async () => {
		const window = new Window({ url: "https://shop.test/page-1" });
		window.document.body.innerHTML = `
			<main>
				<a href="/p/1">Product One</a>
				<label for="search">Search products</label>
				<input id="search" name="q" type="search">
				<input type="password" value="secret">
				<p hidden>hidden text</p>
			</main>
			<script>ignore me</script>`;
		const registry = new PageElementRegistry();

		const snapshot = await createPageSnapshot(
			window.document as unknown as Document,
			window.location as unknown as Location,
			registry,
		);

		expect(snapshot.text).toContain("Product One");
		expect(snapshot.text).not.toContain("hidden text");
		expect(snapshot.links[0]?.url).toBe("https://shop.test/p/1");
		expect(registry.get(snapshot.links[0]?.ref ?? "")).toBe(window.document.querySelector("a"));
		expect(snapshot.fields).toMatchObject([{ label: "Search products", type: "search" }]);
		expect(registry.get(snapshot.fields[0]?.ref ?? "")).toBe(window.document.querySelector("#search"));
		expect(JSON.stringify(snapshot)).not.toContain("secret");
		expect(JSON.stringify(snapshot)).not.toContain("ignore me");
	});

	it("keeps a link-heavy snapshot below the Native Messaging frame limit", async () => {
		const window = new Window({ url: "https://shop.test/page-1" });
		window.document.body.innerHTML = `${"商".repeat(200_000)}${Array.from(
			{ length: 1_000 },
			(_, index) => `<a href="/${"p".repeat(1_000)}${index}">${"链接".repeat(100)}</a>`,
		).join("")}`;
		const snapshot = await createPageSnapshot(
			window.document as unknown as Document,
			window.location as unknown as Location,
		);

		expect(() =>
			encodeNativeMessage(
				createEnvelope("request-1", "task-1", {
					type: "browser.result",
					commandId: "command-1",
					result: { type: "browser.snapshot", ...snapshot },
				}),
			),
		).not.toThrow();
	});
});
