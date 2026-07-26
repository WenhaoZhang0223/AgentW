import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { parse } from "yaml";
import { fromBufferPromise } from "yauzl";
import { AgentWError } from "../shared/errors.ts";
import type { InstalledSkill } from "../shared/product.ts";
import { normalizeSkillRelativePath } from "../shared/skill-path.ts";

export interface SkillUploadFile {
	relativePath: string;
	data: Uint8Array;
}

export interface SkillInstallerOptions {
	disabledRoot: string;
	enabledRoot: string;
	testRoot?: string;
	validationRoot: string;
}

interface InstallOptions {
	overwrite?: boolean;
}

interface ValidatedFile {
	relativePath: string;
	data: Buffer;
}

const MAX_COMPRESSED_BYTES = 10 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 200;
const DENIED_EXTENSIONS = new Set([
	".exe",
	".dll",
	".com",
	".bat",
	".cmd",
	".ps1",
	".js",
	".mjs",
	".cjs",
	".ts",
	".tsx",
	".vbs",
	".py",
	".sh",
	".wasm",
]);
const SKILL_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function fail(message: string): never {
	throw new AgentWError("SKILL_VALIDATION_FAILED", `SKILL_VALIDATION_FAILED: ${message}`);
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function isContained(root: string, path: string): boolean {
	const child = relative(root, path);
	return child.length > 0 && !child.startsWith("..") && !isAbsolute(child);
}

function normalizeRelativePath(input: string): string {
	return normalizeSkillRelativePath(input) ?? fail("Invalid Skill path");
}

function assertSafeFile(path: string): void {
	if (DENIED_EXTENSIONS.has(extname(path).toLowerCase())) {
		fail(`Executable Skill file is not allowed: ${path}`);
	}
}

function parseSkillMetadata(markdown: Buffer): { name: string; description: string } {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(markdown);
	} catch {
		return fail("SKILL.md must be UTF-8");
	}
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
	if (!frontmatter?.[1]) fail("SKILL.md requires YAML frontmatter");
	let metadata: Record<string, unknown>;
	try {
		const parsed: unknown = parse(frontmatter[1], { schema: "core" });
		metadata = asRecord(parsed);
	} catch {
		return fail("SKILL.md frontmatter is invalid");
	}
	if (typeof metadata.name !== "string" || !SKILL_NAME.test(metadata.name)) {
		fail("Skill name is invalid");
	}
	if (
		typeof metadata.description !== "string" ||
		metadata.description.trim().length === 0 ||
		metadata.description.length > 500
	) {
		fail("Skill description is invalid");
	}
	return { name: metadata.name, description: metadata.description.trim() };
}

export class SkillInstaller {
	private readonly disabledRoot: string;
	private readonly enabledRoot: string;
	private readonly testRoot: string | undefined;
	private readonly validationRoot: string;

	constructor(options: SkillInstallerOptions) {
		this.enabledRoot = resolve(options.enabledRoot);
		this.disabledRoot = resolve(options.disabledRoot);
		this.validationRoot = resolve(options.validationRoot);
		this.testRoot = options.testRoot;
	}

	static forTest(): SkillInstaller {
		const root = join(tmpdir(), `agentw-skill-test-${randomUUID()}`);
		return new SkillInstaller({
			enabledRoot: join(root, "skills"),
			disabledRoot: join(root, "skills-disabled"),
			validationRoot: join(root, "validation"),
			testRoot: root,
		});
	}

	validationRootForTest(): string {
		if (!this.testRoot) throw new Error("Not a test installer");
		return this.validationRoot;
	}

	async disposeForTest(): Promise<void> {
		if (this.testRoot) {
			await rm(this.testRoot, { recursive: true, force: true });
		}
	}

	async cleanupValidation(): Promise<void> {
		await rm(this.validationRoot, { recursive: true, force: true });
		await mkdir(this.validationRoot, { recursive: true });
	}

	async installZip(data: Uint8Array, options: InstallOptions = {}): Promise<InstalledSkill> {
		if (data.byteLength > MAX_COMPRESSED_BYTES) {
			return fail("Skill ZIP exceeds 10 MiB");
		}
		try {
			const zip = await fromBufferPromise(Buffer.from(data), {
				lazyEntries: true,
				validateEntrySizes: true,
				strictFileNames: true,
			});
			const files: SkillUploadFile[] = [];
			let entries = 0;
			let expandedBytes = 0;
			try {
				for await (const entry of zip.eachEntry()) {
					entries++;
					if (entries > MAX_FILES) fail("Skill ZIP contains too many entries");
					if (entry.versionMadeBy >> 8 === 3 && ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) {
						fail("Skill ZIP symlinks are not allowed");
					}
					if (entry.fileName.endsWith("/")) {
						normalizeRelativePath(entry.fileName.slice(0, -1));
						continue;
					}
					expandedBytes += entry.uncompressedSize;
					if (expandedBytes > MAX_EXPANDED_BYTES) fail("Expanded Skill exceeds 50 MiB");
					const stream = await zip.openReadStreamPromise(entry);
					const chunks: Buffer[] = [];
					for await (const chunk of stream) {
						chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
					}
					files.push({ relativePath: entry.fileName, data: Buffer.concat(chunks) });
				}
			} finally {
				zip.close();
			}
			return await this.installFiles(files, options);
		} catch (error) {
			if (error instanceof AgentWError) throw error;
			return fail(error instanceof Error ? error.message : String(error));
		}
	}

	async installFiles(files: SkillUploadFile[], options: InstallOptions = {}): Promise<InstalledSkill> {
		await this.ensureRoots();
		let stagingRoot: string | undefined;
		try {
			const validated = this.validateFiles(files);
			const skillFile = validated.find((file) => file.relativePath === "SKILL.md");
			if (!skillFile) fail("Skill package must contain SKILL.md");
			const metadata = parseSkillMetadata(skillFile.data);
			stagingRoot = await mkdtemp(join(this.validationRoot, "install-"));
			const contentRoot = join(stagingRoot, "content");
			await mkdir(contentRoot);
			for (const file of validated) {
				const destination = resolve(contentRoot, file.relativePath);
				if (!isContained(contentRoot, destination)) fail("Invalid Skill path");
				await mkdir(dirname(destination), { recursive: true });
				await writeFile(destination, file.data, { flag: "wx" });
			}
			await this.installAtomically(contentRoot, metadata.name, options.overwrite === true);
			return { name: metadata.name, enabled: true };
		} catch (error) {
			if (error instanceof AgentWError) throw error;
			throw new AgentWError("SKILL_VALIDATION_FAILED", error instanceof Error ? error.message : String(error));
		} finally {
			if (stagingRoot) {
				await rm(stagingRoot, { recursive: true, force: true });
			}
		}
	}

	async list(): Promise<InstalledSkill[]> {
		await this.ensureRoots();
		const [enabled, disabled] = await Promise.all([
			this.listRoot(this.enabledRoot, true),
			this.listRoot(this.disabledRoot, false),
		]);
		return [...enabled, ...disabled].sort((left, right) => left.name.localeCompare(right.name));
	}

	async disable(name: string): Promise<void> {
		this.assertSkillName(name);
		await this.ensureRoots();
		await this.moveSkill(this.enabledRoot, this.disabledRoot, name);
	}

	async enable(name: string): Promise<void> {
		this.assertSkillName(name);
		await this.ensureRoots();
		await this.moveSkill(this.disabledRoot, this.enabledRoot, name);
	}

	async delete(name: string): Promise<void> {
		this.assertSkillName(name);
		await this.ensureRoots();
		const enabled = resolve(this.enabledRoot, name);
		const disabled = resolve(this.disabledRoot, name);
		if (!isContained(this.enabledRoot, enabled) || !isContained(this.disabledRoot, disabled)) {
			fail("Invalid Skill name");
		}
		await Promise.all([
			rm(enabled, { recursive: true, force: true }),
			rm(disabled, { recursive: true, force: true }),
		]);
	}

	private validateFiles(files: SkillUploadFile[]): ValidatedFile[] {
		if (files.length === 0 || files.length > MAX_FILES) fail("Skill package file count is invalid");
		let totalBytes = 0;
		const normalized = files.map((file) => {
			const relativePath = normalizeRelativePath(file.relativePath);
			assertSafeFile(relativePath);
			totalBytes += file.data.byteLength;
			if (totalBytes > MAX_EXPANDED_BYTES) fail("Expanded Skill exceeds 50 MiB");
			return { relativePath, data: Buffer.from(file.data) };
		});
		const skillPaths = normalized
			.map((file) => file.relativePath)
			.filter((path) => path === "SKILL.md" || path.endsWith("/SKILL.md"));
		if (skillPaths.length !== 1) fail("Skill package must contain exactly one SKILL.md");
		const skillPath = skillPaths[0] ?? "";
		const prefix = skillPath === "SKILL.md" ? "" : skillPath.slice(0, -"SKILL.md".length);
		const seen = new Set<string>();
		return normalized.map((file) => {
			if (prefix && !file.relativePath.startsWith(prefix)) fail("All files must be inside the Skill directory");
			const relativePath = prefix ? file.relativePath.slice(prefix.length) : file.relativePath;
			if (!relativePath || seen.has(relativePath)) fail("Duplicate Skill path");
			seen.add(relativePath);
			return { relativePath, data: file.data };
		});
	}

	private async installAtomically(contentRoot: string, name: string, overwrite: boolean): Promise<void> {
		const target = resolve(this.enabledRoot, name);
		const disabledTarget = resolve(this.disabledRoot, name);
		if (!isContained(this.enabledRoot, target) || !isContained(this.disabledRoot, disabledTarget)) {
			fail("Invalid Skill name");
		}
		const [enabledExists, disabledExists] = await Promise.all([exists(target), exists(disabledTarget)]);
		if ((enabledExists || disabledExists) && !overwrite) {
			fail(`Skill already exists: ${name}`);
		}
		const backup = resolve(this.enabledRoot, `.backup-${randomUUID()}`);
		if (enabledExists) {
			await rename(target, backup);
		}
		try {
			await rename(contentRoot, target);
			await Promise.all([
				rm(backup, { recursive: true, force: true }),
				rm(disabledTarget, { recursive: true, force: true }),
			]);
		} catch (error) {
			await rm(target, { recursive: true, force: true });
			if (enabledExists && (await exists(backup))) {
				await rename(backup, target);
			}
			throw error;
		}
	}

	private async moveSkill(fromRoot: string, toRoot: string, name: string): Promise<void> {
		const source = resolve(fromRoot, name);
		const destination = resolve(toRoot, name);
		if (!isContained(fromRoot, source) || !isContained(toRoot, destination) || !(await exists(source))) {
			fail("Skill not found");
		}
		if (await exists(destination)) {
			fail("Skill already exists");
		}
		await rename(source, destination);
	}

	private async listRoot(root: string, enabled: boolean): Promise<InstalledSkill[]> {
		const entries = await readdir(root, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isDirectory() && SKILL_NAME.test(entry.name))
			.map((entry) => ({ name: entry.name, enabled }));
	}

	private assertSkillName(name: string): void {
		if (!SKILL_NAME.test(name)) fail("Invalid Skill name");
	}

	private async ensureRoots(): Promise<void> {
		await Promise.all([
			mkdir(this.enabledRoot, { recursive: true }),
			mkdir(this.disabledRoot, { recursive: true }),
			mkdir(this.validationRoot, { recursive: true }),
		]);
	}
}
