import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupWorktree, createWorktree, decideCleanup } from "../src/worktree.ts";
import { localRun, type RunFn } from "../src/herdr.ts";
import { ok } from "./helpers.ts";

interface GitCall {
	file: string;
	args: string[];
}

/** Mock RunFn para git: enruta por args[2] (subcomando tras -C <dir>). */
function gitRun(routes: Record<string, { code: number; stdout: string; stderr?: string }>): {
	run: RunFn;
	calls: GitCall[];
} {
	const calls: GitCall[] = [];
	const run: RunFn = async (file, args) => {
		calls.push({ file, args });
		if (file !== "git") return { code: 1, stdout: "", stderr: `not git: ${file}` };
		const sub = args[2] ?? "";
		const r = routes[sub];
		if (!r) return { code: 1, stdout: "", stderr: `unmocked git ${sub}` };
		return { code: r.code, stdout: r.stdout, stderr: r.stderr ?? "" };
	};
	return { run, calls };
}

const tmpDirs: string[] = [];
afterEach(() => {
	for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpRepo(): string {
	const base = mkdtempSync(join(tmpdir(), "pi-herdr-"));
	tmpDirs.push(base);
	const repo = join(base, "repo");
	mkdirSync(repo);
	return repo;
}

describe("decideCleanup (pura)", () => {
	it("limpio y merged → remove", () => {
		expect(decideCleanup("", true)).toEqual({ action: "remove" });
	});
	it("WIP → keep dirty (nunca borrar trabajo)", () => {
		expect(decideCleanup(" M src/x.ts", true)).toEqual({ action: "keep", reason: "dirty" });
	});
	it("sin merge → keep unmerged", () => {
		expect(decideCleanup("", false)).toEqual({ action: "keep", reason: "unmerged" });
	});
});

describe("createWorktree", () => {
	it("rama hd/<name> desde HEAD en <parent>/.hd-worktrees/<name>; devuelve repo toplevel", async () => {
		const repo = tmpRepo();
		const { run, calls } = gitRun({ "rev-parse": ok(repo), worktree: ok("") });
		const r = await createWorktree(run, { repo, name: "impl-x" });
		expect(r).toEqual({ repo, dir: join(repo, "..", ".hd-worktrees", "impl-x"), branch: "hd/impl-x" });
		const add = calls.find((c) => c.args[2] === "worktree")!;
		expect(add.args).toEqual(["-C", repo, "worktree", "add", "-b", "hd/impl-x", r.dir]);
	});

	it("dir destino existente → throw, nunca sobreescribe", async () => {
		const repo = tmpRepo();
		const dir = join(repo, "..", ".hd-worktrees", "impl-x");
		mkdirSync(dir, { recursive: true });
		const { run } = gitRun({ "rev-parse": ok(repo) });
		await expect(createWorktree(run, { repo, name: "impl-x" })).rejects.toThrow(/existe/i);
	});

	it("cwd no es repo git → throw claro", async () => {
		const repo = tmpRepo();
		const { run } = gitRun({ "rev-parse": { code: 128, stdout: "", stderr: "not a git repository" } });
		await expect(createWorktree(run, { repo, name: "x" })).rejects.toThrow(/repo git/i);
	});
});

describe("cleanupWorktree", () => {
	it("limpio y merged: worktree remove + branch -d (nunca -D)", async () => {
		const repo = tmpRepo();
		const dir = join(repo, "..", ".hd-worktrees", "impl-x");
		const { run, calls } = gitRun({
			status: ok(""),
			branch: ok("* main\n  hd/impl-x\n"),
			worktree: ok(""),
		});
		const r = await cleanupWorktree(run, { repo, dir, branch: "hd/impl-x" });
		expect(r).toEqual({ removed: true });
		const del = calls.find((c) => c.args[2] === "branch" && c.args.includes("-d"))!;
		expect(del.args).toContain("-d");
		expect(del.args).not.toContain("-D");
		expect(calls.find((c) => c.args[2] === "worktree")!.args).toContain("remove");
	});

	it("rama checked-out en el worktree (prefijo +) cuenta como merged", async () => {
		// git marca con + las ramas checked out en otro worktree: al momento del
		// cleanup la nuestra SIEMPRE lo está (el worktree aún existe)
		const repo = tmpRepo();
		const dir = join(repo, "..", ".hd-worktrees", "impl-x");
		const { run } = gitRun({
			status: ok(""),
			branch: ok("* main\n+ hd/impl-x\n"),
			worktree: ok(""),
		});
		const r = await cleanupWorktree(run, { repo, dir, branch: "hd/impl-x" });
		expect(r).toEqual({ removed: true });
	});

	it("dirty: NO toca git, reporta keep/dirty", async () => {
		const repo = tmpRepo();
		const { run, calls } = gitRun({ status: ok(" M a.ts"), branch: ok("* main\n  hd/x") });
		const r = await cleanupWorktree(run, { repo, dir: "/d", branch: "hd/x" });
		expect(r).toEqual({ removed: false, reason: "dirty" });
		expect(calls.filter((c) => ["worktree", "branch"].includes(c.args[2] ?? ""))).toHaveLength(0);
	});

	it("unmerged: keep/unmerged sin borrar nada", async () => {
		const repo = tmpRepo();
		const { run, calls } = gitRun({ status: ok(""), branch: ok("* main\n  otra") });
		const r = await cleanupWorktree(run, { repo, dir: "/d", branch: "hd/x" });
		expect(r).toEqual({ removed: false, reason: "unmerged" });
		expect(calls.filter((c) => (c.args[2] ?? "") === "worktree")).toHaveLength(0);
	});
});

describe("integración con git real", () => {
	function realRepo(): string {
		const base = mkdtempSync(join(tmpdir(), "pi-herdr-git-"));
		tmpDirs.push(base);
		const repo = join(base, "repo");
		mkdirSync(repo);
		const gitEnv = {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@t",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@t",
		};
		execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"], { encoding: "utf8" });
		execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "init"], { encoding: "utf8", env: gitEnv });
		return repo;
	}

	it("createWorktree + cleanupWorktree reales: worktree y rama vacía se eliminan", async () => {
		const repo = realRepo();
		const created = await createWorktree(localRun, { repo, name: "e2e-x" });
		expect(created.repo).toBe(repo);
		expect(existsSync(created.dir)).toBe(true);
		// rama SIN commits nuevos: el conservador DEBE poder eliminarla (bug del prefijo +)
		const r = await cleanupWorktree(localRun, created);
		expect(r.removed).toBe(true);
		expect(existsSync(created.dir)).toBe(false);
		expect(execFileSync("git", ["-C", repo, "branch", "--list", "hd/e2e-x"], { encoding: "utf8" }).trim()).toBe("");
	});

	it("cleanup con WIP real: conserva el worktree", async () => {
		const repo = realRepo();
		const created = await createWorktree(localRun, { repo, name: "wip-x" });
		writeFileSync(join(created.dir, "wip.txt"), "trabajo sin commitear");
		const r = await cleanupWorktree(localRun, created);
		expect(r).toEqual({ removed: false, reason: "dirty" });
		expect(existsSync(created.dir)).toBe(true);
	});
});
