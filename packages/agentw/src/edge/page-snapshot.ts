/// <reference types="chrome" />

import type { PageField, PageLink, PageSnapshot } from "../shared/protocol.ts";

const MAX_TEXT_CHARACTERS = 60_000;
const MAX_LINKS = 100;
const MAX_FIELDS = 50;
const MAX_FIELD_LABEL_CHARACTERS = 200;
const MAX_LINK_TEXT_CHARACTERS = 200;
const MAX_URL_CHARACTERS = 1_024;
const MAX_PAGE_URL_CHARACTERS = 2_048;
const MAX_TITLE_CHARACTERS = 256;
const EXCLUDED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG"]);
const EDITABLE_SELECTOR = [
	'input:not([type="hidden"]):not([type="password"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="image"])',
	"textarea",
	'[contenteditable="true"]',
	'[role="searchbox"]',
	'[role="textbox"]',
].join(", ");

export class PageElementRegistry {
	private fingerprint = "";
	private readonly elements = new Map<string, Element>();
	private sequence = 0;

	begin(fingerprint: string): void {
		if (fingerprint !== this.fingerprint) {
			this.elements.clear();
			this.sequence = 0;
			this.fingerprint = fingerprint;
		}
	}

	register(element: Element): string {
		const reference = `element-${++this.sequence}`;
		this.elements.set(reference, element);
		return reference;
	}

	get(reference: string): Element | undefined {
		return this.elements.get(reference);
	}
}

function isVisible(element: Element): boolean {
	let current: Element | null = element;
	while (current) {
		if (
			EXCLUDED_TAGS.has(current.tagName) ||
			current.hasAttribute("hidden") ||
			current.getAttribute("aria-hidden") === "true"
		) {
			return false;
		}
		if (current.tagName === "INPUT" && current.getAttribute("type")?.toLowerCase() === "password") {
			return false;
		}
		const style = current.ownerDocument.defaultView?.getComputedStyle(current);
		if (style?.display === "none" || style?.visibility === "hidden") {
			return false;
		}
		current = current.parentElement;
	}
	return true;
}

function normalizeText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function fieldLabel(element: HTMLElement): string {
	const labelledBy = (element.getAttribute("aria-labelledby") ?? "")
		.split(/\s+/)
		.map((id) => normalizeText(element.ownerDocument.getElementById(id)?.textContent ?? ""))
		.filter(Boolean)
		.join(" ");
	const wrappingLabel = normalizeText(element.closest("label")?.textContent ?? "");
	const id = element.id;
	const explicitLabel = id
		? [...element.ownerDocument.querySelectorAll<HTMLLabelElement>("label[for]")]
				.filter((label) => label.htmlFor === id)
				.map((label) => normalizeText(label.textContent ?? ""))
				.find(Boolean)
		: undefined;
	const label = [
		element.getAttribute("aria-label"),
		labelledBy,
		explicitLabel,
		wrappingLabel,
		element.getAttribute("placeholder"),
		element.getAttribute("title"),
		element.getAttribute("name"),
		element.id,
	]
		.map((value) => normalizeText(value ?? ""))
		.find(Boolean);
	return (label ?? "").slice(0, MAX_FIELD_LABEL_CHARACTERS);
}

function fieldType(element: HTMLElement): string {
	if (element.tagName === "INPUT") return (element.getAttribute("type") || "text").toLowerCase();
	if (element.tagName === "TEXTAREA") return "textarea";
	return element.getAttribute("role")?.toLowerCase() || "contenteditable";
}

function isEditable(element: HTMLElement): boolean {
	return (
		isVisible(element) &&
		(element.tagName === "INPUT" ||
			element.tagName === "TEXTAREA" ||
			element.isContentEditable ||
			element.getAttribute("contenteditable") === "true") &&
		!element.hasAttribute("disabled") &&
		!element.hasAttribute("readonly") &&
		element.getAttribute("aria-disabled") !== "true" &&
		element.getAttribute("aria-readonly") !== "true"
	);
}

function collectVisibleText(root: Element): string {
	const parts: string[] = [];
	const visit = (node: Node): void => {
		if (node.nodeType === 3) {
			const parent = node.parentElement;
			if (parent && isVisible(parent)) {
				const text = normalizeText(node.textContent ?? "");
				if (text) parts.push(text);
			}
			return;
		}
		if (node.nodeType !== 1 || !isVisible(node as Element)) return;
		for (const child of node.childNodes) visit(child);
	};
	visit(root);
	return normalizeText(parts.join(" ")).slice(0, MAX_TEXT_CHARACTERS);
}

async function fingerprint(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createPageSnapshot(
	document: Document,
	location: Pick<Location, "href">,
	registry = new PageElementRegistry(),
): Promise<PageSnapshot> {
	const body = document.body;
	const text = body ? collectVisibleText(body) : "";
	const pageFingerprint = await fingerprint(`${location.href}\n${text}`);
	registry.begin(pageFingerprint);

	const links: PageLink[] = [];
	for (const anchor of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
		if (links.length >= MAX_LINKS || !isVisible(anchor)) continue;
		let url: string;
		try {
			url = new URL(anchor.href, location.href).href;
		} catch {
			continue;
		}
		if ((!url.startsWith("http://") && !url.startsWith("https://")) || url.length > MAX_URL_CHARACTERS) continue;
		const label = normalizeText(anchor.textContent ?? anchor.getAttribute("aria-label") ?? anchor.title).slice(
			0,
			MAX_LINK_TEXT_CHARACTERS,
		);
		if (!label && anchor.rel.toLowerCase() !== "next") continue;
		links.push({
			text: label,
			url,
			ref: registry.register(anchor),
			rel: anchor.rel || undefined,
		});
	}

	const fields: PageField[] = [];
	for (const element of document.querySelectorAll<HTMLElement>(EDITABLE_SELECTOR)) {
		if (fields.length >= MAX_FIELDS || !isEditable(element)) continue;
		fields.push({
			label: fieldLabel(element),
			ref: registry.register(element),
			type: fieldType(element),
		});
	}

	return {
		title: normalizeText(document.title).slice(0, MAX_TITLE_CHARACTERS),
		url: location.href.slice(0, MAX_PAGE_URL_CHARACTERS),
		fingerprint: pageFingerprint,
		text,
		links,
		fields,
	};
}
