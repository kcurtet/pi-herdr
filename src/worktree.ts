/**
 * Worktree efímero para despachos aislados (spec D5).
 *
 * Creación: rama hd/<name> desde HEAD, directorio hermano del repo
 * (<repo>/../.hd-worktrees/<name>). Cleanup CONSERVADOR: solo se borra con
 * working tree limpio y rama fully-merged; jamás se destruye trabajo.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RunFn } from "./herdr.ts";

export type CleanupDecision = { action: "remove" } | { action: "keep"; reason: "dirty" | "unmerged" };

/** Pure: decide a partir del status --porcelain y si la rama está merged en HEAD. */
export function decideCleanup(statusPorcelain: string, mergedIntoHead: boolean): CleanupDecision {
	if (statusPorcelain.trim() !== "") return { action: "keep", reason: "dirty" };
	if (!mergedIntoHead) return { action: "keep", reason: "unmerged" };
	return { action: "remove" };
}

async function git(run: RunFn, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return run("git", ["-C", ...args]);
}

export async function createWorktree(
	run: RunFn,
	o: { repo: string; name: string },
): Promise<{ repo: string; dir: string; branch: string }> {
	const top = await git(run, [o.repo, "rev-parse", "--show-toplevel"]);
	if (top.code !== 0) {
		throw new Error(`pi-herdr: "${o.repo}" no es un repo git (worktree:true lo requiere)`);
	}
	const repoRoot = top.stdout.trim().split("\n")[0]!;
	const dir = join(dirname(repoRoot), ".hd-worktrees", o.name);
	if (existsSync(dir)) {
		throw new Error(`pi-herdr: el worktree destino ya existe: ${dir} (despacho previo sin limpiar)`);
	}
	const branch = `hd/${o.name}`;
	const add = await git(run, [repoRoot, "worktree", "add", "-b", branch, dir]);
	if (add.code !== 0) {
		throw new Error(`pi-herdr: git worktree add falló: ${add.stderr.trim()}`);
	}
	return { repo: repoRoot, dir, branch };
}

export async function cleanupWorktree(
	run: RunFn,
	o: { repo: string; dir: string; branch: string },
): Promise<{ removed: boolean; reason?: string }> {
	// repo-path del worktree puede diferir; el repo original siempre es válido
	const status = await git(run, [o.dir, "status", "--porcelain"]);
	const statusText = status.code === 0 ? status.stdout : "?? (status falló; conservar)";
	if (statusText.trim() !== "") return { removed: false, reason: "dirty" };
	const merged = await git(run, [o.repo, "branch", "--merged", "HEAD"]);
	const mergedBranches = new Set(
		merged.stdout
			.split("\n")
			// '+ ' = rama checked out en otro worktree (la nuestra, al cleanup time); '* ' = actual
			.map((l) => l.replace(/^[*+]\s*/, "").trim())
			.filter(Boolean),
	);
	// aquí statusText ya es limpio: decideCleanup solo puede dar remove|unmerged
	const decision = decideCleanup(statusText, mergedBranches.has(o.branch));
	if (decision.action === "keep") {
		return { removed: false, reason: decision.reason };
	}
	const remove = await git(run, [o.repo, "worktree", "remove", o.dir]);
	if (remove.code !== 0) {
		return { removed: false, reason: `worktree remove falló: ${remove.stderr.trim().slice(0, 120)}` };
	}
	// -d (nunca -D): si la rama no estuviera merged, git se niega y conservamos
	const del = await git(run, [o.repo, "branch", "-d", o.branch]);
	if (del.code !== 0) {
		return { removed: true, reason: `rama ${o.branch} no borrada: ${del.stderr.trim().slice(0, 120)}` };
	}
	return { removed: true };
}
