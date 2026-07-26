import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceRoot = join(packageRoot, "src");
const outputRoot = join(packageRoot, "dist");
const edgeOutput = join(outputRoot, "edge");
const hostOutput = join(outputRoot, "host");
const piExtensionOutput = join(outputRoot, "pi-extension");

await Promise.all([
	rm(edgeOutput, { recursive: true, force: true }),
	rm(hostOutput, { recursive: true, force: true }),
	rm(piExtensionOutput, { recursive: true, force: true }),
]);
await Promise.all([
	mkdir(edgeOutput, { recursive: true }),
	mkdir(hostOutput, { recursive: true }),
	mkdir(piExtensionOutput, { recursive: true }),
]);

const common = {
	bundle: true,
	logLevel: "info",
	sourcemap: true,
};

await Promise.all([
	build({
		...common,
		entryPoints: [join(sourceRoot, "host", "main.ts")],
		outfile: join(hostOutput, "main.js"),
		platform: "node",
		format: "esm",
		target: "node22",
	}),
	build({
		...common,
		entryPoints: [join(sourceRoot, "pi-extension", "index.ts")],
		outfile: join(piExtensionOutput, "index.js"),
		platform: "node",
		format: "esm",
		target: "node22",
	}),
	build({
		...common,
		entryPoints: [join(sourceRoot, "edge", "service-worker.ts")],
		outfile: join(edgeOutput, "service-worker.js"),
		platform: "browser",
		format: "esm",
		target: "chrome138",
	}),
	build({
		...common,
		entryPoints: [join(sourceRoot, "edge", "content-script.ts")],
		outfile: join(edgeOutput, "content-script.js"),
		platform: "browser",
		format: "iife",
		target: "chrome138",
	}),
	build({
		...common,
		entryPoints: [join(sourceRoot, "edge", "sidepanel.ts")],
		outfile: join(edgeOutput, "sidepanel.js"),
		platform: "browser",
		format: "esm",
		target: "chrome138",
	}),
]);

await Promise.all(
	["manifest.json", "sidepanel.html", "sidepanel.css"].map((name) =>
		copyFile(join(sourceRoot, "edge", name), join(edgeOutput, name)),
	),
);
