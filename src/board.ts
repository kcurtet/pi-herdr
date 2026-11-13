/**
 * Board persistente de subagentes (spec 007): estado display + composición
 * pura. Este módulo es consumidor PASIVO del embudo existente (dispatch →
 * registry, emit → eventos, tick → safeAgentStatus): nadie del flujo core lo
 * importa, y ningún método público puede lanzar (R14) — la clase Board y el
 * wiring llegan en la tarea 4; aquí viven las puras.
 */

/** Estado display de una línea del board (D2). */
export type BoardDisplay = "working" | "blocked" | "idle" | "interrupted" | "stranded";

/** Kinds de evento que el watcher emite vía herdr-dispatch-event (settle.ts). */
export type EventKind = "blocked" | "settled" | "interrupted" | "stranded" | "gone";

/**
 * Display que fija un evento del watcher (D2). undefined = el evento no fija
 * display: settled con auto-close y gone despueblan la línea en el close
 * inminente (membresía = records live), no pintan estado.
 */
export function displayFromEvent(kind: EventKind, keepOpen?: boolean): BoardDisplay | undefined {
	switch (kind) {
		case "blocked":
			return "blocked";
		case "settled":
			// keepOpen: el pane queda abierto a la espera de otra ronda → IDLE;
			// sin keepOpen el record se cierra y la línea desaparece sola
			return keepOpen === true ? "idle" : undefined;
		case "interrupted":
			return "interrupted";
		case "stranded":
			return "stranded";
		case "gone":
			return undefined;
	}
}

/**
 * Tabla de transiciones del tick (D10), LITERAL:
 * - stranded: intocable — su watcher está muerto y ningún evento vendrá a
 *   corregir una sobreescritura; solo herdr_stop/shutdown lo saca.
 * - interrupted: sticky — el tick solo puede levantarlo a working (la ronda
 *   encolada arrancó); jamás lo degrada a idle (perdería la señal de decisión
 *   pendiente).
 * - working/blocked/idle (watcher-alive): el tick reconcilia libre con lo que
 *   safeAgentStatus reporte (cubre prompt manual del pane y watchers muertos).
 * Los estados de herdr que no mapean a display se ignoran: el board muestra
 * el último estado conocido (no hay "unknown" que inventar, spec caso límite).
 */
export function applyTickStatus(current: BoardDisplay, agentStatus: string): BoardDisplay {
	if (current === "stranded") return "stranded";
	if (current === "interrupted") {
		return agentStatus === "working" ? "working" : "interrupted";
	}
	switch (agentStatus) {
		case "working":
			return "working";
		case "blocked":
			return "blocked";
		case "idle":
		case "done": // terminal: para display equivale a idle (línea quieta)
			return "idle";
		default:
			return current; // desconocido → mantener
	}
}

/**
 * Elapsed "tiempo en el estado actual" (D11): minutos floor; a partir de 1h
 * pasa a `HhMMm` con minutos a dos dígitos ("1h04m"). Sin ancho fijo — el
 * degradado de composeLine lo recorta si no cabe.
 */
export function formatElapsed(ms: number): string {
	const totalMin = Math.floor(Math.max(0, ms) / 60_000);
	if (totalMin < 60) return `${totalMin}m`;
	const h = Math.floor(totalMin / 60);
	const m = totalMin % 60;
	return `${h}h${String(m).padStart(2, "0")}m`;
}
