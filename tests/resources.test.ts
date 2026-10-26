import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultResourceDirs, resolveExtensions, resolveSkills, type ResourceDirs } from "../src/resources.ts";

const tmpDirs: string[] = [];
afterEach(() => {
	for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function w(p: string, content = ""): void {
	writeFileSync(p, content);
}

/** Árbol fixture completo según spec 002 D1/D2. Devuelve dirs + base del tmp. */
function fixtureDirs(): { d: ResourceDirs; base: string } {
	const base = mkdtempSync(join(tmpdir(), "pi-herdr-res-"));
	tmpDirs.push(base);
	const home = join(base, "home");
	const piHome = join(home, ".pi", "agent");
	const d: ResourceDirs = {
		piSkills: join(piHome, "skills"),
		agentsSkills: join(home, ".agents", "skills"),
		extensions: join(piHome, "extensions"),
		settingsJson: join(piHome, "settings.json"),
		stateExt: join(piHome, "extensions", "herdr-agent-state.ts"),
		npmNodeModules: join(piHome, "npm", "node_modules"),
		gitRoot: join(piHome, "git"),
	};
	mkdirSync(join(d.piSkills, "a"), { recursive: true });
	w(join(d.piSkills, "a", "SKILL.md"), "skill a");
	w(join(d.piSkills, "c.md"), "skill c");
	mkdirSync(join(d.agentsSkills, "b"), { recursive: true });
	w(join(d.agentsSkills, "b", "SKILL.md"), "skill b");
	mkdirSync(join(d.agentsSkills, "a"), { recursive: true });
	w(join(d.agentsSkills, "a", "SKILL.md"), "skill a (agents)");
	w(join(d.agentsSkills, "d.md"), "skill d suelto");
	mkdirSync(d.extensions, { recursive: true });
	w(join(d.extensions, "loc.ts"), "// local ext");
	// packages: npm, git corto, git URL completa, git github.com, local
	const npmPkg = join(d.npmNodeModules, "pi-lens");
	mkdirSync(npmPkg, { recursive: true });
	w(join(npmPkg, "package.json"), JSON.stringify({ name: "pi-lens", pi: { extensions: ["./index.ts"] } }));
	w(join(npmPkg, "index.ts"), "// pi-lens");
	const gitPkg = join(d.gitRoot, "github.com", "kcurtet", "pi-commit");
	mkdirSync(gitPkg, { recursive: true });
	w(join(gitPkg, "package.json"), JSON.stringify({ pi: { extensions: ["./index.ts"] } }));
	w(join(gitPkg, "index.ts"), "// pi-commit");
	const gitPkg2 = join(d.gitRoot, "github.com", "kcurtet", "pi-monitor");
	mkdirSync(gitPkg2, { recursive: true });
	w(join(gitPkg2, "package.json"), JSON.stringify({ pi: { extensions: ["./index.ts"] } }));
	const gitNoPkg = join(d.gitRoot, "github.com", "o", "sinpkg");
	mkdirSync(gitNoPkg, { recursive: true });
	const settings = {
		packages: [
			"npm:pi-lens",
			"git:kcurtet/pi-commit",
			"git:https://github.com/kcurtet/pi-monitor",
			"git:github.com/o/sinpkg",
		],
		extensions: [join(base, "abs-x.ts")],
	};
	w(d.settingsJson, JSON.stringify(settings));
	w(join(base, "abs-x.ts"), "// abs");
	w(d.stateExt, "// state");
	return { d, base };
}

describe("resolveSkills", () => {
	it("nombre → piSkills primero; agentsSkills segundo; .md suelto soportado", () => {
		const { d } = fixtureDirs();
		expect(resolveSkills(["a"], d)).toEqual([join(d.piSkills, "a", "SKILL.md")]); // empate → gana pi
		expect(resolveSkills(["b"], d)).toEqual([join(d.agentsSkills, "b", "SKILL.md")]);
		expect(resolveSkills(["c"], d)).toEqual([join(d.piSkills, "c.md")]);
		expect(resolveSkills(["d"], d)).toEqual([join(d.agentsSkills, "d.md")]);
	});
	it("path directo (/, .) pasa tal cual si existe", () => {
		const { d } = fixtureDirs();
		const p = join(d.piSkills, "a", "SKILL.md");
		expect(resolveSkills([p], d)).toEqual([p]);
	});
	it("path inexistente → throw claro", () => {
		const { d } = fixtureDirs();
		expect(() => resolveSkills(["/no/existe"], d)).toThrow(/existe/i);
	});
	it("nombre sin match → throw listando dirs buscados", () => {
		const { d } = fixtureDirs();
		expect(() => resolveSkills(["zzz"], d)).toThrow(/skills/i);
	});
});

describe("resolveExtensions", () => {
	it("nombre → extensions/ loc; npm: → node_modules + entry; git: corto y URL completa → git root", () => {
		const { d } = fixtureDirs();
		expect(resolveExtensions(["loc"], d)).toEqual([join(d.extensions, "loc.ts")]);
		expect(resolveExtensions(["pi-lens"], d)).toEqual([join(d.npmNodeModules, "pi-lens", "index.ts")]);
		expect(resolveExtensions(["pi-commit"], d)).toEqual([join(d.gitRoot, "github.com", "kcurtet", "pi-commit", "index.ts")]);
		expect(resolveExtensions(["pi-monitor"], d)).toEqual([join(d.gitRoot, "github.com", "kcurtet", "pi-monitor", "index.ts")]);
	});
	it("extensions[] de settings (path directo) resuelve por basename", () => {
		const { d, base } = fixtureDirs();
		expect(resolveExtensions(["abs-x"], d)).toEqual([join(base, "abs-x.ts")]);
	});
	it("builtin:<x> pasa intacto", () => {
		const { d } = fixtureDirs();
		expect(resolveExtensions(["builtin:lens"], d)).toEqual(["builtin:lens"]);
	});
	it("path directo válido pasa", () => {
		const { d } = fixtureDirs();
		const p = join(d.extensions, "loc.ts");
		expect(resolveExtensions([p], d)).toEqual([p]);
	});
	it("github:foo/bar sin copia local → throw sugiriendo pi list", () => {
		const { d } = fixtureDirs();
		expect(() => resolveExtensions(["github:foo/bar"], d)).toThrow(/pi list/);
	});
	it("nombre sin match → throw sugiriendo pi list", () => {
		const { d } = fixtureDirs();
		expect(() => resolveExtensions(["no-existe"], d)).toThrow(/pi list/);
	});
	it("source git sin package.json → throw claro", () => {
		const { d } = fixtureDirs();
		expect(() => resolveExtensions(["sinpkg"], d)).toThrow(/package.json/i);
	});
});

describe("defaultResourceDirs", () => {
	it("deriva de PI_HOME y HOME; PI_HOME default ~/.pi/agent", () => {
		const d = defaultResourceDirs({ HOME: "/h", PI_HOME: "/p" });
		expect(d.piSkills).toBe("/p/skills");
		expect(d.settingsJson).toBe("/p/settings.json");
		expect(d.stateExt).toBe("/p/extensions/herdr-agent-state.ts");
		expect(d.gitRoot).toBe("/p/git");
		expect(d.npmNodeModules).toBe("/p/npm/node_modules");
		expect(d.agentsSkills).toBe("/h/.agents/skills");
		const d2 = defaultResourceDirs({ HOME: "/h" });
		expect(d2.piSkills).toBe("/h/.pi/agent/skills");
	});
});
