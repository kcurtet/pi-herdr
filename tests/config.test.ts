import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDefaults, mergeInput, saveDefaults, type DispatchDefaults } from "../src/config.ts";

const tmpDirs: string[] = [];
afterEach(() => {
	for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpPath(): string {
	const d = mkdtempSync(join(tmpdir(), "pi-herdr-cfg-"));
	tmpDirs.push(d);
	return join(d, "pi-herdr.json");
}

describe("loadDefaults", () => {
	it("fichero inexistente → {} sin warnings", () => {
		const r = loadDefaults(join(tmpPath(), "..", "no-existe.json"));
		expect(r).toEqual({ defaults: {}, warnings: [] });
	});
	it("JSON roto → warning, nunca throw", () => {
		const p = tmpPath();
		saveDefaults(p, { keepOpen: true });
		writeFileSync(p, "{broken");
		const r = loadDefaults(p);
		expect(r.defaults).toEqual({});
		expect(r.warnings.length).toBe(1);
	});
	it("valores no válidos → warning y se ignoran; válidos pasan", () => {
		const p = tmpPath();
		writeFileSync(
			p,
			JSON.stringify({
				defaults: { topology: "x", kind: 5, keepOpen: true, skills: ["a"], extensions: false, worktree: "si" },
			}),
		);
		const r = loadDefaults(p);
		expect(r.defaults).toEqual({ keepOpen: true, skills: ["a"], extensions: false });
		expect(r.warnings.join(" ")).toMatch(/topology/);
		expect(r.warnings.join(" ")).toMatch(/kind/);
		expect(r.warnings.join(" ")).toMatch(/worktree/);
	});
});

describe("saveDefaults / roundtrip", () => {
	it("guarda exacto (tab, newline) y load lo recupera", () => {
		const p = tmpPath();
		const d: DispatchDefaults = { skills: true, extensions: ["pi-monitor"], topology: "pane", kind: "pi", keepOpen: false, worktree: true };
		saveDefaults(p, d);
		expect(readFileSync(p, "utf8").endsWith("\n")).toBe(true);
		expect(loadDefaults(p)).toEqual({ defaults: d, warnings: [] });
	});
	it("save vacía = reset total", () => {
		const p = tmpPath();
		saveDefaults(p, { keepOpen: true });
		saveDefaults(p, {});
		expect(loadDefaults(p).defaults).toEqual({});
	});
});

describe("mergeInput — param > config > builtin", () => {
	it("sin param ni config → builtin defaults", () => {
		const r = mergeInput({}, {});
		expect(r).toEqual({ skills: false, extensions: false, topology: "tab", kind: "pi", keepOpen: false, worktree: false });
	});
	it("config llena keys sin param", () => {
		const r = mergeInput({}, { skills: true, topology: "pane", worktree: true });
		expect(r.skills).toBe(true);
		expect(r.topology).toBe("pane");
		expect(r.worktree).toBe(true);
		expect(r.extensions).toBe(false); // builtin
	});
	it("param explícito gana por key, incluso [] y false", () => {
		const r = mergeInput({ skills: ["a"], extensions: false, topology: "tab" }, { skills: true, extensions: ["x"], topology: "pane" });
		expect(r.skills).toEqual(["a"]);
		expect(r.extensions).toBe(false);
		expect(r.topology).toBe("tab");
	});
	it("param [] cuenta como explícito → false", () => {
		const r = mergeInput({ skills: [] }, { skills: ["a"] });
		expect(r.skills).toEqual([]);
	});
});
