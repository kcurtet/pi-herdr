import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectSetupCommand, LOCKFILE_COMMANDS, parseSetupMode } from "../src/setup.ts";

const tmpDirs: string[] = [];
afterEach(() => {
	for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpRepo(files: string[]): string {
	const repo = mkdtempSync(join(tmpdir(), "pi-herdr-setup-"));
	tmpDirs.push(repo);
	for (const f of files) {
		mkdirSync(join(repo, f, ".."), { recursive: true });
		writeFileSync(join(repo, f), "");
	}
	return repo;
}

describe("parseSetupMode (pura)", () => {
	it("worktree true: omitido y \"auto\" → auto", () => {
		expect(parseSetupMode(undefined, true)).toEqual({ kind: "auto" });
		expect(parseSetupMode("auto", true)).toEqual({ kind: "auto" });
	});

	it("worktree true: \"none\" → none; literal pasa intacto (incluye &&)", () => {
		expect(parseSetupMode("none", true)).toEqual({ kind: "none" });
		expect(parseSetupMode("npm install && npm run build", true)).toEqual({
			kind: "literal",
			command: "npm install && npm run build",
		});
	});

	it("worktree true: \"\" → error de validación", () => {
		expect(() => parseSetupMode("", true)).toThrow(/no válido/);
	});

	it("worktree true: \"NONE\" mayúsculas → literal case-sensitive", () => {
		expect(parseSetupMode("NONE", true)).toEqual({ kind: "literal", command: "NONE" });
	});

	it("worktree false: \"auto\" o literal → error temprano (setup sin worktree)", () => {
		expect(() => parseSetupMode("auto", false)).toThrow(/worktree/);
		expect(() => parseSetupMode("npm ci", false)).toThrow(/worktree/);
	});

	it("worktree false: omitido o \"none\" → no-op sin error", () => {
		expect(parseSetupMode(undefined, false)).toEqual({ kind: "none" });
		expect(parseSetupMode("none", false)).toEqual({ kind: "none" });
	});
});

describe("detectSetupCommand (pura, prioridad lockfiles)", () => {
	it("pnpm-lock.yaml gana sobre package-lock.json (prioridad fija)", () => {
		const repo = tmpRepo(["pnpm-lock.yaml", "package-lock.json"]);
		expect(detectSetupCommand(repo)).toBe("pnpm install --frozen-lockfile");
	});

	it("mapa completo por gestor", () => {
		expect(detectSetupCommand(tmpRepo(["bun.lock"]))).toBe("bun install");
		expect(detectSetupCommand(tmpRepo(["bun.lockb"]))).toBe("bun install");
		expect(detectSetupCommand(tmpRepo(["yarn.lock"]))).toBe("yarn install --immutable");
		expect(detectSetupCommand(tmpRepo(["package-lock.json"]))).toBe("npm ci");
	});

	it("sin lockfile conocido → undefined", () => {
		expect(detectSetupCommand(tmpRepo(["Cargo.lock"]))).toBeUndefined();
		expect(detectSetupCommand(tmpRepo([]))).toBeUndefined();
	});

	it("LOCKFILE_COMMANDS: el orden del array ES la prioridad spec (pnpm>bun>yarn>npm)", () => {
		expect(LOCKFILE_COMMANDS.map((c) => c.file)).toEqual([
			"pnpm-lock.yaml",
			"bun.lock",
			"bun.lockb",
			"yarn.lock",
			"package-lock.json",
		]);
	});
});
