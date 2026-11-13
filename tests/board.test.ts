import { describe, expect, it } from "vitest";
import { applyTickStatus, displayFromEvent, formatElapsed } from "../src/board.ts";

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
