import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureRoot = resolve(packageRoot, "test", "fixtures");
const port = 4173;

function fixturePath(pathname) {
	const relativePath = decodeURIComponent(pathname).replace(/^\/+/, "") || "shop/page-1.html";
	const path = resolve(fixtureRoot, relativePath);
	const child = relative(fixtureRoot, path);
	return child && !child.startsWith("..") && !isAbsolute(child) ? path : undefined;
}

const server = createServer((request, response) => {
	void (async () => {
		const path = fixturePath(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
		if (!path || !(await stat(path)).isFile()) {
			response.writeHead(404).end("Not found");
			return;
		}
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		createReadStream(path).pipe(response);
	})().catch(() => {
		response.writeHead(404).end("Not found");
	});
});

server.listen(port, "127.0.0.1", () => {
	process.stdout.write(`AgentW fixtures: http://127.0.0.1:${port}/shop/page-1.html\n`);
});
