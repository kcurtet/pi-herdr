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
 * Issue #14 — verificación antes de declarar gone: un wait que sale ≠ 0 (o un
 * spawn que falla) no dice nada del AGENTE — puede ser el propio server herdr
 * (caído/reiniciándose) o un fallo transitorio. Antes de entregar gone se
 * verifica UNA vez si el agente sigue en `herdr agent list`:
 * - ausente → gone genuino (comportamiento histórico intacto).
 * - vivo o NO VERIFICABLE (agentList también falla → decisión conservadora:
 * no podemos afirmar que murió) → kind "stranded": evento visible con guía,
 * watcher detenido, record INTACTO en live (settle no toca nada) — el humano
 * decide con herdr_stop. Sin reintento del ciclo: el wait ya ha muerto dos
 * veces de formas distintas en el peor caso; re-armar en bucle contra un
 * server caído sería spam.
 *
 * Hang aceptado (trade-off): un agente cuyo turno nunca arranca (pane vivo con
 * idle persistente, p.ej. pi muerto), o que queda blocked eternamente sin
 * decisión humana, deja el watcher bloqueado en fase arm/rearm/rearmBlocked
 * y el record `live` en herdr_agents. Escape manual: herdr_stop.
 */
import { type ChildProcess } from "node:child_process";
import { agentList, agentRead, type RunFn } from "./herdr.ts";

export type WaitPhase = "settle" | "arm" | "rearm" | "rearmBlocked";

export type WatchEvent =
	| { kind: "blocked" }
	| { kind: "settled"; state: "idle" | "done"; output: string }
	| { kind: "gone"; reason: string }
	| { kind: "stranded"; reason: string };

/** Verificador real por defecto: el agente aparece en `herdr agent list`?
 * Rechaza si herdr no responde — el watcher lo trata como "no verificable". */
export async function verifyAgentAlive(run: RunFn, name: string): Promise<boolean> {
	const agents = await agentList(run);
	return agents.some((a) => a.name === name);
}

export interface WatchDeps {
	run: RunFn;
	spawnWait: (name: string, phase?: WaitPhase) => ChildProcess;
	/** Issue #14: verificación de vida antes de declarar gone (seam de tests).
	 * true = vivo → stranded; false = ausente → gone genuino; throw = no
	 * verificable → stranded conservador. Default: verifyAgentAlive vía run. */
	verifyAgent?: (name: string) => Promise<boolean>;
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
	let failedThisCycle = false;

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
		if (!again || ev.kind === "gone" || ev.kind === "stranded") {
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

	const verify = deps.verifyAgent ?? ((n: string) => verifyAgentAlive(deps.run, n));

	/** Issue #14: fallo del propio wait (spawn error / exit ≠ 0). No declara gone
	 * a ciegas: verifica UNA vez si el agente vive y clasifica. */
	const classifyWaitFailure = (failure: string): void => {
		if (stopped || failedThisCycle) return;
		failedThisCycle = true; // 'error' y 'close' pueden llegar ambos por el mismo spawn
		void (async () => {
			if (stopped) return;
			try {
				const alive = await verify(name);
				await deliver(
					alive
					? { kind: "stranded", reason: `${failure} pero el agente SIGUE vivo — no se cierra; usa herdr_stop si quieres abortarlo` }
					: { kind: "gone", reason: failure },
				);
			} catch (err) {
				// verificación imposible: no podemos afirmar que el agente murió
				await deliver({
					kind: "stranded",
					reason: `${failure} y no se pudo verificar si el agente sigue vivo (${(err as Error).message}) — no se cierra; usa herdr_stop si quieres abortarlo`,
				});
			}
		})();
	};

	const cycle = (phase: WaitPhase = "settle"): void => {
		if (stopped) return;
		failedThisCycle = false;
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
			classifyWaitFailure(`spawn error: ${err.message}`);
		});
		child.on("close", (code) => {
			current = undefined;
			if (stopped) return;
			if (code !== 0) {
				const detail = stderr.trim().slice(0, 200);
				classifyWaitFailure(`wait exited ${code}${detail ? `: ${detail}` : ""}`);
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
