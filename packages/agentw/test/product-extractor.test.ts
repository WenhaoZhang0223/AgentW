import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { extractProducts } from "../src/edge/product-extractor.ts";
import { normalizeProducts } from "../src/shared/product.ts";

describe("product extraction", () => {
	it("prefers Product JSON-LD and marks a missing production date", () => {
		const window = new Window({ url: "https://shop.test/page-1" });
		window.document.body.innerHTML = `
			<script type="application/ld+json">
			{"@context":"https://schema.org","@type":"Product","name":"Tea","url":"/tea","offers":{"@type":"Offer","price":"12.50","priceCurrency":"USD"}}
			</script>`;

		const records = extractProducts(window.document as unknown as Document, 1, "2026-07-23T10:00:00+01:00");

		expect(records[0]).toMatchObject({
			name: "Tea",
			price: "USD 12.50",
			productionDate: "网页未提供",
			url: "https://shop.test/tea",
			sourcePage: 1,
		});
	});

	it("extracts a visible product card and its production date", () => {
		const window = new Window({ url: "https://shop.test/page-1" });
		window.document.body.innerHTML = `
			<article class="product-card">
				<a href="/coffee">Coffee Beans</a>
				<span class="price">£8.00</span>
				<span class="packaging">500 g</span>
				<span>生产日期：2026-07-01</span>
			</article>`;

		const records = extractProducts(window.document as unknown as Document, 1, "captured");

		expect(records).toContainEqual({
			name: "Coffee Beans",
			packaging: "500 g",
			price: "£8.00",
			productionDate: "2026-07-01",
			url: "https://shop.test/coffee",
			sourcePage: 1,
			capturedAt: "captured",
		});
	});

	it("preserves a comma-decimal euro price and extracts packaging from card text", () => {
		const window = new Window({ url: "https://shop.test/search" });
		window.document.body.innerHTML = `
			<article class="product-card">
				<a href="/milk">Whole Milk</a>
				<span>1 l</span>
				<span>0,89 €</span>
			</article>`;

		const records = extractProducts(window.document as unknown as Document, 1, "captured");

		expect(records[0]).toMatchObject({ name: "Whole Milk", packaging: "1 l", price: "0,89 €" });
	});

	it("extracts a BILLA tile without treating its product grid as a product", () => {
		const window = new Window({ url: "https://shop.billa.at/suche/Schokolade" });
		window.document.body.innerHTML = `
			<div class="ws-product-grid">
				<h1>Suche "Schokolade"</h1>
				<ul data-test="product-grid-list">
					<li class="ws-product-item-base ws-product-tile" data-test="product-tile">
						<a href="/produkte/clever-alpenvollmilch-schokolade-00769715" data-test="product-tile-link">
							Clever Alpenvollmilch Schokolade
						</a>
						<h3 data-test="product-title">Clever Alpenvollmilch Schokolade</h3>
						<ul data-test="product-information-piece-description"><li>100 g Tafel</li></ul>
						<div data-test="product-price-type-value">
							<span class="d-sr-only">0,89 €</span>
							<span aria-hidden="true">0</span><span aria-hidden="true">89 €</span>
						</div>
					</li>
				</ul>
			</div>`;

		const records = extractProducts(window.document as unknown as Document, 1, "captured");

		expect(records).toEqual([
			{
				name: "Clever Alpenvollmilch Schokolade",
				packaging: "100 g Tafel",
				price: "0,89 €",
				productionDate: "网页未提供",
				url: "https://shop.billa.at/produkte/clever-alpenvollmilch-schokolade-00769715",
				sourcePage: 1,
				capturedAt: "captured",
			},
		]);
	});

	it("extracts only Amazon search results and canonicalizes sponsored product URLs", () => {
		const window = new Window({ url: "https://www.amazon.ie/s?k=tea" });
		window.document.body.innerHTML = `
			<ul aria-label="Sponsored carousel">
				<li>
					<a href="/dp/B000000000">Carousel item</a>
					<span class="price">€99.00</span>
				</li>
			</ul>
			<div role="listitem" data-asin="B000MQCAKQ">
				<a class="a-link-normal" href="/Yorkshire-Tea/dp/B000MQCAKQ/ref=sr_1_1">Product image</a>
				<h2><a href="/Yorkshire-Tea/dp/B000MQCAKQ/ref=sr_1_1"><span>Yorkshire Tea, 80 Tea Bags</span></a></h2>
				<span class="a-price"><span class="a-offscreen">€5.49</span></span>
			</div>
			<div data-csa-c-type="item" data-asin="B0051T3R14">
				<h2>
					<a href="/sspa/click?url=%2FAhmad-Tea%2Fdp%2FB0051T3R14%2Fref%3Dsr_1_2">
						<span>Ahmad Tea Camomile, Pack of 20</span>
					</a>
				</h2>
				<span class="a-price"><span class="a-offscreen">€3.01</span></span>
			</div>`;

		const records = extractProducts(window.document as unknown as Document, 1, "captured");

		expect(records).toMatchObject([
			{
				name: "Yorkshire Tea, 80 Tea Bags",
				packaging: "80 Tea Bags",
				price: "€5.49",
				url: "https://www.amazon.ie/dp/B000MQCAKQ",
			},
			{
				name: "Ahmad Tea Camomile, Pack of 20",
				packaging: "Pack of 20",
				price: "€3.01",
				url: "https://www.amazon.ie/dp/B0051T3R14",
			},
		]);
	});

	it("groups separate Amazon title and price links by canonical ASIN without a card selector", () => {
		const window = new Window({ url: "https://www.amazon.ie/s?k=tea" });
		window.document.body.innerHTML = `
			<section class="carousel">
				<a href="/Carousel-Tea/dp/B000000000/ref=carousel">Carousel Tea</a>
				<a href="/Carousel-Tea/dp/B000000000/ref=carousel">
					<span class="a-price"><span class="a-offscreen">€99.00</span></span>
				</a>
			</section>
			<section class="new-search-layout">
				<a href="/Twinings-Wind-Down/dp/B0BT1TL7LC/ref=sr_1_1">
					Twinings Wind Down Collection Tea Selection, 20 Tea Bags
				</a>
				<a href="/Twinings-Wind-Down/dp/B0BT1TL7LC/ref=sr_1_1">
					<span class="a-price"><span class="a-offscreen">€5.90</span></span>
				</a>
				<a href="/sspa/click?url=%2FClipper-Natural%2Fdp%2FB0ABCDE123%2Fref%3Dsr_1_2">
					Clipper Natural Organic Tea, 45 Unbleached Sachets
				</a>
				<a href="/sspa/click?url=%2FClipper-Natural%2Fdp%2FB0ABCDE123%2Fref%3Dsr_1_2">
					<span class="a-price"><span class="a-offscreen">€15.08</span></span>
				</a>
			</section>`;

		const records = extractProducts(window.document as unknown as Document, 1, "captured");

		expect(records).toMatchObject([
			{
				name: "Twinings Wind Down Collection Tea Selection, 20 Tea Bags",
				packaging: "20 Tea Bags",
				price: "€5.90",
				url: "https://www.amazon.ie/dp/B0BT1TL7LC",
			},
			{
				name: "Clipper Natural Organic Tea, 45 Unbleached Sachets",
				packaging: "45 Unbleached Sachets",
				price: "€15.08",
				url: "https://www.amazon.ie/dp/B0ABCDE123",
			},
		]);
		expect(records.some((record) => record.name === "Carousel Tea")).toBe(false);
	});

	it("infers product cards from nearby links, names, prices and packaging on an unknown site", () => {
		const window = new Window({ url: "https://catalog.test/search?q=coffee" });
		window.document.body.innerHTML = `
			<header><a href="/shipping">Shipping information</a></header>
			<main class="modern-results-layout">
				<div class="entry-a8f31">
					<a href="/catalog/organic-coffee"><h5>Organic Coffee Beans</h5></a>
					<span>500 g</span>
					<span class="current-price-a8f31">$12.40</span>
				</div>
				<div class="entry-b2d17">
					<a href="/catalog/green-tea"><span class="name">Sencha Green Tea</span></a>
					<span>20 biodegradable tea bags</span>
					<span class="money-price-b2d17">$8.25</span>
				</div>
			</main>`;

		const records = extractProducts(window.document as unknown as Document, 1, "captured");

		expect(records).toMatchObject([
			{
				name: "Organic Coffee Beans",
				packaging: "500 g",
				price: "$12.40",
				url: "https://catalog.test/catalog/organic-coffee",
			},
			{
				name: "Sencha Green Tea",
				packaging: "20 biodegradable tea bags",
				price: "$8.25",
				url: "https://catalog.test/catalog/green-tea",
			},
		]);
		expect(records.some((record) => record.name === "Shipping information")).toBe(false);
	});

	it("extracts Taobao and Tmall cards while ignoring identity text", () => {
		const window = new Window({ url: "https://s.taobao.com/search?q=%E5%B0%8F%E5%90%83&page=1" });
		window.document.body.innerHTML = `
			<div class="baxia-dialog">التحقق السريع من الهوية أنا إنسان أنا ذكاء اصطناعي</div>
			<div data-name="itemNT">
				<a href="https://detail.tmall.com/item.htm?id=123&spm=tracking">
					<div class="Title--abc"><span title="内蒙古牛板筋小包装休闲零食"></span></div>
					<span>袋装 400g</span>
					<span class="priceInt--abc">19</span><span class="priceFloat--abc">.9</span>
				</a>
			</div>
			<a class="doubleCardWrapperAdapt--def" href="https://item.taobao.com/item.htm?id=456&from=search">
				<div class="title--def">乳酸菌小口袋面包</div>
				<span>独立包装</span>
				<span class="priceWrapper--def">￥ 14 .32</span>
			</a>`;

		const records = extractProducts(window.document as unknown as Document, 1, "captured");

		expect(records).toEqual([
			{
				name: "内蒙古牛板筋小包装休闲零食",
				packaging: "袋装 400g",
				price: "¥19.9",
				productionDate: "网页未提供",
				url: "https://detail.tmall.com/item.htm?id=123",
				sourcePage: 1,
				capturedAt: "captured",
			},
			{
				name: "乳酸菌小口袋面包",
				packaging: "独立包装",
				price: "￥14.32",
				productionDate: "网页未提供",
				url: "https://item.taobao.com/item.htm?id=456",
				sourcePage: 1,
				capturedAt: "captured",
			},
		]);
	});

	it("deduplicates by absolute product URL", () => {
		const deduped = normalizeProducts([
			{
				name: "Tea",
				price: "$1",
				productionDate: "网页未提供",
				url: "https://shop.test/tea",
				sourcePage: 1,
				capturedAt: "x",
			},
			{
				name: "Tea",
				price: "$1",
				productionDate: "网页未提供",
				url: "https://shop.test/tea",
				sourcePage: 2,
				capturedAt: "x",
			},
		]);

		expect(deduped).toHaveLength(1);
		expect(deduped[0]?.sourcePage).toBe(1);
	});

	it("combines the two fixture pages without duplicate product URLs", async () => {
		const first = new Window({ url: "https://shop.test/page-1.html" });
		const second = new Window({ url: "https://shop.test/page-2.html" });
		const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "fixtures/shop");
		first.document.write(await readFile(join(fixtureRoot, "page-1.html"), "utf8"));
		second.document.write(await readFile(join(fixtureRoot, "page-2.html"), "utf8"));

		const records = normalizeProducts([
			...extractProducts(first.document as unknown as Document, 1, "one"),
			...extractProducts(second.document as unknown as Document, 2, "two"),
		]);

		expect(records.filter((record) => record.url.endsWith("/products/shared-coffee"))).toHaveLength(1);
		expect(records.some((record) => record.productionDate === "2026-07-01")).toBe(true);
	});
});
