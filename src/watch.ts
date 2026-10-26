/**
 * Watcher de agente herdr: ciclo wait-driven (adaptado del motor de pi-monitor).
 *
 * Cada ciclo: spawn de `herdr agent wait <name>` → al salir, clasificar el
 * estado → delegar en onEvent. onEvent devuelve true para re-armar (blocked,
 * keepOpen) y false para terminar. `gone` nunca re-arma.
 *
 * El armado inicial arranca en fase "working" (issue #7): confirmar que el
 * turno arrancó antes de aceptar estados de settle — `herdr agent wait` sin
 * --until cae al instante si el estado ya es terminal, y durante la latencia
 * prompt→turno herdr aún reporta idle (settle falso → auto-close mataba al
 * agente a los ~5s del dispatch).
 */
import { type ChildProcess } from "node:child_process";
import { agentRead, type RunFn } from "./herdr.ts";

export type WatchEvent =
	| { kind: "blocked" }
	| { kind: "settled"; state: "idle" | "done"; output: string }
	| { kind: "gone"; reason: string };

export interface WatchDeps {
	run: RunFn;
	spawnWait: (name: string, phase?: "settle" | "working") => ChildProcess;
}

export interface WatchHandle {
	stop(): void;
}

export function armWatcher(
	deps: WatchDeps,
	name: string,
	onEvent: (ev: WatchEvent) => Promise<boolean>,
): WatchHandle {
	let stopped = false;
	let current: ChildProcess | undefined;

	const killCurrent = (): void => {
		current?.kill("SIGTERM");
		const t = setTimeout(() => current?.kill("SIGKILL"), 5_000);
		t.unref?.();
	};

	const deliver = async (ev: WatchEvent): Promise<void> => {
		if (stopped) return;
		let again = false;
		try {
			again = await onEvent(ev);
		} catch {
			again = false;
		}
		if (stopped) return;
		if (!again || ev.kind === "gone") {
			stopped = true;
			return;
		}
		// keepOpen tras settle: esperar a que el agente VUELVA a trabajar antes del
		// ciclo normal — si no, wait retorna al instante y buclea en caliente (issue #5)
		if (ev.kind === "settled") {
			cycle("working");
		} else {
			cycle();
		}
	};

	const cycle = (phase: "settle" | "working" = "settle"): void => {
		if (stopped) return;
		const child = deps.spawnWait(name, phase);
		current = child;
		let stdout = "";
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (c: string) => {
			stdout += c;
		});
		let stderr = "";
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (c: string) => {
			stderr += c;
		});
		child.on("error", (err) => {
			void deliver({ kind: "gone", reason: `spawn error: ${err.message}` });
		});
		child.on("close", (code) => {
			current = undefined;
			if (stopped) return;
			if (code !== 0) {
				const detail = stderr.trim().slice(0, 200);
				void deliver({ kind: "gone", reason: `wait exited ${code}${detail ? `: ${detail}` : ""}` });
				return;
			}
			let status = "unknown";
			try {
				status = (JSON.parse(stdout) as { result?: { agent?: { agent_status?: string } } })
					?.result?.agent?.agent_status ?? "unknown";
			} catch {
				// JSON ilegible → unknown
			}
			if (status === "blocked") {
				void deliver({ kind: "blocked" });
				return;
			}
			if (status === "idle" || status === "done") {
				void (async () => {
					let output = "";
					try {
						output = await agentRead(deps.run, { name });
					} catch (err) {
						output = `[read error] ${(err as Error).message}`;
					}
					await deliver({ kind: "settled", state: status, output });
				})();
				return;
			}
			if (status === "working" && phase === "working") {
				// el agente volvió a trabajar: entrar al ciclo normal de settle
				cycle();
				return;
			}
			void deliver({ kind: "gone", reason: `estado no reconocido tras wait: ${status}` });
		});
	};

		// issue #7: fase working inicial — no aceptar settle hasta ver el turno arrancar
		cycle("working");
		return {
				stop(): void {
			stopped = true;
			killCurrent();
		},
	};
}
