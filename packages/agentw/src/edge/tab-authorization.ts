export interface AuthorizedTab {
	tabId: number;
	origin: string;
}

export function isAuthorizedActiveTab(
	authorization: AuthorizedTab | undefined,
	activeTabId: number | undefined,
	activeOrigin: string | undefined,
): authorization is AuthorizedTab {
	return authorization !== undefined && authorization.tabId === activeTabId && authorization.origin === activeOrigin;
}
