/**
 * Comando de preparación del worktree (spec 003).
 *
 * Modos (case-sensitive): omitido/"auto" → detección por lockfile; "none" →
 * sin setup (escape hatch); cualquier otro string → literal vía `bash -c`.
 * Fallo del setup = fallo del dispatch (abort + rollback conservador).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RunFailure, RunFn } from "./herdr.ts";

/** Modo resuelto de setupCommand. */
export type SetupMode =
	| { kind: "none" }
	| { kind: "auto" }
	| { kind: "literal"; command: string };

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

/** Pure: primer lockfile conocido (por prioridad) → su comando; undefined si no hay.
 * Sin seam de `exists`: los tests golpean el FS real (tmpdirs), que es el
 * comportamiento que importa (minor 1, issue #18 — seam sin callers). */
export function detectSetupCommand(repoRoot: string): string | undefined {
	for (const { file, command } of LOCKFILE_COMMANDS) {
		if (existsSync(join(repoRoot, file))) return command;
	}
	return undefined;
}

/** Timeout propio del setup (spec R8): 10 min; los comandos de control herdr siguen a 15s. */
export const SETUP_TIMEOUT_MS = 600_000;

const TAIL_CHARS = 2_000;

/** Tail de salida para errores: stderr con fallback a stdout, últimos ~2000 chars. */
function tailOf(stderr: string, stdout: string): string {
	return (stderr.trim() || stdout.trim()).slice(-TAIL_CHARS);
}

/**
 * Mutex en-proceso (spec D6): los setups de dispatches concurrentes corren uno
 * tras otro. Serializa la EJECUCIÓN, no los fallos: si una setup rechaza, la
 * siguiente arranca igual (queue = next.catch(() => undefined)).
 *
 * Exportado pese a no tener callers de producción: es la unidad bajo prueba
 * del mutex (tests/setup.test.ts) — testearla a través de dispatch sería un
 * test de integración acoplado al ruido. Ruling minor 2, issue #18.
 */
let queue: Promise<unknown> = Promise.resolve();
export function serializeSetup<T>(fn: () => Promise<T>): Promise<T> {
	const next = queue.then(fn, fn);
	queue = next.catch(() => undefined);
	return next;
}

/**
 * Ejecuta el setup: `bash -c <command>` oculto en cwd (dir del worktree), con
 * timeout propio. Éxito → { elapsedMs, queuedMs }: elapsedMs es wall-clock
 * DESDE LA ENTRADA a runSetup — incluye la espera del mutex (spec D6), porque
 * es el tiempo que el usuario percibe; queuedMs desglosa esa espera (minor 4,
 * issue #18). Fallo (exit != 0 o timeout) → throw con comando + motivo + tail
 * de salida (output parcial del Error en timeout, adjuntado por localRun).
 */
export async function runSetup(
	run: RunFn,
	o: { command: string; cwd: string; timeoutMs?: number },
): Promise<{ elapsedMs: number; queuedMs: number }> {
	const entered = Date.now();
	return serializeSetup(async () => {
		const start = Date.now();
		const queuedMs = start - entered;
		let result: { code: number; stdout: string; stderr: string };
		try {
			result = await run("bash", ["-c", o.command], {
				cwd: o.cwd,
				timeoutMs: o.timeoutMs ?? SETUP_TIMEOUT_MS,
			});
		} catch (err) {
			// localRun SOLO lanza en timeout (Error con stdout/stderr parciales y flag
			// `timedOut`, T1). Una RunFn inyectada que lance otra cosa es out-of-contract:
			// se distingue por el flag, no se etiqueta a ciegas (minor 3, issue #18)
			const e = err as RunFailure;
			const reason = e.timedOut === true ? "timeout" : `excepción: ${e.message}`;
			throw new Error(`pi-herdr: setup "${o.command}" falló (${reason})\n${tailOf(e.stderr ?? "", e.stdout ?? "")}`);
		}
		if (result.code !== 0) {
			throw new Error(
				`pi-herdr: setup "${o.command}" falló (exit ${result.code})\n${tailOf(result.stderr, result.stdout)}`,
			);
		}
		return { elapsedMs: Date.now() - entered, queuedMs };
	});
}
