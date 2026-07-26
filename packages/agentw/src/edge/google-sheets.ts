import { type ProductRecord, sortProductsByPriceAscending } from "../shared/product.ts";

export type GoogleSheetsPage = "login" | "sheet" | "sheets-home" | "other";

export function classifyGoogleSheetsPage(url: string | undefined): GoogleSheetsPage {
	if (!url) return "other";
	try {
		const value = new URL(url);
		if (value.hostname === "accounts.google.com") return "login";
		if (value.hostname !== "docs.google.com" || !value.pathname.startsWith("/spreadsheets")) return "other";
		return /^\/spreadsheets\/d\/[^/]+/.test(value.pathname) ? "sheet" : "sheets-home";
	} catch {
		return "other";
	}
}

function tsvCell(value: string | number): string {
	return String(value)
		.replace(/[\t\r\n]+/g, " ")
		.trim();
}

export function productsToTsv(records: ProductRecord[]): string {
	const rows = [
		["商品名称", "包装规格", "价格", "生产日期", "商品链接", "来源页", "采集时间"],
		...sortProductsByPriceAscending(records).map((record) => [
			record.name,
			record.packaging ?? "网页未提供",
			record.price,
			record.productionDate,
			record.url,
			record.sourcePage,
			record.capturedAt,
		]),
	];
	return rows.map((row) => row.map(tsvCell).join("\t")).join("\n");
}
