/**
 * Board persistente de subagentes (spec 007): estado display + composición
 * pura. Este módulo es consumidor PASIVO del embudo existente (dispatch →
 * registry, emit → eventos, tick → safeAgentStatus): nadie del flujo core lo
 * importa, y ningún método público puede lanzar (R14) — la clase Board y el
 * wiring llegan en la tarea 4; aquí viven las puras.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

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

/** Línea de board: TODO viene del DispatchRecord (D9) — el board no mantiene
 * datos de línea propios, mismo board antes y después de un resume. */
export interface BoardLine {
	name: string;
	display: BoardDisplay;
	/** epoch ms de la última transición (D11: elapsed = tiempo EN el estado). */
	since: number;
	/** kind del agente (D9), si el record lo trae. */
	kind?: string;
	/** worktree.branch, SOLO si hay worktree — ya viene como hd/<name>. */
	branch?: string;
	/** texto completo de la tarea; se trunca al pintar. */
	task?: string;
}

/** Pinta el segmento STATUS (D3): en producción colorea con theme.fg. */
export type PaintFn = (status: BoardDisplay, text: string) => string;

const SEP = " · ";

const defaultPaint: PaintFn = (_status, text) => text;

/** Une segmentos presentes con el separador " · ". */
function joinSegs(segs: (string | undefined)[]): string {
	return segs.filter((s): s is string => s !== undefined).join(SEP);
}

/** Mínimo de contenido visible para mostrar una task TRUNCADA: por debajo
 * el segmento cae entero — ver "c..." no informa y roba el hueco que branch o
 * kind necesitan para ser útiles. Umbral de builder: la spec deja el formato
 * exacto a criterio (D3 solo fija el orden del degradado). */
const MIN_TRUNCATED_TASK = 8;
/** Ancho visible del ellipsis por defecto de truncateToWidth ("..."). */
const ELLIPSIS_W = 3;

/**
 * Suelo `name · STATUS` con el name truncado como último recurso: si ni el
 * status cabe, se trunca la línea entera — jamás se excede width (R8).
 */
function floorLine(name: string, status: string, width: number): string {
	const f = joinSegs([name, status]);
	if (visibleWidth(f) <= width) return f;
	const nameW = width - visibleWidth(SEP) - visibleWidth(status);
	if (nameW > 0) return joinSegs([truncateToWidth(name, nameW), status]);
	return truncateToWidth(f, width);
}

/**
 * Una línea de board degradante por width (D3): completa es
 * `name · STATUS elapsed · kind · hd/<branch> · <task>`; al estrechar cae en
 * orden task → branch → kind → elapsed, con suelo `name · STATUS`. La task
 * truncada es la única que aparece RECORTADA (ellipsis) en vez de omitirse:
 * es el contenido más valioso cuando hay sitio parcial. Anchos SIEMPRE con
 * visibleWidth/truncateToWidth de pi-tui — string.length miente con ANSI/wide.
 */
export function composeLine(
	line: BoardLine,
	width: number,
	now: number,
	paint: PaintFn = defaultPaint,
): string {
	// el paint puede inyectar ANSI: medir SIEMPRE con visibleWidth, nunca .length
	const status = paint(line.display, line.display.toUpperCase());
	const statusWithElapsed = `${status} ${formatElapsed(now - line.since)}`;

	// prefijo común del degradado (todo menos la task) en su variante completa
	const prefix = joinSegs([line.name, statusWithElapsed, line.kind, line.branch]);

	// candidato con task: entera si cabe; truncada si queda sitio para contenido
	// sustancial (D3: la línea completa lleva "<task truncada>"); si el recorte
	// dejaría menos que el mínimo, el segmento cae entero al siguiente nivel
	if (line.task !== undefined) {
		const avail = width - visibleWidth(prefix) - visibleWidth(SEP);
		const taskW = visibleWidth(line.task);
		if (taskW <= avail || avail - ELLIPSIS_W >= MIN_TRUNCATED_TASK) {
			const taskSeg = taskW <= avail ? line.task : truncateToWidth(line.task, avail);
			const withTask = `${prefix}${SEP}${taskSeg}`;
			if (visibleWidth(withTask) <= width) return withTask;
		}
	}

	// degradado sin task: branch → kind → elapsed, el primero que quepa
	const candidates = [
		prefix, // name · STATUS elapsed · kind · branch
		joinSegs([line.name, statusWithElapsed, line.kind]), // sin branch
		joinSegs([line.name, statusWithElapsed]), // sin kind
	];
	for (const cand of candidates) {
		if (visibleWidth(cand) <= width) return cand;
	}

	// suelo: name · STATUS (name truncado si no cabe — jamás excede)
	return floorLine(line.name, status, width);
}

/**
 * Board completo (D8): cap de maxLines líneas + `+k más` de desborda. Espera
 * lines YA ordenadas por createdAt (membresía/orden los decide el caller).
 */
export function composeBoard(
	lines: BoardLine[],
	width: number,
	now: number,
	maxLines: number,
	paint: PaintFn = defaultPaint,
): string[] {
	const shown = lines.slice(0, maxLines).map((l) => composeLine(l, width, now, paint));
	const rest = lines.length - shown.length;
	return rest > 0 ? [...shown, `+${rest} más`] : shown;
}
