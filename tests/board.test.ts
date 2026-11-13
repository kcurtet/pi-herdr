import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { applyTickStatus, composeBoard, composeLine, displayFromEvent, formatElapsed, type BoardLine } from "../src/board.ts";

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
