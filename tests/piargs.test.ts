import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPiArgs } from "../src/piargs.ts";
import type { ResourceDirs } from "../src/resources.ts";
import type { ResolvedDefaults } from "../src/config.ts";

const tmpDirs: string[] = [];
afterEach(() => {
	for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function dirs(withState: boolean): ResourceDirs {
	const base = mkdtempSync(join(tmpdir(), "pi-herdr-args-"));
	tmpDirs.push(base);
	const d: ResourceDirs = {
		piSkills: join(base, "skills"),
		agentsSkills: join(base, "agents-skills"),
		extensions: join(base, "extensions"),
		settingsJson: join(base, "settings.json"),
		stateExt: join(base, "extensions", "herdr-agent-state.ts"),
		npmNodeModules: join(base, "npm"),
		gitRoot: join(base, "git"),
	};
	mkdirSync(join(d.piSkills, "a"), { recursive: true });
	writeFileSync(join(d.piSkills, "a", "SKILL.md"), "a");
	mkdirSync(d.extensions, { recursive: true });
	writeFileSync(join(d.extensions, "loc.ts"), "// loc");
	writeFileSync(d.settingsJson, "{}");
	if (withState) writeFileSync(d.stateExt, "// state");
	return d;
}

function r(over: Partial<ResolvedDefaults>): ResolvedDefaults {
	return {
		skills: false,
		extensions: false,
		topology: "tab",
		kind: "pi",
		keepOpen: false,
		worktree: false,
		...over,
	};
}

describe("buildPiArgs", () => {
	it("default: --no-skills --no-extensions + exención de estado", () => {
		const d = dirs(true);
		expect(buildPiArgs(r({}), d)).toEqual(["--no-skills", "--no-extensions", "-e", d.stateExt]);
	});
	it("skills:true → sin flags de skills", () => {
		const d = dirs(true);
		expect(buildPiArgs(r({ skills: true }), d)).toEqual(["--no-extensions", "-e", d.stateExt]);
	});
	it("extensions:true → sin flags de extensions (ni exención)", () => {
		const d = dirs(true);
		expect(buildPiArgs(r({ extensions: true }), d)).toEqual(["--no-skills"]);
	});
	it("skills lista → --no-skills + --skill por ítem resuelto", () => {
		const d = dirs(true);
		const p = join(d.piSkills, "a", "SKILL.md");
		expect(buildPiArgs(r({ skills: ["a", p] }), d)).toEqual(["--no-skills", "--skill", p, "--skill", p, "--no-extensions", "-e", d.stateExt]);
	});
	it("extensions lista → --no-extensions + -e por ítem + exención al final; builtin pasa", () => {
		const d = dirs(true);
		expect(buildPiArgs(r({ extensions: ["loc", "builtin:x"] }), d)).toEqual([
			"--no-skills",
			"--no-extensions",
			"-e",
			join(d.extensions, "loc.ts"),
			"-e",
			"builtin:x",
			"-e",
			d.stateExt,
		]);
	});
	it("extensions lista que YA contiene stateExt → un solo -e para él", () => {
		const d = dirs(true);
		const args = buildPiArgs(r({ extensions: [d.stateExt] }), d);
		const count = args.filter((a) => a === d.stateExt).length;
		expect(count).toBe(1);
		// sigue habiendo --no-extensions y un único -e por item
		expect(args).toContain("--no-extensions");
	});

	it("stateExt ausente → sin -e de exención", () => {
		const d = dirs(false);
		expect(buildPiArgs(r({}), d)).toEqual(["--no-skills", "--no-extensions"]);
	});
	it("nombre de skill irresoluble → throw", () => {
		const d = dirs(true);
		expect(() => buildPiArgs(r({ skills: ["zzz"] }), d)).toThrow(/zzz/);
	});
	it("extensión irresoluble → throw", () => {
		const d = dirs(true);
		expect(() => buildPiArgs(r({ extensions: ["zzz"] }), d)).toThrow(/zzz/);
	});
});

describe("buildPiArgs — auto-exención de pi-herdr en hijos (spec 005 D2b)", () => {
	it("exemptExtensions con extensions false → -e pi-herdr tras la de estado", () => {
		const d = dirs(true);
		mkdirSync(join(d.extensions, "pi-herdr"), { recursive: true });
		writeFileSync(join(d.extensions, "pi-herdr", "index.ts"), "// herdr");
		expect(buildPiArgs(r({}), d, { exemptExtensions: ["pi-herdr"] })).toEqual([
			"--no-skills",
			"--no-extensions",
			"-e",
			d.stateExt,
			"-e",
			join(d.extensions, "pi-herdr", "index.ts"),
		]);
	});
	it("extensions lista + exempt → dedup si el usuario ya la pidió", () => {
		const d = dirs(true);
		const entry = join(d.extensions, "pi-herdr", "index.ts");
		mkdirSync(join(d.extensions, "pi-herdr"), { recursive: true });
		writeFileSync(entry, "// herdr");
		const args = buildPiArgs(r({ extensions: ["pi-herdr"] }), d, { exemptExtensions: ["pi-herdr"] });
		expect(args.filter((a) => a === entry).length).toBe(1);
		expect(args.at(-1)).toBe(entry);
	});
	it("extensions:true → SIN exención (herencia natural, intacto)", () => {
		const d = dirs(true);
		mkdirSync(join(d.extensions, "pi-herdr"), { recursive: true });
		writeFileSync(join(d.extensions, "pi-herdr", "index.ts"), "// herdr");
		expect(buildPiArgs(r({ extensions: true }), d, { exemptExtensions: ["pi-herdr"] })).toEqual(["--no-skills"]);
	});
	it("exempt irresoluble (no instalado) → se omite en silencio", () => {
		const d = dirs(true);
		expect(buildPiArgs(r({}), d, { exemptExtensions: ["pi-herdr"] })).toEqual(["--no-skills", "--no-extensions", "-e", d.stateExt]);
	});
	it("sin opts → args idénticos a hoy (regresión)", () => {
		const d = dirs(true);
		mkdirSync(join(d.extensions, "pi-herdr"), { recursive: true });
		writeFileSync(join(d.extensions, "pi-herdr", "index.ts"), "// herdr");
		expect(buildPiArgs(r({}), d)).toEqual(["--no-skills", "--no-extensions", "-e", d.stateExt]);
	});
});
