/**
 * Watcher de agente herdr: ciclo wait-driven (adaptado del motor de pi-monitor).
 *
 * Cada ciclo: spawn de `herdr agent wait <name>` → al salir, clasificar el
 * estado → delegar en onEvent. onEvent devuelve true para re-armar (blocked,
 * keepOpen) y false para terminar. `gone` nunca re-arma.
 *
 * Fases (issue #7): `herdr agent wait` es level-triggered — matchea al instante
 * si el estado ACTUAL ya está en el until-set, y bloquea hasta que lo esté.
 * - arm (inicial): working|blocked|done. Confirmar que el turno arrancó antes
 *   de aceptar settle; sin --until, durante la latencia prompt→turno herdr aún
 *   reporta idle → settle falso → auto-close mataba al agente a los ~5s.
 *   done/blocked cubren al agente ultra-rápido o bloqueado antes del armado.
 * - rearm (keepOpen tras settle): working|blocked. NUNCA done/idle — el estado
 *   actual es precisamente el acabado de reportar y el wait lo instant-matchea
 *   (flood de eventos con triggerTurn, finding 1 de la revisión #7).
 * - rearmBlocked (re-arm tras evento blocked): working|idle|done. El estado
 *   actual es el blocked recién reportado y el settle por defecto
 *   (idle|done|blocked) lo instant-matchea → spam infinito de eventos blocked
 *   con triggerTurn mientras el humano decide (issue #8). NUNCA blocked:
 *   esperar un CAMBIO — el agente reanuda (working) o termina (idle|done). Un
 *   blocked NUEVO (reanuda y vuelve a bloquearse) llega vía el settle posterior,
 *   ya con un cambio de por medio.
 * - settle: sin --until (herdr matchea idle|done|blocked por defecto).
 *
 * Hang aceptado (trade-off): un agente cuyo turno nunca arranca (pane vivo con
 * idle persistente, p.ej. pi muerto) deja el watcher bloqueado en fase arm/rearm
 * y el record `live` en herdr_agents. Escape manual: herdr_stop.
 */
import { type ChildProcess } from "node:child_process";
import { agentRead, type RunFn } from "./herdr.ts";

export type WaitPhase = "settle" | "arm" | "rearm" | "rearmBlocked";

export type WatchEvent =
	| { kind: "blocked" }
	| { kind: "settled"; state: "idle" | "done"; output: string }
	| { kind: "gone"; reason: string };

export interface WatchDeps {
	run: RunFn;
	spawnWait: (name: string, phase?: WaitPhase) => ChildProcess;
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
		if (ev.kind === "settled") {
			// keepOpen tras settle: esperar a que el agente VUELVA a trabajar (o
			// se bloquee) antes del ciclo normal — si no, el wait instant-matchea
			// el estado terminal recién reportado y buclea en caliente (issues #5 y #7-F1)
			cycle("rearm");
		} else {
			// blocked: esperar un CAMBIO (working|idle|done) — el settle por defecto
			// incluye blocked y lo instant-matchea → spam con triggerTurn mientras
			// el humano decide (issue #8)
			cycle("rearmBlocked");
		}
	};

	const cycle = (phase: WaitPhase = "settle"): void => {
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
			if (status === "working" && phase !== "settle") {
				// el agente está trabajando (arranque o reanudación): entrar al ciclo de settle
				cycle();
				return;
			}
			void deliver({ kind: "gone", reason: `estado no reconocido tras wait: ${status}` });
		});
	};

	// issue #7: arm inicial en fase arm — no aceptar settle hasta ver el turno arrancar
	cycle("arm");
	return {
		stop(): void {
			stopped = true;
			killCurrent();
		},
	};
}
