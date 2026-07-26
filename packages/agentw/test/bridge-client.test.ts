import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeServer } from "../src/host/bridge-server.ts";
import { HostRouter } from "../src/host/host-router.ts";
import { BridgeClient } from "../src/pi-extension/bridge-client.ts";
import type { HostMessage } from "../src/shared/protocol.ts";

type BrowserCommandMessage = Extract<HostMessage, { type: "browser.command" }>;

describe("BridgeClient", () => {
	const clients: BridgeClient[] = [];
	const servers: BridgeServer[] = [];

	afterEach(async () => {
		for (const client of clients.splice(0)) {
			client.dispose();
		}
		await Promise.all(servers.splice(0).map((server) => server.dispose()));
	});

	it("authenticates and resolves a browser response", async () => {
		const commands: BrowserCommandMessage[] = [];
		const router = new HostRouter((_taskId, message) => {
			commands.push(message);
		});
		const server = new BridgeServer(router, { getActiveTaskId: () => "task-1" });
		servers.push(server);
		const pipeName = await server.start();
		const client = new BridgeClient({ pipeName, token: server.token });
		clients.push(client);

		const response = client.requestBrowser("active", { type: "browser.inspect" });
		await vi.waitFor(() => expect(commands).toHaveLength(1));
		router.handleBrowserResult(commands[0]?.commandId ?? "", {
			type: "browser.snapshot",
			title: "Shop",
			url: "https://shop.test",
			fingerprint: "page-1",
			text: "Products",
			links: [],
			fields: [],
		});

		await expect(response).resolves.toMatchObject({ type: "browser.snapshot", fingerprint: "page-1" });
	});

	it("exports product records through the host bridge", async () => {
		const router = new HostRouter(() => undefined);
		const exportExcel = vi.fn(async () => ({
			id: "artifact-1",
			name: "products.xlsx",
			size: 128,
			sha256: "a".repeat(64),
		}));
		const server = new BridgeServer(router, {
			getActiveTaskId: () => "task-1",
			exportExcel,
		});
		servers.push(server);
		const pipeName = await server.start();
		const client = new BridgeClient({ pipeName, token: server.token });
		clients.push(client);
		const records = [
			{
				name: "Tea",
				price: "$1",
				productionDate: "Not provided",
				url: "https://shop.test/tea",
				sourcePage: 1,
				capturedAt: "2026-07-23T10:00:00.000Z",
			},
		];

		await expect(client.exportExcel("active", records)).resolves.toMatchObject({ id: "artifact-1" });
		expect(exportExcel).toHaveBeenCalledWith("task-1", records, expect.any(AbortSignal));
	});

	it("exports a Word document through the host bridge", async () => {
		const router = new HostRouter(() => undefined);
		const exportDocument = vi.fn(async () => ({
			id: "document-1",
			name: "jobs.docx",
			size: 256,
			sha256: "c".repeat(64),
		}));
		const server = new BridgeServer(router, {
			getActiveTaskId: () => "task-1",
			exportDocument,
		});
		servers.push(server);
		const pipeName = await server.start();
		const client = new BridgeClient({ pipeName, token: server.token });
		clients.push(client);
		const input = {
			title: "AI Agent 岗位汇总",
			content: "# 岗位\n- AI Agent Engineer",
			fileName: "ai-agent-jobs.docx",
		};

		await expect(client.exportDocument("active", input)).resolves.toMatchObject({
			id: "document-1",
			name: "jobs.docx",
		});
		expect(exportDocument).toHaveBeenCalledWith("task-1", input, expect.any(AbortSignal));
	});

	it("appends and finalizes a product dataset through the host bridge", async () => {
		const router = new HostRouter(() => undefined);
		const appendProductDataset = vi.fn(async () => ({ appended: 1, total: 1 }));
		const finalizeProductDataset = vi.fn(async () => ({
			id: "data-1",
			name: "data.json",
			size: 64,
			sha256: "b".repeat(64),
		}));
		const server = new BridgeServer(router, {
			appendProductDataset,
			finalizeProductDataset,
			getActiveTaskId: () => "task-1",
		});
		servers.push(server);
		const pipeName = await server.start();
		const client = new BridgeClient({ pipeName, token: server.token });
		clients.push(client);
		const records = [
			{
				name: "Tea",
				packaging: "20 bags",
				price: "€0,89",
				productionDate: "Not provided",
				url: "https://shop.test/tea",
				sourcePage: 1,
				capturedAt: "now",
			},
		];

		await expect(client.appendProductDataset("active", records)).resolves.toEqual({ appended: 1, total: 1 });
		await expect(client.finalizeProductDataset("active")).resolves.toMatchObject({
			id: "data-1",
			name: "data.json",
		});
		expect(appendProductDataset).toHaveBeenCalledWith("task-1", records, expect.any(AbortSignal));
		expect(finalizeProductDataset).toHaveBeenCalledWith("task-1", expect.any(AbortSignal));
	});

	it("cancels an in-flight artifact export on abort", async () => {
		let exportSignal: AbortSignal | undefined;
		const router = new HostRouter(() => undefined);
		const server = new BridgeServer(router, {
			getActiveTaskId: () => "task-1",
			exportExcel: (_taskId, _records, signal) =>
				new Promise((_resolveExport, rejectExport) => {
					exportSignal = signal;
					signal.addEventListener("abort", () => rejectExport(new Error("aborted")), { once: true });
				}),
		});
		servers.push(server);
		const pipeName = await server.start();
		const client = new BridgeClient({ pipeName, token: server.token });
		clients.push(client);
		const controller = new AbortController();
		const request = client.exportExcel(
			"active",
			[
				{
					name: "Tea",
					price: "$1",
					productionDate: "Not provided",
					url: "https://shop.test/tea",
					sourcePage: 1,
					capturedAt: "2026-07-23T10:00:00.000Z",
				},
			],
			controller.signal,
		);
		await vi.waitFor(() => expect(exportSignal).toBeDefined());

		controller.abort();

		await expect(request).rejects.toThrow("TASK_ABORTED");
		await vi.waitFor(() => expect(exportSignal?.aborted).toBe(true));
	});

	it("rejects promptly when bridge authentication fails", async () => {
		const router = new HostRouter(() => undefined);
		const server = new BridgeServer(router, {
			getActiveTaskId: () => "task-1",
			token: "correct-token",
		});
		servers.push(server);
		const pipeName = await server.start();
		const client = new BridgeClient({ pipeName, token: "wrong-token", connectTimeoutMs: 50 });
		clients.push(client);

		const request = client.requestBrowser("active", { type: "browser.inspect" });
		const outcome = await Promise.race([
			request.then(
				() => "resolved",
				() => "rejected",
			),
			new Promise<string>((resolveTimeout) => setTimeout(() => resolveTimeout("pending"), 200)),
		]);

		expect(outcome).toBe("rejected");
	});
});
