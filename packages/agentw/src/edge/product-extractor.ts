import {
	MAX_PRODUCT_RECORDS,
	MISSING_PACKAGING,
	MISSING_PRODUCTION_DATE,
	normalizeProducts,
	type ProductRecord,
} from "../shared/product.ts";

const PRICE_PATTERN =
	/((?:USD|EUR|GBP|CNY|RMB|JPY|AUD|CAD|[$€£¥￥₹])\s*\d+(?:\s*[.,]\s*\d+)?|\d+(?:\s*[.,]\s*\d+)?\s*(?:USD|EUR|GBP|CNY|RMB|JPY|AUD|CAD|[$€£¥￥₹]))/i;
const DATE_PATTERN = /(?:生产日期|制造日期|MFG|Manufactured)\s*[:：]?\s*([0-9][0-9./-]{3,20})/i;
const PACKAGING_PATTERN =
	/((?:pack\s+of\s+\d+)|(?:\d+\s+(?:(?:[a-z-]+\s+){0,3})(?:bags?|sachets?))|(?:(?:\d+\s*[x×]\s*)?\d+(?:[.,]\d+)?\s*(?:ml|cl|l|mg|g|kg|oz|lb|pcs?|pieces?|packs?|bags?|bottles?|cans?)))(?:\b|$)/i;
const PACKAGING_KIND_PATTERN = /(独立包装|袋装|盒装|罐装|瓶装|散装|箱装|整箱|包装)/g;
const AMAZON_PRODUCT_LINK_SELECTOR = ['a[href*="/dp/"]', 'a[href*="/gp/product/"]', 'a[href*="/sspa/click"]'].join(
	", ",
);
const AMAZON_RESULT_SELECTOR = [
	'[data-component-type="s-search-result"][data-asin]:not([data-asin=""])',
	'[role="listitem"][data-asin]:not([data-asin=""])',
	'[data-csa-c-type="item"][data-asin]:not([data-asin=""])',
	'[class*="s-result-item"][data-asin]:not([data-asin=""])',
].join(", ");
const TAOBAO_RESULT_SELECTOR = ['a[href*="item.taobao.com/item.htm"]', 'a[href*="detail.tmall.com/item.htm"]'].join(
	", ",
);
const PRODUCT_CARD_SELECTOR = [
	AMAZON_RESULT_SELECTOR,
	TAOBAO_RESULT_SELECTOR,
	'[data-test="product-tile"]',
	'[data-testid="product-card"]',
	'[data-name="item"]',
	'[data-name="itemNT"]',
	"[data-product]",
	"article",
	"li",
	'[class~="product-card"]',
	'[class~="product_card"]',
	'[class~="product-tile"]',
	'[class~="product_tile"]',
	'[class~="product"]',
].join(", ");
const PRODUCT_LINK_SELECTOR = [
	'h2 a[href*="/dp/"]',
	'a.a-link-normal[href*="/dp/"]',
	'a[data-test="product-tile-link"][href]',
	'a[data-testid="product-link"][href]',
	'a[href*="item.taobao.com/item.htm"]',
	'a[href*="detail.tmall.com/item.htm"]',
	'a[href*="/products/"]',
	'a[href*="/product/"]',
	'a[href*="/produkte/"]',
	'a[href*="/item/"]',
	"a[href]",
].join(", ");
const PRODUCT_PRICE_SELECTOR = [
	".a-price .a-offscreen",
	'[data-test="product-price-type-value"] .d-sr-only',
	'[data-test="product-price-type-value"] [class*="sr-only"]',
	"[class*='priceWrapper']",
	"[itemprop='price']",
	"[data-price]",
	"[class*='price']",
	"[class*='Price']",
	".price",
].join(", ");
const PRODUCT_TITLE_SELECTOR = [
	"h2 a span",
	"h2 span",
	'[data-cy="title-recipe"]',
	'[class*="title"] span[title]',
	'[class*="Title"] span[title]',
	'[class*="title"][title]',
	'[class*="Title"][title]',
	'[class*="title--"]',
	'[class*="Title--"]',
	"[data-product-name]",
	'[data-testid*="title"]',
	'[class*="productName"]',
	'[class*="product-name"]',
	'[class~="name"]',
	"[data-name='title'] [title]",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"[itemprop='name']",
].join(", ");
const PRICE_INTEGER_SELECTOR = "[class*='priceInt'], [class*='PriceInt']";
const PRICE_FRACTION_SELECTOR = "[class*='priceFloat'], [class*='PriceFloat']";

function clean(value: unknown): string {
	return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function cleanPrice(value: unknown): string {
	return clean(value)
		.replace(/\s*([.,])\s*/g, "$1")
		.replace(/^([$€£¥￥₹])\s+/, "$1")
		.replace(/\s+(USD|EUR|GBP|CNY|RMB|JPY|AUD|CAD)$/i, " $1");
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function absoluteUrl(value: unknown, baseUrl: string): string {
	const candidate = clean(value);
	if (!candidate) return "";
	try {
		const url = new URL(candidate, baseUrl);
		return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
	} catch {
		return "";
	}
}

function isProductType(value: unknown): boolean {
	if (typeof value === "string") return value.toLowerCase().endsWith("product");
	return Array.isArray(value) && value.some((item) => isProductType(item));
}

function collectJsonLdProducts(value: unknown, output: Record<string, unknown>[]): void {
	if (Array.isArray(value)) {
		for (const item of value) collectJsonLdProducts(item, output);
		return;
	}
	const item = asRecord(value);
	if (Object.keys(item).length === 0) return;
	if (isProductType(item["@type"])) output.push(item);
	if (Array.isArray(item["@graph"])) collectJsonLdProducts(item["@graph"], output);
}

function jsonLdRecord(
	item: Record<string, unknown>,
	baseUrl: string,
	pageNumber: number,
	capturedAt: string,
): ProductRecord | undefined {
	const offersValue = Array.isArray(item.offers) ? item.offers[0] : item.offers;
	const offers = asRecord(offersValue);
	const rawPrice = clean(offers.price ?? item.price);
	const currency = clean(offers.priceCurrency ?? item.priceCurrency);
	const name = clean(item.name);
	if (!name) return undefined;
	return {
		name,
		packaging: clean(item.size ?? item.weight ?? item.packageQuantity) || MISSING_PACKAGING,
		price: currency && rawPrice ? `${currency} ${rawPrice}` : rawPrice,
		productionDate: clean(item.productionDate ?? item.dateCreated) || MISSING_PRODUCTION_DATE,
		url: absoluteUrl(item.url ?? item.mainEntityOfPage, baseUrl) || baseUrl,
		sourcePage: pageNumber,
		capturedAt,
	};
}

function propertyValue(root: Element, name: string): string {
	const element = root.querySelector(`[itemprop="${name}"]`);
	if (!element) return "";
	return clean(element.getAttribute("content") ?? element.getAttribute("href") ?? element.textContent);
}

function visible(element: Element): boolean {
	if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true") return false;
	const style = element.ownerDocument.defaultView?.getComputedStyle(element);
	return style?.display !== "none" && style?.visibility !== "hidden";
}

function microdataRecords(document: Document, pageNumber: number, capturedAt: string): ProductRecord[] {
	const records: ProductRecord[] = [];
	for (const item of document.querySelectorAll('[itemscope][itemtype*="Product"]')) {
		if (!visible(item)) continue;
		const name = propertyValue(item, "name");
		if (!name) continue;
		const price = propertyValue(item, "price");
		const currency = propertyValue(item, "priceCurrency");
		records.push({
			name,
			packaging:
				propertyValue(item, "size") ||
				propertyValue(item, "weight") ||
				propertyValue(item, "packageQuantity") ||
				extractVisiblePackaging(item.textContent ?? "") ||
				MISSING_PACKAGING,
			price: currency && price ? `${currency} ${price}` : price,
			productionDate:
				propertyValue(item, "productionDate") ||
				propertyValue(item, "dateCreated") ||
				extractVisibleDate(item.textContent ?? "") ||
				MISSING_PRODUCTION_DATE,
			url: absoluteUrl(propertyValue(item, "url"), document.baseURI) || document.baseURI,
			sourcePage: pageNumber,
			capturedAt,
		});
	}
	return records;
}

function extractVisibleDate(text: string): string {
	return clean(DATE_PATTERN.exec(text)?.[1]);
}

function extractVisiblePackaging(text: string): string {
	const amount = clean(PACKAGING_PATTERN.exec(text)?.[1]);
	const kinds = [...text.matchAll(PACKAGING_KIND_PATTERN)];
	const kind = clean(kinds.at(-1)?.[1]);
	return kind && amount ? `${kind} ${amount}` : kind || amount;
}

function productPrice(item: Element, text: string): string {
	const integer = clean(item.querySelector(PRICE_INTEGER_SELECTOR)?.textContent);
	const fraction = clean(item.querySelector(PRICE_FRACTION_SELECTOR)?.textContent);
	if (integer) return cleanPrice(`¥${integer}${fraction}`);
	const priceElement = item.querySelector(PRODUCT_PRICE_SELECTOR);
	const direct = cleanPrice(priceElement?.getAttribute("content") ?? priceElement?.textContent);
	return (
		cleanPrice(PRICE_PATTERN.exec(direct)?.[1]) ||
		(/^\d+(?:[.,]\d+)?$/.test(direct) ? direct : "") ||
		cleanPrice(PRICE_PATTERN.exec(text)?.[1])
	);
}

function productName(item: Element, link: HTMLAnchorElement): string {
	const heading = item.querySelector(PRODUCT_TITLE_SELECTOR);
	const titledDescendant = heading?.querySelector<HTMLElement>("[title]");
	const image = item.querySelector<HTMLImageElement>("img[alt]");
	return (
		clean(heading?.getAttribute("title") ?? titledDescendant?.getAttribute("title") ?? heading?.textContent) ||
		clean(image?.alt) ||
		clean(link.getAttribute("title")) ||
		clean(link.getAttribute("aria-label")) ||
		clean(link.textContent)
	);
}

function productUrl(value: string, baseUrl: string): string {
	const absolute = absoluteUrl(value, baseUrl);
	if (!absolute) return "";
	let url = new URL(absolute);
	if (/(^|\.)amazon\./i.test(url.hostname) && url.pathname === "/sspa/click") {
		const destination = url.searchParams.get("url");
		if (destination) {
			const resolved = absoluteUrl(destination, url.origin);
			if (resolved) url = new URL(resolved);
		}
	}
	if (/(^|\.)amazon\./i.test(url.hostname)) {
		const asin = /\/(?:dp|gp\/product)\/([a-z0-9]{10})(?:[/?]|$)/i.exec(url.pathname)?.[1];
		if (asin) return `${url.origin}/dp/${asin.toUpperCase()}`;
	}
	if (
		(url.hostname === "item.taobao.com" || url.hostname === "detail.tmall.com") &&
		url.pathname.endsWith("/item.htm")
	) {
		const id = url.searchParams.get("id");
		if (id) return `${url.origin}${url.pathname}?id=${encodeURIComponent(id)}`;
	}
	return absolute;
}

interface AmazonProductLinkGroup {
	anchors: HTMLAnchorElement[];
	searchResult: boolean;
	url: string;
}

function isProductNameCandidate(name: string): boolean {
	return (
		name.length >= 5 &&
		!/^(?:USD|EUR|GBP|CNY|RMB|JPY|AUD|CAD|[$€£¥￥₹])\s*\d/i.test(name) &&
		!/^(?:\(?[\d.,]+[Kk]?\)?|[\d.,]+\s+out of\s+5|Options?:|\d+\s+(?:sizes?|flavours?)|add to|buy now)/i.test(name)
	);
}

function amazonLinkRecords(document: Document, pageNumber: number, capturedAt: string): ProductRecord[] {
	let pageUrl: URL;
	try {
		pageUrl = new URL(document.baseURI);
	} catch {
		return [];
	}
	if (!/(^|\.)amazon\./i.test(pageUrl.hostname) || pageUrl.pathname !== "/s") return [];

	const groups = new Map<string, AmazonProductLinkGroup>();
	let inspected = 0;
	for (const anchor of document.querySelectorAll<HTMLAnchorElement>(AMAZON_PRODUCT_LINK_SELECTOR)) {
		if (++inspected > 5_000 || !visible(anchor)) break;
		const url = productUrl(anchor.href, document.baseURI);
		if (!url) continue;
		const canonical = new URL(url);
		if (!/(^|\.)amazon\./i.test(canonical.hostname) || !/^\/dp\/[A-Z0-9]{10}$/.test(canonical.pathname)) {
			continue;
		}
		const rawHref = anchor.getAttribute("href") ?? "";
		const searchResult =
			/(?:\/ref=sr_|[?&](?:ref|ref_)=sr_|%2Fref%3Dsr_)/i.test(rawHref) || /\/sspa\/click/i.test(rawHref);
		const existing = groups.get(url);
		if (existing) {
			existing.anchors.push(anchor);
			existing.searchResult ||= searchResult;
		} else {
			groups.set(url, { anchors: [anchor], searchResult, url });
		}
	}

	const hasSearchResultLinks = [...groups.values()].some((group) => group.searchResult);
	const records: ProductRecord[] = [];
	for (const group of groups.values()) {
		if (hasSearchResultLinks && !group.searchResult) continue;
		const names = group.anchors
			.map((anchor) =>
				productName(anchor, anchor)
					.replace(/^Sponsored\s*/i, "")
					.trim(),
			)
			.filter(isProductNameCandidate)
			.sort((left, right) => right.length - left.length);
		const name = names[0];
		if (!name) continue;
		const price = group.anchors
			.map((anchor) => productPrice(anchor, clean(anchor.textContent)))
			.find((candidate) => candidate.length > 0);
		if (!price) continue;
		records.push({
			name,
			packaging: extractVisiblePackaging(name) || MISSING_PACKAGING,
			price,
			productionDate: MISSING_PRODUCTION_DATE,
			url: group.url,
			sourcePage: pageNumber,
			capturedAt,
		});
	}
	return records;
}

function linkedProductRecords(document: Document, pageNumber: number, capturedAt: string): ProductRecord[] {
	const records: ProductRecord[] = [];
	const seen = new Set<string>();
	const pageUrl = absoluteUrl(document.baseURI, document.baseURI);
	let inspected = 0;
	for (const anchor of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
		if (++inspected > 5_000 || records.length >= MAX_PRODUCT_RECORDS) break;
		if (!visible(anchor)) continue;
		const url = productUrl(anchor.href, document.baseURI);
		if (!url || url === pageUrl || seen.has(url)) continue;

		let candidate: Element | null = anchor;
		for (let depth = 0; depth < 12 && candidate; depth++) {
			if (candidate === document.body || candidate === document.documentElement) break;
			const text = clean(candidate.textContent);
			const price = productPrice(candidate, text);
			if (!price) {
				candidate = candidate.parentElement;
				continue;
			}

			const name = productName(candidate, anchor);
			if (!isProductNameCandidate(name)) {
				candidate = candidate.parentElement;
				continue;
			}

			const links = new Set<string>();
			const candidateLinks =
				candidate === anchor ? [anchor] : [anchor, ...candidate.querySelectorAll<HTMLAnchorElement>("a[href]")];
			for (const linked of candidateLinks) {
				const linkedUrl = absoluteUrl(linked.href, document.baseURI);
				if (linkedUrl) links.add(linkedUrl);
				if (links.size > 12) break;
			}
			if (links.size > 12) break;

			const namePackaging = extractVisiblePackaging(name);
			const cardPackaging = extractVisiblePackaging(text);
			records.push({
				name,
				packaging: (/\d/.test(namePackaging) ? namePackaging : cardPackaging || namePackaging) || MISSING_PACKAGING,
				price,
				productionDate: extractVisibleDate(text) || MISSING_PRODUCTION_DATE,
				url,
				sourcePage: pageNumber,
				capturedAt,
			});
			seen.add(url);
			break;
		}
	}
	return records;
}

function cardRecords(document: Document, pageNumber: number, capturedAt: string): ProductRecord[] {
	const records: ProductRecord[] = [];
	let inspected = 0;
	const amazonCards = [...document.querySelectorAll(AMAZON_RESULT_SELECTOR)].filter(
		(item) => item.parentElement?.closest(AMAZON_RESULT_SELECTOR) === null,
	);
	const taobaoCards = [...document.querySelectorAll(TAOBAO_RESULT_SELECTOR)].filter(
		(item) => item.parentElement?.closest(TAOBAO_RESULT_SELECTOR) === null,
	);
	const cards =
		amazonCards.length > 0
			? amazonCards
			: taobaoCards.length > 0
				? taobaoCards
				: document.querySelectorAll(PRODUCT_CARD_SELECTOR);
	for (const item of cards) {
		if (++inspected > 10_000 || records.length >= MAX_PRODUCT_RECORDS) break;
		if (!visible(item)) continue;
		const link =
			item.tagName === "A" && item.matches(PRODUCT_LINK_SELECTOR)
				? (item as HTMLAnchorElement)
				: item.querySelector<HTMLAnchorElement>(PRODUCT_LINK_SELECTOR);
		if (!link || !visible(link)) continue;
		const text = clean(item.textContent);
		const price = productPrice(item, text);
		if (!price) continue;
		const name = productName(item, link);
		if (!name) continue;
		const packagingElement = item.querySelector(
			"[data-test='product-information-piece-description'], .packaging, .package, .size, [data-packaging], [itemprop='size'], [itemprop='weight']",
		);
		records.push({
			name,
			packaging:
				clean(packagingElement?.getAttribute("content") ?? packagingElement?.textContent) ||
				extractVisiblePackaging(text) ||
				MISSING_PACKAGING,
			price,
			productionDate: extractVisibleDate(text) || MISSING_PRODUCTION_DATE,
			url: productUrl(link.href, document.baseURI),
			sourcePage: pageNumber,
			capturedAt,
		});
	}
	return records;
}

export function extractProducts(document: Document, pageNumber: number, capturedAt: string): ProductRecord[] {
	const amazonRecords = amazonLinkRecords(document, pageNumber, capturedAt);
	if (amazonRecords.length > 0) return normalizeProducts(amazonRecords);

	const records: ProductRecord[] = [];
	for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
		try {
			const products: Record<string, unknown>[] = [];
			collectJsonLdProducts(JSON.parse(script.textContent ?? ""), products);
			for (const product of products) {
				const record = jsonLdRecord(product, document.baseURI, pageNumber, capturedAt);
				if (record) records.push(record);
			}
		} catch {}
	}
	records.push(...microdataRecords(document, pageNumber, capturedAt));
	const cards = cardRecords(document, pageNumber, capturedAt);
	records.push(...cards);
	if (cards.length === 0) records.push(...linkedProductRecords(document, pageNumber, capturedAt));
	return normalizeProducts(records);
}
