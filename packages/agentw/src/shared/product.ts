export interface ProductRecord {
	name: string;
	packaging?: string;
	price: string;
	productionDate: string;
	url: string;
	sourcePage: number;
	capturedAt: string;
}

export interface ArtifactDescriptor {
	id: string;
	name: string;
	size: number;
	sha256: string;
}

export interface DatasetAppendResult {
	appended: number;
	total: number;
}

export interface DocumentArtifactInput {
	title: string;
	content: string;
	fileName?: string;
}

export interface InstalledSkill {
	name: string;
	enabled: boolean;
}

export const MISSING_PRODUCTION_DATE = "网页未提供";
export const MISSING_PACKAGING = "网页未提供";
export const MAX_PRODUCT_RECORDS = 128;
export const MAX_PRODUCT_BATCH_RECORDS = 2_000;
export const MAX_PRODUCT_NAME_CHARACTERS = 256;
export const MAX_PRODUCT_PACKAGING_CHARACTERS = 128;
export const MAX_PRODUCT_PRICE_CHARACTERS = 64;
export const MAX_PRODUCT_DATE_CHARACTERS = 64;
export const MAX_PRODUCT_URL_CHARACTERS = 1_024;
export const MAX_CAPTURED_AT_CHARACTERS = 64;
export const MAX_DOCUMENT_TITLE_CHARACTERS = 256;
export const MAX_DOCUMENT_CONTENT_CHARACTERS = 100_000;
export const MAX_DOCUMENT_FILE_NAME_CHARACTERS = 128;

export function normalizeProducts(records: ProductRecord[]): ProductRecord[] {
	const normalized: ProductRecord[] = [];
	const seen = new Set<string>();
	for (const record of records) {
		if (normalized.length >= MAX_PRODUCT_RECORDS) break;
		const item: ProductRecord = {
			name: record.name.replace(/\s+/g, " ").trim().slice(0, MAX_PRODUCT_NAME_CHARACTERS),
			packaging:
				(record.packaging ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_PRODUCT_PACKAGING_CHARACTERS) ||
				MISSING_PACKAGING,
			price: record.price.replace(/\s+/g, " ").trim().slice(0, MAX_PRODUCT_PRICE_CHARACTERS),
			productionDate:
				record.productionDate.replace(/\s+/g, " ").trim().slice(0, MAX_PRODUCT_DATE_CHARACTERS) ||
				MISSING_PRODUCTION_DATE,
			url: record.url.trim().slice(0, MAX_PRODUCT_URL_CHARACTERS),
			sourcePage: record.sourcePage,
			capturedAt: record.capturedAt.trim().slice(0, MAX_CAPTURED_AT_CHARACTERS),
		};
		if (!item.name) continue;
		const key = item.url ? `url:${item.url}` : `name:${item.name.toLocaleLowerCase()}\u0000${item.price}`;
		if (seen.has(key)) continue;
		seen.add(key);
		normalized.push(item);
	}
	return normalized;
}

function numericPrice(price: string): number | undefined {
	const candidate = price.match(/-?\d[\d.,]*/)?.[0];
	if (!candidate) return undefined;
	const comma = candidate.lastIndexOf(",");
	const dot = candidate.lastIndexOf(".");
	let normalized = candidate;
	if (comma >= 0 && dot >= 0) {
		const decimal = comma > dot ? "," : ".";
		normalized = candidate.replace(decimal === "," ? /\./g : /,/g, "").replace(decimal, ".");
	} else if (comma >= 0) {
		const fractionalDigits = candidate.length - comma - 1;
		normalized = fractionalDigits === 3 && comma > 0 ? candidate.replace(",", "") : candidate.replace(",", ".");
	}
	const value = Number.parseFloat(normalized);
	return Number.isFinite(value) ? value : undefined;
}

export function sortProductsByPriceAscending(records: ProductRecord[]): ProductRecord[] {
	return records
		.map((record, index) => ({ record, index, value: numericPrice(record.price) }))
		.sort((left, right) => {
			if (left.value === undefined && right.value === undefined) return left.index - right.index;
			if (left.value === undefined) return 1;
			if (right.value === undefined) return -1;
			return left.value - right.value || left.index - right.index;
		})
		.map(({ record }) => record);
}
