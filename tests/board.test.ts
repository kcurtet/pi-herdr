import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Registry, type DispatchRecord } from "../src/registry.ts";
import {
	applyTickStatus,
	Board,
	BoardComponent,
	composeBoard,
	composeLine,
	displayFromEvent,
	formatElapsed,
	WIDGET_ID,
	type BoardDisplay,
	type BoardLine,
	type BoardUi,
	type EventKind,
} from "../src/board.ts";

describe("displayFromEvent — evento → estado display (D2)", () => {
	it("blocked → BLOCKED (decisión humana pendiente)", () => {
		expect(displayFromEvent("blocked")).toBe("blocked");
	});

	it("settled + keepOpen → IDLE (pane abierto esperando otra ronda)", () => {
		expect(displayFromEvent("settled", true)).toBe("idle");
	});

	it("settled sin keepOpen → undefined: no fija display, el close inminente despuebla", () => {
		expect(displayFromEvent("settled", false)).toBeUndefined();
		expect(displayFromEvent("settled")).toBeUndefined();
	});

	it("interrupted → INTERRUPTED (grace activo, decisión pendiente)", () => {
		expect(displayFromEvent("interrupted")).toBe("interrupted");
	});

	it("stranded → STRANDED (wait muerto, herdr_stop decide)", () => {
		expect(displayFromEvent("stranded")).toBe("stranded");
	});

	it("gone → undefined: el close inminente despuebla la línea", () => {
		expect(displayFromEvent("gone")).toBeUndefined();
	});
});

describe("applyTickStatus — tabla de transiciones del tick (D10)", () => {
	it("stranded es intocable: aunque el tick reporte working, sigue stranded (R6)", () => {
		expect(applyTickStatus("stranded", "working")).toBe("stranded");
	});

	it("interrupted sticky: solo working lo levanta (la ronda encolada arrancó)", () => {
		expect(applyTickStatus("interrupted", "working")).toBe("working");
	});

	it("interrupted JAMÁS degrada a idle (señal de decisión pendiente)", () => {
		expect(applyTickStatus("interrupted", "idle")).toBe("interrupted");
		expect(applyTickStatus("interrupted", "done")).toBe("interrupted");
		expect(applyTickStatus("interrupted", "blocked")).toBe("interrupted");
	});

	it("watcher-alive (working/blocked/idle): el tick reconcilia libre", () => {
		expect(applyTickStatus("working", "blocked")).toBe("blocked");
		expect(applyTickStatus("idle", "working")).toBe("working"); // R7: prompt manual del pane
		expect(applyTickStatus("working", "done")).toBe("idle");
		expect(applyTickStatus("blocked", "idle")).toBe("idle");
		expect(applyTickStatus("idle", "blocked")).toBe("blocked");
		expect(applyTickStatus("working", "idle")).toBe("idle");
	});

	it("estado reportado desconocido → mantiene el display actual (no hay unknown que inventar)", () => {
		expect(applyTickStatus("working", "unknown")).toBe("working");
		expect(applyTickStatus("idle", "")).toBe("idle");
	});
});

describe("composeLine — degradado por width (D3/R8)", () => {
	// truncateToWidth de pi-tui embebe resets ANSI junto al ellipsis: para
	// aserciones de CONTENIDO se compara siempre el texto sin escapes
	const ansiCodes = /\x1b\[[0-9;]*m/g;
	const NOW = 1_700_000_000_000;
	const line: BoardLine = {
		name: "impl-board",
		display: "working",
		since: NOW - 12 * 60_000,
		kind: "pi",
		branch: "hd/impl-board",
		task: "construye el board del agente",
	};
	const FULL = "impl-board · WORKING 12m · pi · hd/impl-board · construye el board del agente";
	const NO_TASK = "impl-board · WORKING 12m · pi · hd/impl-board";
	const NO_BRANCH = "impl-board · WORKING 12m · pi";
	const NO_KIND = "impl-board · WORKING 12m";
	const FLOOR = "impl-board · WORKING";

	it("width justo: línea completa name · STATUS elapsed · kind · branch · task", () => {
		expect(composeLine(line, visibleWidth(FULL), NOW)).toBe(FULL);
	});

	it("al estrechar cae task → branch → kind → elapsed → suelo name · STATUS", () => {
		// cada nivel encaja EXACTO en su width y un pixel menos cae al siguiente
		expect(composeLine(line, visibleWidth(NO_TASK), NOW)).toBe(NO_TASK);
		expect(composeLine(line, visibleWidth(NO_TASK) - 1, NOW)).toBe(NO_BRANCH);
		expect(composeLine(line, visibleWidth(NO_BRANCH), NOW)).toBe(NO_BRANCH);
		expect(composeLine(line, visibleWidth(NO_BRANCH) - 1, NOW)).toBe(NO_KIND);
		expect(composeLine(line, visibleWidth(NO_KIND), NOW)).toBe(NO_KIND);
		expect(composeLine(line, visibleWidth(FLOOR), NOW)).toBe(FLOOR);
		expect(composeLine(line, visibleWidth(NO_KIND) - 1, NOW)).toBe(FLOOR);
	});

	it("task truncada en la propia línea completa (D3): un pixel menos recorta la task, no tira el segmento", () => {
		const out = composeLine(line, visibleWidth(FULL) - 1, NOW);
		const plain = out.replace(ansiCodes, "");
		expect(plain.startsWith("impl-board · WORKING 12m · pi · hd/impl-board · construye")).toBe(true);
		expect(plain.endsWith("...")).toBe(true);
		expect(plain).not.toBe(FULL);
		expect(visibleWidth(out)).toBeLessThanOrEqual(visibleWidth(FULL) - 1);
	});

	it("recorte sin contenido sustancial (<8 chars): el segmento task cae ENTERO", () => {
		// avail = width - prefix - SEP; contenido = avail - 3 (ellipsis): 7 < 8 cae
		expect(composeLine(line, visibleWidth(NO_TASK) + 3 + 10, NOW)).toBe(NO_TASK);
		// contenido = 8: la task truncada vuelve a aparecer
		expect(visibleWidth(composeLine(line, visibleWidth(NO_TASK) + 3 + 11, NOW)))
			.toBe(visibleWidth(NO_TASK) + 3 + 11);
	});

	it("task larga en width intermedio: aparece TRUNCADA con ellipsis, sin desbordar", () => {
		const out = composeLine(
			{ ...line, task: "construye el board del agente con degradado por width y cap de líneas" },
			visibleWidth(FULL),
			NOW,
		);
		expect(visibleWidth(out)).toBeLessThanOrEqual(visibleWidth(FULL));
		expect(out).toContain("hd/impl-board");
		expect(out).not.toBe(FULL); // la task NO cabe entera
		// truncateToWidth embebe resets ANSI alrededor del ellipsis: asertar sobre texto visible
		expect(out.replace(ansiCodes, "").endsWith("...")).toBe(true);
	});

	it("width menor que el suelo: trunca el name y JAMÁS excede width", () => {
		for (const w of [1, 3, 6, 10, visibleWidth(FLOOR) - 1]) {
			const out = composeLine(line, w, NOW);
			expect(visibleWidth(out)).toBeLessThanOrEqual(w);
		}
		// con sitio para name truncado + status, el STATUS sigue visible
		const tight = composeLine(line, 18, NOW); // floor mide 19: name pierde 1
		expect(visibleWidth(tight)).toBeLessThanOrEqual(18);
		expect(tight.endsWith("WORKING")).toBe(true);
		expect(tight).toContain("...");
	});

	it("branch se muestra TAL CUAL (hd/<name> ya viene del worktree — sin doble prefijo)", () => {
		const out = composeLine(line, visibleWidth(NO_TASK), NOW);
		expect(out).toContain("hd/impl-board");
		expect(out).not.toContain("hd/hd/");
	});

	it("paint (default identidad) recibe el segmento STATUS: (display, upper)", () => {
		const seen: [string, string][] = [];
		const out = composeLine(line, visibleWidth(FULL), NOW, (status, text) => {
			seen.push([status, text]);
			return `<${text}>`; // marca para verificar que el retorno se usa
		});
		expect(seen).toEqual([["working", "WORKING"]]);
		expect(out).toContain("<WORKING>");
		// default: sin paint la línea sale limpia, sin marcas
		expect(composeLine(line, visibleWidth(FULL), NOW)).not.toContain("<");
	});
});

describe("composeBoard — cap de líneas (D8/R9)", () => {
	const NOW = 1_700_000_000_000;
	const mk = (i: number): BoardLine => ({
		name: `agente-${i}`,
		display: "working",
		since: NOW - i * 60_000,
	});

	it("7 líneas con maxLines 5 → 5 líneas + `+2 más`, orden preservado (ya viene por createdAt)", () => {
		const out = composeBoard([1, 2, 3, 4, 5, 6, 7].map(mk), 80, NOW, 5);
		expect(out).toHaveLength(6);
		expect(out.slice(0, 5)).toEqual([
			"agente-1 · WORKING 1m",
			"agente-2 · WORKING 2m",
			"agente-3 · WORKING 3m",
			"agente-4 · WORKING 4m",
			"agente-5 · WORKING 5m",
		]);
		expect(out[5]).toBe("+2 más");
	});

	it("5 o menos líneas: sin línea de desborda", () => {
		expect(composeBoard([1, 2, 3].map(mk), 80, NOW, 5)).toHaveLength(3);
		expect(composeBoard([1, 2, 3, 4, 5].map(mk), 80, NOW, 5)).toHaveLength(5);
	});

	it("cada línea respeta el width (degradado aplicado por línea)", () => {
		const out = composeBoard([1, 2].map(mk), 12, NOW, 5);
		for (const l of out) expect(visibleWidth(l)).toBeLessThanOrEqual(12);
	});
});

describe("formatElapsed — tiempo en el estado actual (D11)", () => {
	it("0 y 59_999 → 0m (floor de minutos)", () => {
		expect(formatElapsed(0)).toBe("0m");
		expect(formatElapsed(59_999)).toBe("0m");
	});

	it("12 minutos → 12m", () => {
		expect(formatElapsed(12 * 60_000)).toBe("12m");
	});

	it("cruzando 1h: 60m → 1h00m; 64m → 1h04m (minutos a dos dígitos)", () => {
		expect(formatElapsed(60 * 60_000)).toBe("1h00m");
		expect(formatElapsed(64 * 60_000)).toBe("1h04m");
		expect(formatElapsed(125 * 60_000)).toBe("2h05m");
	});
});

describe("Board — clase + componente (D1, D4, D5, D7; R1–R6, R11–R14)", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	const INTERVAL = 100;
	type WidgetFactory = (tui: { requestRender(): void }, theme: { fg(c: string, t: string): string }) => BoardComponent;
	const plainTheme = { fg: (_c: string, t: string) => t };

	function recB(over: Partial<DispatchRecord> = {}): DispatchRecord {
		return {
			agent: "impl-x",
			taskId: "hd-1",
			topology: "tab",
			targetId: "w4:t4K",
			paneId: "w4:p4M",
			cwd: "/repo",
			keepOpen: false,
			createdAt: 1_000,
			status: "live",
			task: "revisa el login del admin",
			kind: "pi",
			...over,
		};
	}

	function fakeUi() {
		const widgets: { id: string; content: unknown }[] = [];
		const notifies: { msg: string; level: string }[] = [];
		const ui: BoardUi = {
			setWidget: (id, content) => widgets.push({ id, content }),
			notify: (msg, level) => notifies.push({ msg, level }),
		};
		return { ui, widgets, notifies };
	}

	function makeBoard(o: { status?: (a: string) => Promise<string | undefined> } = {}) {
		const registry = new Registry();
		let clock = 1_000_000;
		const board = new Board({
			registry,
			status: o.status ?? (async () => undefined),
			now: () => clock,
			intervalMs: INTERVAL,
		});
		return { registry, board, advance: (ms: number) => (clock += ms) };
	}

	/** Replica el orden del wiring real (dispatch.ts): registry.add(rec) ANTES
	 * de board.onDispatched(rec) — la membresía del board sale del registry. */
	function dispatchB(registry: Registry, board: Board, over: Partial<DispatchRecord> = {}): DispatchRecord {
		const r = recB(over);
		registry.add(r);
		board.onDispatched(r);
		return r;
	}

	it("(a) onDispatched → setWidget registrado y la línea WORKING 0m aparece en render(80) (R1)", () => {
		const { registry, board } = makeBoard();
		const { ui, widgets } = fakeUi();
		board.start(ui);
		expect(widgets).toHaveLength(0); // start con 0 líneas NO registra widget vacío
		dispatchB(registry, board, { agent: "impl-x" });
		const registered = widgets.filter((w) => w.id === WIDGET_ID && typeof w.content === "function");
		expect(registered).toHaveLength(1);
		const comp = (registered[0]!.content as WidgetFactory)({ requestRender() {} }, plainTheme);
		expect(comp.render(80)[0]).toContain("impl-x · WORKING 0m");
		board.dispose();
	});

	it("(b) onEvent blocked → display BLOCKED + UN toast warning (R2, D5)", () => {
		const { registry, board } = makeBoard();
		const { ui, widgets, notifies } = fakeUi();
		board.start(ui);
		dispatchB(registry, board, { agent: "a" });
		board.onEvent("a", "blocked");
		const comp = (widgets.find((w) => w.id === WIDGET_ID && typeof w.content === "function")!.content as WidgetFactory)(
			{ requestRender() {} },
			plainTheme,
		);
		expect(comp.render(80)[0]).toContain("a · BLOCKED 0m");
		expect(notifies).toHaveLength(1);
		expect(notifies[0]!.msg).toBe("herdr: a BLOCKED — decisión pendiente en su pane");
		expect(notifies[0]!.level).toBe("warning");
		board.dispose();
	});

	it("(c) record closed + refresh → línea fuera; último live → setWidget(herdr-board, undefined) y timer parado (R3, D4)", async () => {
		const { registry, board } = makeBoard();
		const { ui, widgets } = fakeUi();
		let renderRequests = 0;
		board.start(ui);
		dispatchB(registry, board, { agent: "a" });
		const factory = widgets.find((w) => w.id === WIDGET_ID && typeof w.content === "function")!.content as WidgetFactory;
		const comp = factory({ requestRender: () => renderRequests++ }, plainTheme);
		expect(comp.render(80).join("\n")).toContain("a · WORKING");

		registry.markClosed("a");
		board.refresh();
		expect(widgets.some((w) => w.id === WIDGET_ID && w.content === undefined)).toBe(true);
		expect(comp.render(80)).toEqual([]); // la línea ya no está
		const reqs = renderRequests;
		await vi.advanceTimersByTimeAsync(INTERVAL * 5);
		expect(renderRequests).toBe(reqs); // timer parado: ningún tick más pinta
	});

	it("(d) start(undefined) → NADA: sin setWidget, sin notify, sin efecto de timer (R11, D7)", async () => {
		const statusCalls: string[] = [];
		const { registry, board } = makeBoard({ status: async (a) => (statusCalls.push(a), "working") });
		const { ui, widgets, notifies } = fakeUi();
		board.start(undefined);
		dispatchB(registry, board, { agent: "a" });
		board.onEvent("a", "blocked");
		await board.tick();
		await vi.advanceTimersByTimeAsync(INTERVAL * 3);
		expect(widgets).toHaveLength(0);
		expect(notifies).toHaveLength(0);
		expect(statusCalls).toHaveLength(0); // un resume headless jamás lanza herdr agent get
	});

	it("(e) dispose → clear del widget + timer off (R12)", async () => {
		const { registry, board } = makeBoard();
		const { ui, widgets } = fakeUi();
		let renderRequests = 0;
		board.start(ui);
		dispatchB(registry, board, { agent: "a" });
		(widgets.find((w) => w.id === WIDGET_ID && typeof w.content === "function")!.content as WidgetFactory)(
			{ requestRender: () => renderRequests++ },
			plainTheme,
		);
		board.dispose();
		expect(widgets.some((w) => w.id === WIDGET_ID && w.content === undefined)).toBe(true);
		const reqs = renderRequests;
		await vi.advanceTimersByTimeAsync(INTERVAL * 5);
		expect(renderRequests).toBe(reqs);
	});

	it("(f) ui que lanza: onEvent/onDispatched/start/tick NO propagan (R14)", async () => {
		const { registry, board } = makeBoard();
		const boom: BoardUi = {
			setWidget() {
				throw new Error("widget-boom");
			},
			notify() {
				throw new Error("notify-boom");
			},
		};
		expect(() => board.start(boom)).not.toThrow();
		expect(() => board.onDispatched(recB({ agent: "a" }))).not.toThrow();
		expect(() => board.onEvent("a", "blocked")).not.toThrow();
		await expect(board.tick()).resolves.toBeUndefined();
	});

	it("(g) tras vaciar el board y re-despachar: el widget se RE-registra y vuelve a pintar (D4 registro por período)", () => {
		const { registry, board } = makeBoard();
		const { ui, widgets } = fakeUi();
		board.start(ui);
		dispatchB(registry, board, { agent: "a", task: "tarea uno" });
		registry.markClosed("a");
		board.refresh(); // board vacío → clear
		expect(widgets.some((w) => w.id === WIDGET_ID && w.content === undefined)).toBe(true);

		board.onDispatched(((): DispatchRecord => {
			// re-despacho b: add al registry + onDispatched (orden del wiring)
			const r = recB({ agent: "b", task: "tarea dos", createdAt: 2_000 });
			registry.add(r);
			return r;
		})());
		const factories = widgets.filter((w) => w.id === WIDGET_ID && typeof w.content === "function");
		expect(factories).toHaveLength(2); // registro + re-registro
		const comp = (factories[1]!.content as WidgetFactory)({ requestRender() {} }, plainTheme);
		expect(comp.render(80)[0]).toContain("b · WORKING 0m");
		expect(comp.render(80)[0]).not.toContain("a ·");
		board.dispose();
	});
});
