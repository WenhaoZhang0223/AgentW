import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { PageActionRegistry } from "../src/edge/page-actions.ts";

describe("PageActionRegistry", () => {
	it("clicks one interactive element by exact visible text", () => {
		const window = new Window({ url: "https://example.test/" });
		window.document.body.innerHTML = `<button type="button">About</button>`;
		let clicked = false;
		window.document.querySelector("button")?.addEventListener("click", () => {
			clicked = true;
		});
		const actions = new PageActionRegistry(
			window.document as unknown as Document,
			window.location as unknown as Location,
		);

		actions.clickByText("About");

		expect(clicked).toBe(true);
	});

	it("clicks an exact visible label inside a JavaScript-driven card", () => {
		const window = new Window({ url: "https://jobs.test/" });
		window.document.body.innerHTML = `<div class="job-card"><span>AI Agent Engineer</span></div>`;
		let clicked = false;
		window.document.querySelector("span")?.addEventListener("click", () => {
			clicked = true;
		});
		const actions = new PageActionRegistry(
			window.document as unknown as Document,
			window.location as unknown as Location,
		);

		actions.clickByText("AI Agent Engineer");

		expect(clicked).toBe(true);
	});

	it("refuses an ambiguous visible-text click", () => {
		const window = new Window({ url: "https://example.test/" });
		window.document.body.innerHTML = `<button>Open</button><button>Open</button>`;
		const actions = new PageActionRegistry(
			window.document as unknown as Document,
			window.location as unknown as Location,
		);

		expect(() => actions.clickByText("Open")).toThrow('More than one visible element is named "Open"');
	});

	it("identifies, fills and submits a Taobao-style search form", () => {
		const window = new Window({ url: "https://www.taobao.com/" });
		window.document.body.innerHTML = `
			<form class="newsletter"><input type="text" placeholder="Email"><button type="submit">Subscribe</button></form>
			<form class="site-search" action="/s">
				<input id="q" name="q" type="text" placeholder="搜索商品">
				<button type="submit">搜索</button>
			</form>`;
		const searchInput = window.document.querySelector("#q") as unknown as HTMLInputElement | null;
		let submitted = false;
		window.document.querySelector(".site-search button")?.addEventListener("click", (event) => {
			event.preventDefault();
			submitted = true;
		});
		const actions = new PageActionRegistry(
			window.document as unknown as Document,
			window.location as unknown as Location,
		);

		actions.search("宽松衣服");

		expect(searchInput?.value).toBe("宽松衣服");
		expect(submitted).toBe(true);
		const newsletterInput = window.document.querySelector(".newsletter input") as unknown as HTMLInputElement | null;
		expect(newsletterInput?.value).toBe("");
	});

	it("submits a semantic search box with Enter when there is no button or form", () => {
		const window = new Window({ url: "https://catalog.test/" });
		window.document.body.innerHTML = `<div role="searchbox" contenteditable="true" aria-label="Find articles"></div>`;
		const field = window.document.querySelector('[role="searchbox"]') as unknown as HTMLElement | null;
		let enterPressed = false;
		field?.addEventListener("keydown", (event: Event) => {
			if ((event as KeyboardEvent).key === "Enter") enterPressed = true;
		});
		const actions = new PageActionRegistry(
			window.document as unknown as Document,
			window.location as unknown as Location,
		);

		actions.search("browser agents");

		expect(field?.textContent).toBe("browser agents");
		expect(enterPressed).toBe(true);
	});

	it("does not mistake a login field for a site search box", () => {
		const window = new Window({ url: "https://account.test/login" });
		window.document.body.innerHTML = `
			<form action="/login">
				<input name="email" type="email" placeholder="Email">
				<button type="submit">Sign in</button>
			</form>`;
		const actions = new PageActionRegistry(
			window.document as unknown as Document,
			window.location as unknown as Location,
		);

		expect(() => actions.search("宽松衣服")).toThrow("No visible search field was found");
	});

	it("types into a field reference from the latest snapshot", async () => {
		const window = new Window({ url: "https://example.test/" });
		window.document.body.innerHTML = `<label for="message">Message</label><textarea id="message"></textarea>`;
		const actions = new PageActionRegistry(
			window.document as unknown as Document,
			window.location as unknown as Location,
		);
		const snapshot = await actions.inspect();

		actions.typeText(snapshot.fields[0]?.ref ?? "", "Hello", false);

		const textarea = window.document.querySelector("textarea") as unknown as HTMLTextAreaElement | null;
		expect(textarea?.value).toBe("Hello");
	});

	it("rejects a stale registered element", async () => {
		const window = new Window({ url: "https://shop.test/page-1" });
		window.document.body.innerHTML = `<a rel="next" href="/page-2">Next</a>`;
		const actions = new PageActionRegistry(
			window.document as unknown as Document,
			window.location as unknown as Location,
		);
		const snapshot = await actions.inspect();
		window.document.querySelector("a")?.remove();

		expect(() => actions.click(snapshot.links[0]?.ref ?? "")).toThrow("STALE_ELEMENT_REFERENCE");
	});

	it("does not navigate through a visible CAPTCHA challenge", async () => {
		const window = new Window({ url: "https://shop.test/page-1" });
		window.document.body.innerHTML = `
			<div class="captcha">Complete CAPTCHA</div>
			<a rel="next" href="/page-2">Next</a>`;
		const actions = new PageActionRegistry(
			window.document as unknown as Document,
			window.location as unknown as Location,
		);

		await expect(actions.nextPage()).rejects.toThrow("PAGE_REQUIRES_USER_ACTION");
	});

	it("ignores a hidden login form and clicks a BILLA-style next-page link", async () => {
		const window = new Window({ url: "https://shop.billa.at/suche/Schokolade" });
		window.document.body.innerHTML = `
			<form style="display: none"><input type="password"></form>
			<nav aria-label="Seitennavigation zur Auswahl von Seiten">
				<a href="#" aria-current="page">1</a>
				<li data-test="pagination-next">
					<a href="/suche/Schokolade?page=2" aria-label="Nächste Seite">
						<span aria-hidden="true">chevron_right</span>
					</a>
				</li>
			</nav>`;
		const next = window.document.querySelector('[aria-label="Nächste Seite"]') as unknown as HTMLAnchorElement | null;
		let clicked = false;
		next?.addEventListener("click", (event: Event) => {
			event.preventDefault();
			clicked = true;
		});
		const actions = new PageActionRegistry(
			window.document as unknown as Document,
			window.location as unknown as Location,
		);

		await actions.nextPage();

		expect(clicked).toBe(true);
	});

	it("prefers the Amazon result paginator over a product carousel", async () => {
		const window = new Window({ url: "https://www.amazon.ie/s?k=tea" });
		window.document.body.innerHTML = `
			<section aria-label="Products related to this item">
				<button aria-label="Next page">Next page</button>
			</section>
			<span class="s-pagination-strip">
				<a class="s-pagination-item s-pagination-next" href="/s?k=tea&page=2">Next</a>
			</span>`;
		let carouselClicked = false;
		let paginatorClicked = false;
		window.document.querySelector("button")?.addEventListener("click", () => {
			carouselClicked = true;
		});
		window.document.querySelector(".s-pagination-next")?.addEventListener("click", (event) => {
			event.preventDefault();
			paginatorClicked = true;
		});
		const actions = new PageActionRegistry(
			window.document as unknown as Document,
			window.location as unknown as Location,
		);

		await actions.nextPage();

		expect(paginatorClicked).toBe(true);
		expect(carouselClicked).toBe(false);
	});

	it("clicks the Taobao next-pagination control", async () => {
		const window = new Window({ url: "https://s.taobao.com/search?q=snacks&page=1" });
		window.document.body.innerHTML = `
			<div class="next-pagination">
				<button class="next-btn next-pagination-item next-next" aria-label="下一页">
					下一页
				</button>
			</div>`;
		let clicked = false;
		window.document.querySelector("button")?.addEventListener("click", () => {
			clicked = true;
		});
		const actions = new PageActionRegistry(
			window.document as unknown as Document,
			window.location as unknown as Location,
		);

		await actions.nextPage();

		expect(clicked).toBe(true);
	});

	it("falls back to the numeric page after the current page", async () => {
		const window = new Window({ url: "https://shop.test/search?page=3" });
		window.document.body.innerHTML = `
			<nav aria-label="Pagination">
				<button aria-current="page">3</button>
				<button>4</button>
			</nav>`;
		const next = [...window.document.querySelectorAll("button")][1];
		let clicked = false;
		next?.addEventListener("click", () => {
			clicked = true;
		});
		const actions = new PageActionRegistry(
			window.document as unknown as Document,
			window.location as unknown as Location,
		);

		await actions.nextPage();

		expect(clicked).toBe(true);
	});
});
