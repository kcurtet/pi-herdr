/**
 * Board persistente de subagentes (spec 007): estado display + composición
 * pura. Este módulo es consumidor PASIVO del embudo existente (dispatch →
 * registry, emit → eventos, tick → safeAgentStatus): nadie del flujo core lo
 * importa, y ningún método público puede lanzar (R14) — la clase Board y el
 * wiring llegan en la tarea 4; aquí viven las puras.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { DispatchRecord, Registry } from "./registry.ts";

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

/** Id del widget del board sobre el editor (setWidget/clear, D1). */
export const WIDGET_ID = "herdr-board";

/** Subset de tui que el board necesita (structural) — board.ts no importa la
 * API de pi: los seams llegan tipados mínimos y los tests los finge. */
export interface BoardTui {
	requestRender(): void;
}

/** Subset de theme para el paint productivo (D3): fg(token, texto) → ANSI. */
export interface BoardTheme {
	fg(color: string, text: string): string;
}

/** Subset de la UI de pi que el board consume (D7): fire-and-forget. */
export interface BoardUi {
	setWidget(id: string, content: unknown, opts?: { placement?: string }): void;
	notify(msg: string, level: "info" | "warning" | "error"): void;
}

/** Subset que dispatch.ts necesita — Board lo implementa (seam de wiring). */
export interface BoardEvents {
	onDispatched(rec: DispatchRecord): void;
	onEvent(agent: string, kind: EventKind, keepOpen?: boolean): void;
	refresh(): void;
}

export interface BoardDeps {
	registry: Registry;
	/** DERIVADO de safeAgentStatus en el wiring (index.ts): adaptador explícito
	 * — pasarla parcializada cruda rompería el reconcile en silencio. */
	status: (agent: string) => Promise<string | undefined>;
	/** default Date.now (seam de tests). */
	now?: () => number;
	/** default 30_000 (spec D4). */
	intervalMs?: number;
	/** default 5 (spec D8). */
	maxLines?: number;
}

/** Componente custom del widget (D3): render(width) compone y cachea por
 * (width, versión); invalidate() limpia el cache y las mutaciones piden
 * tui.requestRender() (coalescido por pi) para no repintar en vano. */
export class BoardComponent {
	private readonly cache = new Map<string, string[]>();
	private version = 0;

	constructor(
		private readonly lines: () => BoardLine[],
		private readonly now: () => number,
		private readonly paint?: PaintFn,
		private readonly maxLines: number = 5,
	) {}

	render(width: number): string[] {
		try {
			const key = `${this.version}:${width}`;
			const hit = this.cache.get(key);
			if (hit !== undefined) return hit;
			const out = composeBoard(this.lines(), width, this.now(), this.maxLines, this.paint);
			this.cache.set(key, out);
			return out;
		} catch {
			return []; // R14: un fallo de render jamás tumba el render loop de pi
		}
	}

	invalidate(): void {
		this.version++;
		this.cache.clear();
	}
}

interface DisplayEntry {
	display: BoardDisplay;
	since: number;
}

/**
 * Board (D1): consumidor pasivo del embudo existente. Membresía = records
 * live del registry (orden createdAt); estado display = eventos del watcher
 * (onEvent) reconciliado por el tick (applyTickStatus). TODO método público
 * envuelve su cuerpo en try/catch silencioso (R14): el board es cosmético y
 * jamás propaga a dispatch/watch/settle. Guard de modo en el call-site
 * (D7/R11): ui===undefined ⇒ desactivado — sin widget, sin timer, sin toasts.
 */
export class Board implements BoardEvents {
	private readonly nowFn: () => number;
	private readonly intervalMs: number;
	private readonly maxLines: number;
	private readonly displays = new Map<string, DisplayEntry>();
	private ui: BoardUi | undefined;
	private enabled = true;
	private timer: ReturnType<typeof setInterval> | undefined;
	private widgetActive = false;
	private component: BoardComponent | undefined;
	private requestRender: (() => void) | undefined;

	constructor(private readonly deps: BoardDeps) {
		this.nowFn = deps.now ?? Date.now;
		this.intervalMs = deps.intervalMs ?? 30_000;
		this.maxLines = deps.maxLines ?? 5;
	}

	/** Activación en session_start: ui===undefined (fuera de TUI) desactiva. */
	start(ui: BoardUi | undefined): void {
		try {
			this.ui = ui;
			if (ui === undefined) {
				this.stopTimer();
				this.clearWidget();
				return;
			}
			this.refresh();
		} catch {
			/* R14 */
		}
	}

	/** /herdr config board off|on en caliente (D6/R10): clear/stop inmediato. */
	setEnabled(on: boolean): void {
		try {
			this.enabled = on;
			if (on) {
				this.refresh();
				return;
			}
			this.stopTimer();
			this.clearWidget();
		} catch {
			/* R14 */
		}
	}

	/** Dispatch resuelto (R1): línea WORKING 0m al instante, sin esperar evento. */
	onDispatched(rec: DispatchRecord): void {
		try {
			this.displays.set(rec.agent, { display: "working", since: this.nowFn() });
			this.refresh();
		} catch {
			/* R14 */
		}
	}

	/** Evento del watcher vía emit (D2/D5): display + toast blocked + refresh. */
	onEvent(agent: string, kind: EventKind, keepOpen?: boolean): void {
		try {
			const display = displayFromEvent(kind, keepOpen);
			if (display === undefined) {
				// settled sin keepOpen / gone: el record se cierra fuera (settle/
				// stop) — la línea cae por membresía; soltar el display del map
				this.displays.delete(agent);
			} else {
				const prev = this.displays.get(agent);
				// D11: since resetea SOLO en transición real (mismo display = sigue contando)
				if (prev === undefined || prev.display !== display) {
					this.displays.set(agent, { display, since: this.nowFn() });
				}
			}
			if (kind === "blocked" && this.enabled && this.ui !== undefined) {
				this.ui.notify(`herdr: ${agent} BLOCKED — decisión pendiente en su pane`, "warning");
			}
			this.refresh();
		} catch {
			/* R14 */
		}
	}

	/** Membresía = records live; render o clear; timer on/off (D4). */
	refresh(): void {
		try {
			const now = this.nowFn();
			const live = this.liveRecords();
			// higiene: displays de agentes que ya no están live no viven para siempre
			for (const name of [...this.displays.keys()]) {
				if (!live.some((r) => r.agent === name)) this.displays.delete(name);
			}
			if (!this.enabled || this.ui === undefined || live.length === 0) {
				this.stopTimer();
				this.component?.invalidate(); // ANTES de clearWidget: este suelta la ref
				this.clearWidget();
				return;
			}
			// R13: restaurados sin entrada (resume) arrancan WORKING, since = ahora
			for (const r of live) {
				if (!this.displays.has(r.agent)) this.displays.set(r.agent, { display: "working", since: now });
			}
			this.ensureWidget();
			this.ensureTimer();
			this.component?.invalidate();
			this.requestRender?.();
		} catch {
			/* R14 */
		}
	}

	/**
	 * Tick 30s (D4): reconciler de verdad. No-op desactivado o sin ui (R11:
	 * un resume headless jamás lanza `herdr agent get`). Por cada record live,
	 * deps.status en paralelo (best-effort — fallo = mantiene el último
	 * estado); el resultado se aplica SOLO vía applyTickStatus (tabla D10) y
	 * una transición resetea since (D11). El tick NUNCA escribe en registry ni
	 * emite eventos: solo pinta. El tick inmediato de arranque lo dispara el
	 * wiring de index.ts (void board.tick() tras start) — no se duplica aquí.
	 */
	async tick(): Promise<void> {
		try {
			if (!this.enabled || this.ui === undefined) return;
			const live = this.liveRecords();
			if (live.length > 0) {
				const results = await Promise.allSettled(live.map((r) => this.deps.status(r.agent)));
				live.forEach((r, i) => {
					const res = results[i]!;
					if (res.status !== "fulfilled" || res.value === undefined) return; // fallo/unknown: mantener
					const current = this.displays.get(r.agent)?.display ?? "working";
					const next = applyTickStatus(current, res.value);
					if (next !== current) {
						this.displays.set(r.agent, { display: next, since: this.nowFn() });
					}
				});
			}
			this.refresh();
		} catch {
				/* R14 */
			}
	}

	/** session_shutdown (R12): timer off + clear widget + estado suelto. */
	dispose(): void {
		try {
			this.stopTimer();
			this.clearWidget();
			this.displays.clear();
		} catch {
			/* R14 */
		}
	}

	/** Records live ordenados por createdAt (D8): el orden lo decide el board. */
	private liveRecords(): DispatchRecord[] {
		return this.deps.registry
			.list()
			.filter((r) => r.status === "live")
			.sort((a, b) => a.createdAt - b.createdAt);
	}

	/** Líneas del render: TODO del record (D9) — display/since del map. */
	private lines(): BoardLine[] {
		const now = this.nowFn();
		return this.liveRecords().map((r) => ({
			name: r.agent,
			display: this.displays.get(r.agent)?.display ?? "working",
			since: this.displays.get(r.agent)?.since ?? now,
			kind: r.kind,
			branch: r.worktree?.branch,
			task: r.task,
		}));
	}

	/** Registro del widget UNA vez por período no-vacío (D3): tras un clear y
	 * reaparición de líneas (o re-enable) se re-registra. La factory captura
	 * tui.requestRender (seam de repintado entre renders del mismo período). */
	private ensureWidget(): void {
		if (this.widgetActive || this.ui === undefined) return;
		const board = this;
		this.ui.setWidget(WIDGET_ID, (tui: BoardTui, theme: BoardTheme) => {
			board.requestRender = () => tui.requestRender();
			const comp = new BoardComponent(() => board.lines(), board.nowFn, board.paintFor(theme), board.maxLines);
			board.component = comp;
			return comp;
		});
		this.widgetActive = true;
	}

	/** Paint productivo (D3): accent=working, warning=blocked, dim=idle,
	 * error=interrupted/stranded — re-aplicado por línea (pi resetea estilos). */
	private paintFor(theme: BoardTheme): PaintFn {
		return (status, text) =>
			theme.fg(
				status === "working" ? "accent" : status === "blocked" ? "warning" : status === "idle" ? "dim" : "error",
				text,
			);
	}

	private clearWidget(): void {
		if (!this.widgetActive) return;
		this.ui?.setWidget(WIDGET_ID, undefined);
		this.widgetActive = false;
		this.component = undefined;
		this.requestRender = undefined;
	}

	/** Timer solo con board vivo (anti-zombie): 0→≥1 live arranca, vaciar para. */
	private ensureTimer(): void {
		if (this.timer !== undefined) return;
		this.timer = setInterval(() => void this.tick(), this.intervalMs);
		this.timer.unref(); // R12: el tick jamás sujeta el proceso
	}

	private stopTimer(): void {
		if (this.timer === undefined) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}
}
