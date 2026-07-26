import { once } from "node:events";
import type { Socket } from "node:net";
import { connect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeServer } from "../src/host/bridge-server.ts";
import { HostRouter } from "../src/host/host-router.ts";
import type { HostMessage } from "../src/shared/protocol.ts";

type BrowserCommandMessage = Extract<HostMessage, { type: "browser.command" }>;

describe("BridgeServer", () => {
	const sockets: Socket[] = [];
	const servers: BridgeServer[] = [];

	afterEach(async () => {
		for (const socket of sockets.splice(0)) {
			socket.destroy();
		}
		await Promise.all(servers.splice(0).map((server) => server.dispose()));
	});

	it("authenticates the Pi extension and routes its browser request", async () => {
		const commands: BrowserCommandMessage[] = [];
		const exportExcel = vi.fn(async () => ({
			id: "excel-1",
			name: "products.xlsx",
			size: 123,
			sha256: "abc",
		}));
		const router = new HostRouter((_taskId, message) => {
			commands.push(message);
		});
		const server = new BridgeServer(router, {
			exportExcel,
			getActiveTaskId: () => "task-1",
			token: "bridge-token",
		});
		servers.push(server);
		const pipeName = await server.start();
		const socket = connect(pipeName);
		sockets.push(socket);
		await once(socket, "connect");

		let buffered = "";
		const responses: unknown[] = [];
		socket.on("data", (chunk: Buffer) => {
			buffered += chunk.toString("utf8");
			let newline = buffered.indexOf("\n");
			while (newline !== -1) {
				responses.push(JSON.parse(buffered.slice(0, newline)));
				buffered = buffered.slice(newline + 1);
				newline = buffered.indexOf("\n");
			}
		});
		socket.write(`${JSON.stringify({ type: "auth", token: "bridge-token" })}\n`);
		await vi.waitFor(() => expect(responses).toContainEqual({ type: "auth.ready" }));

		socket.write(
			`${JSON.stringify({
				type: "browser.request",
				id: "bridge-request-1",
				taskId: "active",
				command: { type: "browser.inspect" },
			})}\n`,
		);
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

		await vi.waitFor(() =>
			expect(responses).toContainEqual(
				expect.objectContaining({
					type: "browser.response",
					id: "bridge-request-1",
					success: true,
				}),
			),
		);

		socket.write(
			`${JSON.stringify({
				type: "browser.request",
				id: "bridge-request-click",
				taskId: "active",
				command: { type: "browser.click", reference: "element-1" },
			})}\n`,
		);
		await vi.waitFor(() => expect(commands).toHaveLength(2));
		expect(commands[1]?.command).toEqual({
			type: "browser.click",
			reference: "element-1",
			text: undefined,
		});
		router.handleBrowserResult(commands[1]?.commandId ?? "", {
			type: "browser.action",
			changed: false,
			fingerprint: "page-1",
		});
		await vi.waitFor(() =>
			expect(responses).toContainEqual(
				expect.objectContaining({
					type: "browser.response",
					id: "bridge-request-click",
					success: true,
				}),
			),
		);

		socket.write(
			`${JSON.stringify({
				type: "browser.request",
				id: "bridge-request-search",
				taskId: "active",
				command: { type: "browser.search", query: "宽松衣服" },
			})}\n`,
		);
		await vi.waitFor(() => expect(commands).toHaveLength(3));
		expect(commands[2]?.command).toEqual({ type: "browser.search", query: "宽松衣服" });
		router.handleBrowserResult(commands[2]?.commandId ?? "", {
			type: "browser.action",
			changed: false,
			fingerprint: "page-1",
		});
		await vi.waitFor(() =>
			expect(responses).toContainEqual(
				expect.objectContaining({
					type: "browser.response",
					id: "bridge-request-search",
					success: true,
				}),
			),
		);

		socket.write(
			`${JSON.stringify({
				type: "browser.request",
				id: "bridge-request-2",
				taskId: "active",
				command: {
					type: "browser.google_sheets.write_products",
					records: [
						{
							name: "Tea",
							price: "¥20",
							productionDate: "2026-07-01",
							url: "https://shop.example/tea",
							sourcePage: 1,
							capturedAt: "2026-07-24T12:00:00.000Z",
						},
					],
				},
			})}\n`,
		);
		await vi.waitFor(() => expect(commands).toHaveLength(4));
		expect(commands[3]?.command).toMatchObject({
			type: "browser.google_sheets.write_products",
			records: [expect.objectContaining({ name: "Tea" })],
		});

		const exportRecords = Array.from({ length: 129 }, (_, index) => ({
			name: `Product ${index + 1}`,
			price: "1.00",
			productionDate: "not provided",
			url: `https://shop.example/product-${index + 1}`,
			sourcePage: 1,
			capturedAt: "2026-07-25T00:00:00.000Z",
		}));
		socket.write(
			`${JSON.stringify({
				type: "artifact.export",
				id: "bridge-export-129",
				taskId: "active",
				records: exportRecords,
			})}\n`,
		);
		await vi.waitFor(() =>
			expect(exportExcel).toHaveBeenCalledWith("task-1", exportRecords, expect.any(AbortSignal)),
		);
		await vi.waitFor(() =>
			expect(responses).toContainEqual(
				expect.objectContaining({
					type: "artifact.response",
					id: "bridge-export-129",
					success: true,
				}),
			),
		);
	});
});
