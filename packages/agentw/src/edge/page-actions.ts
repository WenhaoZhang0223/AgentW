import { AgentWError } from "../shared/errors.ts";
import type { BrowserResult, PageSnapshot } from "../shared/protocol.ts";
import { createPageSnapshot, PageElementRegistry } from "./page-snapshot.ts";

const NEXT_LABEL =
	/^(?:next|next page|go to next page|nächste|nächste seite|weiter|下一页|下页|后一页|chevron[_ -]?right|arrow[_ -]?(?:forward|right)|›|»|>)$/iu;
const PAGINATION_CONTAINER =
	'nav, [role="navigation"], [class*="pagination"], [data-test*="pagination"], [data-testid*="pagination"]';
const PREFERRED_NEXT_SELECTOR = [
	'a[rel~="next"]',
	"a.s-pagination-next[href]",
	".s-pagination-next a[href]",
	"button.s-pagination-next",
	"button.next-next",
	"a.next-next[href]",
	".next-pagination-item.next-next",
	'[data-test="pagination-next"] a[href]',
	'[data-test="pagination-next"] button',
	'[data-testid="pagination-next"] a[href]',
	'[data-testid="pagination-next"] button',
	".pagination-next a[href]",
	".pagination-next button",
	'[class*="pagination__next"] a[href]',
	'[class*="pagination__next"] button',
].join(", ");
const INTERACTIVE_SELECTOR = 'a[href], button, [role="button"], input[type="button"], input[type="submit"]';
const EDITABLE_SELECTOR = [
	'input:not([type="hidden"]):not([type="password"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="image"])',
	"textarea",
	'[contenteditable="true"]',
	'[role="searchbox"]',
	'[role="textbox"]',
].join(", ");
const SEARCH_BUTTON_SELECTOR = 'button, [role="button"], input[type="submit"], input[type="button"]';
const SEARCH_SIGNAL =
	/(?:search|query|keyword|lookup|find|搜索|搜尋|搜寻|查找|查询|檢索|检索|关键词|關鍵詞|关键字|商品|宝贝)/iu;
const SEARCH_BUTTON_LABEL =
	/^(?:search|go|find|submit|搜索|搜尋|搜寻|搜一下|搜一搜|搜索一下|搜全站|百度一下|查找|查询|檢索|检索)$/iu;
const COMMON_SEARCH_FIELD_NAME = /^(?:q|query|search|keyword|keywords|kw|wd|key|k)$/iu;
const COMMON_SEARCH_ACTION = /(?:^|\/)(?:s|search|find)(?:[/?#]|$)/iu;
const CHALLENGE_SELECTOR = [
	".captcha",
	".g-recaptcha",
	".h-captcha",
	"#captcha",
	"#challenge-form",
	"form[action*='captcha']",
	"iframe[src*='recaptcha']",
	"iframe[src*='hcaptcha']",
	"iframe[src*='challenges.cloudflare.com']",
	"[data-sitekey]",
].join(", ");

function normalizeText(value: string | null | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}

function isVisible(element: Element): boolean {
	let current: Element | null = element;
	while (current) {
		if (
			current.hasAttribute("hidden") ||
			current.getAttribute("aria-hidden") === "true" ||
			current.getAttribute("inert") !== null
		) {
			return false;
		}
		const style = current.ownerDocument.defaultView?.getComputedStyle(current);
		if (style?.display === "none" || style?.visibility === "hidden" || style?.visibility === "collapse") {
			return false;
		}
		current = current.parentElement;
	}
	return true;
}

function isEnabled(element: HTMLElement): boolean {
	return (
		!(element.tagName === "BUTTON" && (element as HTMLButtonElement).disabled) &&
		!(element.tagName === "INPUT" && (element as HTMLInputElement).disabled) &&
		element.getAttribute("aria-disabled") !== "true"
	);
}

function isTextEntry(element: HTMLElement): boolean {
	return (
		element.tagName === "INPUT" ||
		element.tagName === "TEXTAREA" ||
		element.isContentEditable ||
		element.getAttribute("contenteditable") === "true"
	);
}

function elementLabel(element: HTMLElement): string {
	return normalizeText(
		element.getAttribute("aria-label") ??
			element.getAttribute("title") ??
			(element.tagName === "INPUT" ? (element as HTMLInputElement).value : element.textContent),
	);
}

function editableMetadata(element: HTMLElement): string {
	const form = element.closest("form");
	return [
		element.getAttribute("aria-label"),
		element.getAttribute("placeholder"),
		element.getAttribute("name"),
		element.id,
		element.getAttribute("role"),
		element.getAttribute("type"),
		element.getAttribute("autocomplete"),
		element.getAttribute("data-testid"),
		element.getAttribute("data-test"),
		element.className,
		form?.getAttribute("role"),
		form?.getAttribute("action"),
	]
		.filter((value): value is string => typeof value === "string")
		.join(" ");
}

function findSearchSubmit(element: HTMLElement): HTMLElement | undefined {
	const usable = (candidate: HTMLElement): boolean =>
		candidate.isConnected && isVisible(candidate) && isEnabled(candidate);
	const form = element.closest("form");
	if (form) {
		const candidates = [...form.querySelectorAll<HTMLElement>(SEARCH_BUTTON_SELECTOR)].filter(usable);
		const labeled = candidates.find((candidate) => SEARCH_BUTTON_LABEL.test(elementLabel(candidate)));
		if (labeled) return labeled;
		const submits = candidates.filter((candidate) =>
			candidate.tagName === "BUTTON"
				? (candidate as HTMLButtonElement).type === "submit"
				: candidate.getAttribute("type")?.toLowerCase() === "submit",
		);
		if (submits.length === 1) return submits[0];
	}

	let container = element.parentElement;
	for (let depth = 0; depth < 6 && container; depth++) {
		const labeled = [...container.querySelectorAll<HTMLElement>(SEARCH_BUTTON_SELECTOR)].find(
			(candidate) => usable(candidate) && SEARCH_BUTTON_LABEL.test(elementLabel(candidate)),
		);
		if (labeled) return labeled;
		container = container.parentElement;
	}
	return undefined;
}

function searchFieldScore(element: HTMLElement): number {
	let score = 0;
	const type = element.getAttribute("type")?.toLowerCase();
	const role = element.getAttribute("role")?.toLowerCase();
	const metadata = editableMetadata(element);
	if (type === "search") score += 120;
	if (role === "searchbox") score += 120;
	if (element.closest('[role="search"]')) score += 100;
	const form = element.closest("form");
	const action = form?.getAttribute("action") ?? "";
	if (SEARCH_SIGNAL.test(action) || COMMON_SEARCH_ACTION.test(action)) score += 80;
	if (SEARCH_SIGNAL.test(form?.getAttribute("role") ?? "")) score += 80;
	if (SEARCH_SIGNAL.test(metadata)) score += 70;
	if (COMMON_SEARCH_FIELD_NAME.test(element.getAttribute("name") ?? "") || COMMON_SEARCH_FIELD_NAME.test(element.id)) {
		score += 70;
	}
	const submit = findSearchSubmit(element);
	if (submit && SEARCH_BUTTON_LABEL.test(elementLabel(submit))) score += 60;
	if (element === element.ownerDocument.activeElement) score += 10;
	const bounds = element.getBoundingClientRect();
	if (bounds.width >= 160) score += 10;
	return score;
}

function setEditableValue(element: HTMLElement, text: string): void {
	const view = element.ownerDocument.defaultView;
	element.focus();
	if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
		const prototype =
			element.tagName === "INPUT" ? view?.HTMLInputElement.prototype : view?.HTMLTextAreaElement.prototype;
		const setter = prototype ? Object.getOwnPropertyDescriptor(prototype, "value")?.set : undefined;
		if (setter) {
			setter.call(element, text);
		} else {
			(element as HTMLInputElement | HTMLTextAreaElement).value = text;
		}
		(element as HTMLInputElement | HTMLTextAreaElement).setSelectionRange?.(text.length, text.length);
	} else {
		element.textContent = text;
	}
	const EventConstructor = view?.Event;
	if (!EventConstructor) return;
	element.dispatchEvent(new EventConstructor("input", { bubbles: true, composed: true }));
	element.dispatchEvent(new EventConstructor("change", { bubbles: true, composed: true }));
}

function submitEditable(element: HTMLElement): void {
	const submit = findSearchSubmit(element);
	if (submit) {
		submit.click();
		return;
	}
	const form = element.closest("form") as HTMLFormElement | null;
	if (form) {
		form.requestSubmit();
		return;
	}
	const KeyboardEventConstructor = element.ownerDocument.defaultView?.KeyboardEvent;
	if (!KeyboardEventConstructor) return;
	for (const type of ["keydown", "keypress", "keyup"]) {
		element.dispatchEvent(
			new KeyboardEventConstructor(type, {
				bubbles: true,
				cancelable: true,
				composed: true,
				key: "Enter",
				code: "Enter",
			}),
		);
	}
}

export class PageActionRegistry {
	private readonly document: Document;
	private readonly location: Pick<Location, "href">;
	private readonly elements = new PageElementRegistry();

	constructor(document: Document, location: Pick<Location, "href">) {
		this.document = document;
		this.location = location;
	}

	inspect(): Promise<PageSnapshot> {
		return createPageSnapshot(this.document, this.location, this.elements);
	}

	click(reference: string): void {
		const element = this.elements.get(reference);
		if (!element?.isConnected || typeof (element as { click?: unknown }).click !== "function") {
			throw new AgentWError("STALE_ELEMENT_REFERENCE");
		}
		(element as HTMLElement).click();
	}

	clickByText(text: string): void {
		const requested = text.replace(/\s+/g, " ").trim().toLocaleLowerCase();
		let candidates = [...this.document.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR)].filter(
			(element) =>
				element.isConnected &&
				isVisible(element) &&
				isEnabled(element) &&
				elementLabel(element).toLocaleLowerCase() === requested,
		);
		if (candidates.length === 0) {
			let inspected = 0;
			candidates = [...this.document.body.querySelectorAll<HTMLElement>("*")].filter((element) => {
				if (++inspected > 10_000 || !element.isConnected || !isVisible(element) || !isEnabled(element)) {
					return false;
				}
				if (elementLabel(element).toLocaleLowerCase() !== requested) return false;
				return ![...element.children].some(
					(child) => isVisible(child) && elementLabel(child as HTMLElement).toLocaleLowerCase() === requested,
				);
			});
		}
		if (candidates.length !== 1) {
			throw new AgentWError(
				"PAGE_REQUIRES_USER_ACTION",
				candidates.length === 0
					? `No visible element named "${text}" was found`
					: `More than one visible element is named "${text}"`,
			);
		}
		candidates[0]?.click();
	}

	typeText(reference: string, text: string, submit: boolean): void {
		const element = this.elements.get(reference);
		if (!element?.isConnected) {
			throw new AgentWError("STALE_ELEMENT_REFERENCE");
		}
		const editable = element as HTMLElement;
		if (!isVisible(editable) || !isEnabled(editable) || !isTextEntry(editable)) {
			throw new AgentWError("PAGE_REQUIRES_USER_ACTION", "The selected element is not an editable text field");
		}
		setEditableValue(editable, text);
		if (submit) submitEditable(editable);
	}

	search(query: string): void {
		if (this.hasUserChallenge()) {
			throw new AgentWError("PAGE_REQUIRES_USER_ACTION");
		}
		const candidates = [...this.document.querySelectorAll<HTMLElement>(EDITABLE_SELECTOR)]
			.filter((element) => element.isConnected && isVisible(element) && isEnabled(element) && isTextEntry(element))
			.map((element) => ({ element, score: searchFieldScore(element) }))
			.filter((candidate) => candidate.score > 0)
			.sort((left, right) => right.score - left.score);
		const field = candidates[0]?.element;
		if (!field) {
			throw new AgentWError("PAGE_REQUIRES_USER_ACTION", "No visible search field was found on the current page");
		}
		setEditableValue(field, query);
		submitEditable(field);
	}

	scrollViewport(): void {
		this.document.defaultView?.scrollBy({ top: this.document.defaultView.innerHeight, behavior: "smooth" });
	}

	async nextPage(): Promise<BrowserResult> {
		if (this.hasUserChallenge()) {
			throw new AgentWError("PAGE_REQUIRES_USER_ACTION");
		}
		const before = await this.inspect();
		const next = this.findNextPageElement();
		if (!next) {
			throw new AgentWError("NEXT_PAGE_NOT_FOUND");
		}
		next.scrollIntoView?.({ block: "center", inline: "center" });
		next.click();
		return { type: "browser.action", changed: false, fingerprint: before.fingerprint };
	}

	async waitForChange(previousFingerprint: string, timeoutMs: number, signal?: AbortSignal): Promise<BrowserResult> {
		const deadline = Date.now() + Math.min(timeoutMs, 30_000);
		while (Date.now() < deadline) {
			if (signal?.aborted) throw new AgentWError("TASK_ABORTED");
			const snapshot = await this.inspect();
			if (snapshot.fingerprint !== previousFingerprint) {
				return { type: "browser.action", changed: true, fingerprint: snapshot.fingerprint };
			}
			await new Promise<void>((resolveWait) => setTimeout(resolveWait, 150));
		}
		const snapshot = await this.inspect();
		return { type: "browser.action", changed: false, fingerprint: snapshot.fingerprint };
	}

	private hasUserChallenge(): boolean {
		return [...this.document.querySelectorAll(CHALLENGE_SELECTOR)].some((element) => isVisible(element));
	}

	private findNextPageElement(): HTMLElement | undefined {
		const usable = (element: HTMLElement): boolean => element.isConnected && isVisible(element) && isEnabled(element);
		const preferred = [...this.document.querySelectorAll<HTMLElement>(PREFERRED_NEXT_SELECTOR)].find(usable);
		if (preferred) return preferred;

		const interactive = [...this.document.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR)].filter(usable);
		const labeled = interactive.filter((element) => NEXT_LABEL.test(elementLabel(element).toLocaleLowerCase()));
		const paginated = labeled.find((element) => element.closest(PAGINATION_CONTAINER) !== null);
		if (paginated) return paginated;
		if (labeled.length === 1) return labeled[0];

		const current = this.document.querySelector<HTMLElement>('[aria-current="page"], [aria-current="true"]');
		const currentPage = Number.parseInt(normalizeText(current?.textContent), 10);
		if (!current || !Number.isSafeInteger(currentPage)) return undefined;
		const container = current.closest(PAGINATION_CONTAINER);
		if (!container) return undefined;
		return [...container.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR)].find(
			(element) => usable(element) && elementLabel(element) === String(currentPage + 1),
		);
	}
}
