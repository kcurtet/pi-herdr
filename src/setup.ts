/**
 * Comando de preparación del worktree (spec 003).
 *
 * Modos (case-sensitive): omitido/"auto" → detección por lockfile; "none" →
 * sin setup (escape hatch); cualquier otro string → literal vía `bash -c`.
 * Fallo del setup = fallo del dispatch (abort + rollback conservador).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Modo resuelto de setupCommand. */
export type SetupMode =
	| { kind: "none" }
	| { kind: "auto" }
	| { kind: "literal"; command: string };

export type ExistsFn = (path: string) => boolean;

/**
 * Lockfile → comando de instalación. El ORDEN del array es la prioridad
 * (spec 003 D2): pnpm > bun > yarn > npm (`package-lock.json` el último
 * porque suele ser legacy en repos en transición).
 */
export const LOCKFILE_COMMANDS: readonly { readonly file: string; readonly command: string }[] = [
	{ file: "pnpm-lock.yaml", command: "pnpm install --frozen-lockfile" },
	{ file: "bun.lock", command: "bun install" },
	{ file: "bun.lockb", command: "bun install" },
	{ file: "yarn.lock", command: "yarn install --immutable" },
	{ file: "package-lock.json", command: "npm ci" },
];

/** Pure: valida setupCommand contra worktree efectivo. Throw = error temprano (D1). */
export function parseSetupMode(setupCommand: string | undefined, worktree: boolean): SetupMode {
	if (setupCommand === "none") return { kind: "none" };
	// omitido: auto en despachos worktree (default opinionado), no-op fuera (cero regresión)
	if (setupCommand === undefined) return worktree ? { kind: "auto" } : { kind: "none" };
	if (setupCommand === "") {
		throw new Error('pi-herdr: setupCommand "" no válido (usa "none" para desactivar o un comando real)');
	}
	if (!worktree) {
		throw new Error(
			`pi-herdr: setupCommand "${setupCommand}" solo aplica con worktree:true (ejecutarlo en el cwd real es un side effect no pedido)`,
		);
	}
	if (setupCommand === "auto") return { kind: "auto" };
	return { kind: "literal", command: setupCommand };
}

/** Pure: primer lockfile conocido (por prioridad) → su comando; undefined si no hay. */
export function detectSetupCommand(repoRoot: string, exists: ExistsFn = existsSync): string | undefined {
	for (const { file, command } of LOCKFILE_COMMANDS) {
		if (exists(join(repoRoot, file))) return command;
	}
	return undefined;
}
