import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = dirname(dirname(packageRoot));
const input = join(packageRoot, "dist", "host", "main.js");
const hostOutput = join(packageRoot, "dist", "agentw-host.exe");
const piOutput = join(packageRoot, "dist", "pi.exe");
const piEntry = join(repositoryRoot, "packages", "coding-agent", "src", "bun", "cli.ts");
const imageWorker = join(repositoryRoot, "packages", "coding-agent", "src", "utils", "image-resize-worker.ts");
const piPackageRoot = join(repositoryRoot, "packages", "coding-agent");
const piThemeSource = join(piPackageRoot, "src", "modes", "interactive", "theme");
const piThemeOutput = join(packageRoot, "dist", "theme");

if (!existsSync(input)) {
	throw new Error("Run node packages/agentw/scripts/build.mjs before compiling the Host");
}

function compile(arguments_) {
	const result = spawnSync("bun", ["build", "--compile", ...arguments_], {
		cwd: repositoryRoot,
		stdio: "inherit",
		windowsHide: true,
	});
	if (result.error) {
		throw new Error(`Unable to start Bun: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(`Bun compilation failed with exit code ${result.status ?? "unknown"}`);
	}
}

compile([piEntry, imageWorker, "--outfile", piOutput]);
compile([input, "--outfile", hostOutput]);

mkdirSync(piThemeOutput, { recursive: true });
copyFileSync(join(piPackageRoot, "package.json"), join(packageRoot, "dist", "package.json"));
copyFileSync(join(piThemeSource, "dark.json"), join(piThemeOutput, "dark.json"));
copyFileSync(join(piThemeSource, "light.json"), join(piThemeOutput, "light.json"));

const requiredOutputs = [
	hostOutput,
	piOutput,
	join(packageRoot, "dist", "package.json"),
	join(piThemeOutput, "dark.json"),
	join(piThemeOutput, "light.json"),
];
if (requiredOutputs.some((path) => !existsSync(path))) {
	throw new Error("Bun compilation did not create the complete AgentW Host distribution");
}
