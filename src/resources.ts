/**
 * Resolución de skills y extensiones por nombre (spec 002 D1/D2).
 *
 * Todo contra ResourceDirs inyectables: los tests usan árboles temporales y
 * la extensión real usa defaultResourceDirs(process.env).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export interface ResourceDirs {
	piSkills: string;
	agentsSkills: string;
	extensions: string;
	settingsJson: string;
	stateExt: string;
	npmNodeModules: string;
	gitRoot: string;
}

export function defaultResourceDirs(env: Record<string, string | undefined>): ResourceDirs {
	const home = env.HOME ?? "/home/user";
	const piHome = env.PI_HOME ?? join(home, ".pi", "agent");
	return {
		piSkills: join(piHome, "skills"),
		agentsSkills: join(home, ".agents", "skills"),
		extensions: join(piHome, "extensions"),
		settingsJson: join(piHome, "settings.json"),
		stateExt: join(piHome, "extensions", "herdr-agent-state.ts"),
		npmNodeModules: join(piHome, "npm", "node_modules"),
		gitRoot: join(piHome, "git"),
	};
}

function isPath(item: string): boolean {
	return item.startsWith("/") || item.startsWith(".");
}

/** Busca <name>/SKILL.md y luego <name>.md en los dirs, en orden. */
function resolveSkillItem(item: string, d: ResourceDirs): string {
	if (isPath(item)) {
		if (existsSync(item)) return item;
		throw new Error(`pi-herdr: skill path inexistente: ${item}`);
	}
	const dirs = [d.piSkills, d.agentsSkills];
	for (const dir of dirs) {
		const p = join(dir, item, "SKILL.md");
		if (existsSync(p)) return p;
	}
	for (const dir of dirs) {
		const p = join(dir, `${item}.md`);
		if (existsSync(p)) return p;
	}
	throw new Error(`pi-herdr: skill "${item}" no encontrada (buscado en: ${dirs.join(", ")})`);
}

interface ParsedSettings {
	packages?: string[];
	extensions?: string[];
}

function readSettings(d: ResourceDirs): ParsedSettings {
	try {
		return JSON.parse(readFileSync(d.settingsJson, "utf8")) as ParsedSettings;
	} catch {
		return {};
	}
}

/** Entry de un paquete pi: package.json → pi.extensions[0], absoluto. */
function packageEntry(pkgDir: string): string {
	const pkgPath = join(pkgDir, "package.json");
	if (!existsSync(pkgPath)) {
		throw new Error(`pi-herdr: ${pkgDir} no tiene package.json (¿instalación incompleta?)`);
	}
	try {
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { pi?: { extensions?: string[] } };
		const entry = pkg.pi?.extensions?.[0];
		if (!entry) throw new Error("sin pi.extensions");
		return join(pkgDir, entry);
	} catch (err) {
		throw new Error(`pi-herdr: package.json ilegible o sin pi.extensions en ${pkgDir}: ${(err as Error).message}`);
	}
}

/** git:<url> → {host, owner, repo}; host default github.com. Formas: o/r, github.com/o/r, https://host/o/r(.git). */
function parseGitSource(src: string): { host: string; owner: string; repo: string } | undefined {
	const m =
		/^git:(?:https?:\/\/)?([^/]+)\/([^/]+)\/([^/#?]+?)(?:\.git)?$/.exec(src) ??
		/^git:([^/]+)\/([^/#?]+?)(?:\.git)?$/.exec(src);
	if (!m) return undefined;
	if (m.length === 4) return { host: m[1]!, owner: m[2]!, repo: m[3]! };
	return { host: "github.com", owner: m[1]!, repo: m[2]! };
}

function resolveExtensionItem(item: string, d: ResourceDirs): string {
	if (item.startsWith("builtin:")) return item;
	if (isPath(item)) {
		if (existsSync(item)) return item;
		throw new Error(`pi-herdr: extensión path inexistente: ${item}`);
	}
	// 1. ~/.pi/agent/extensions/<name> (dir o .ts/.js)
	for (const cand of [join(d.extensions, item), `${join(d.extensions, item)}.ts`, `${join(d.extensions, item)}.js`]) {
		if (existsSync(cand)) return cand;
	}
	// github:o/r directo
	if (item.includes("/")) {
		const parsed = parseGitSource(`git:${item}`);
		if (parsed) {
			const dir = join(d.gitRoot, parsed.host, parsed.owner, parsed.repo);
			if (existsSync(dir)) return packageEntry(dir);
		}
	}
	const settings = readSettings(d);
	// 2. extensions[] (paths directos) por basename
	for (const entry of settings.extensions ?? []) {
		const b = basename(entry);
		if (b === item || b.startsWith(`${item}.`)) return entry;
	}
	// 3. packages[]: npm: / git: / local
	for (const src of settings.packages ?? []) {
		if (src.startsWith("npm:")) {
			const name = src.slice(4).split("@")[0]!;
			if (name === item || basename(name) === item) {
				const dir = join(d.npmNodeModules, name);
				if (existsSync(dir)) return packageEntry(dir);
			}
			continue;
		}
		const parsed = parseGitSource(src);
		if (parsed && parsed.repo === item) {
			const dir = join(d.gitRoot, parsed.host, parsed.owner, parsed.repo);
			if (existsSync(dir)) return packageEntry(dir);
		}
	}
	throw new Error(`pi-herdr: extensión "${item}" no encontrada (dirs + settings). Usa \`pi list\` para ver las instaladas.`);
}

export function resolveSkills(items: string[], d: ResourceDirs): string[] {
	return items.map((i) => resolveSkillItem(i, d));
}

export function resolveExtensions(items: string[], d: ResourceDirs): string[] {
	return items.map((i) => resolveExtensionItem(i, d));
}

/** Nombres de skills disponibles (autocompletado): pi primero, sin duplicar. */
export function listSkillNames(d: ResourceDirs): string[] {
	const names: string[] = [];
	const seen = new Set<string>();
	for (const dir of [d.piSkills, d.agentsSkills]) {
		let entries: string[] = [];
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		for (const e of entries) {
			const name = e.endsWith(".md") ? e.slice(0, -3) : existsSync(join(dir, e, "SKILL.md")) ? e : null;
			if (name && !seen.has(name)) {
				seen.add(name);
				names.push(name);
			}
		}
	}
	return names;
}

/** Nombres de extensiones instaladas (autocompletado): extensions dir + packages + extensions[]. */
export function listExtNames(d: ResourceDirs): string[] {
	const names: string[] = [];
	const seen = new Set<string>();
	const push = (n: string): void => {
		if (!seen.has(n)) {
			seen.add(n);
			names.push(n);
		}
	};
	try {
		for (const e of readdirSync(d.extensions)) {
			if (e === "herdr-agent-state.ts") continue;
			push(e.replace(/\.(ts|js)$/, ""));
		}
	} catch {
		// sin dir
	}
	const settings = readSettings(d);
	for (const entry of settings.extensions ?? []) push(basename(entry).replace(/\.(ts|js)$/, ""));
	for (const src of settings.packages ?? []) {
		if (src.startsWith("npm:")) push(src.slice(4).split("@")[0]!);
		else {
			const parsed = parseGitSource(src);
			if (parsed) push(parsed.repo);
		}
	}
	return names;
}
