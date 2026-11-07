import { describe, expect, it } from "vitest";
import { cleanAgentRead } from "../src/readclean.ts";

/** Regla full-width del ancho típico de pane. */
const RULE_WIDE = "─".repeat(142);
const RULE_WIDE_BORDERS = "─".repeat(142) + "│";

describe("cleanAgentRead", () => {
	it("texto plano sin chrome queda igual (rstrip incluido)", () => {
		const raw = "todo listo\n186 passed\nsin warnings   ";
		expect(cleanAgentRead(raw)).toBe("todo listo\n186 passed\nsin warnings");
	});

	it("recorta reglas full-width, resto envuelto y statusline (estado working)", () => {
		const raw = [
			" ### Verificaciones ejecutadas",
			"",
			" - uv run pytest -q tests → 186 passed",
			"",
			` ${RULE_WIDE}`,
			" ──",
			"",
			` ${RULE_WIDE}`,
			" ──",
			" ~/dev/nyx (main)",
			" ↑44k ↓19k R655k CH98.3% $0.318 4.8%/1.0M (auto)          (zai-coding-cn) glm-5.3 •",
			" high",
			"",
			"",
		].join("\n");
		expect(cleanAgentRead(raw)).toBe(
			" ### Verificaciones ejecutadas\n\n - uv run pytest -q tests → 186 passed",
		);
	});

	it("recorta el bloque statusline completo de un agente idle (todo chrome → vacío)", () => {
		const raw = [
			...Array.from({ length: 18 }, () => ""),
			` ${RULE_WIDE}`,
			"",
			` ${RULE_WIDE}`,
			" ~ • nyx-agent",
			" 0.0%/1.0M (auto)                    (zai-coding-cn) glm-5.3-flash • high",
		].join("\n");
		expect(cleanAgentRead(raw)).toBe("");
	});

	it("recorta reglas con borde derecho │ y líneas de solo borde/padding", () => {
		const raw = [
			" mensaje con borde" + " ".repeat(20) + "│",
			" ".repeat(21) + "│",
			` ${RULE_WIDE_BORDERS}`,
			" ──",
			` ${RULE_WIDE_BORDERS}`,
			" ~/dev/nyx (main)",
			" ↑44k ↓19k 4.8%/1.0M (auto)      (zai-coding-cn) glm-5.3 •",
			" high",
		].join("\n");
		expect(cleanAgentRead(raw)).toBe(" mensaje con borde" + " ".repeat(20) + "│");
	});

	it("conserva separadores de contenido: markdown --- y tablas de caja", () => {
		const raw = [
			"intro",
			"",
			"---",
			"",
			"| col | val |",
			"|----|-----|",
			"| a   | 1   |",
			"",
			"├──────┬─────┤",
			"│ keep │ yes │",
			"└──────┴─────┘",
		].join("\n");
		expect(cleanAgentRead(raw)).toBe(raw);
	});

	it("colapsa ráfagas de blancos de padding a un máximo de uno", () => {
		const raw = "parrafo uno\n\n\n\nparrafo dos\n\n\n   \nfinal";
		expect(cleanAgentRead(raw)).toBe("parrafo uno\n\nparrafo dos\n\nfinal");
	});

	it("no toca contenido aunque termine en línea corta si no hay statusline", () => {
		const raw = "resumen final\nhigh";
		expect(cleanAgentRead(raw)).toBe("resumen final\nhigh");
	});

	it("prosa con dinero sobrevive: una señal no es statusline (review 140b31a)", () => {
		const raw = "resumen del trabajo\ncoste total de la sesion: $12.34 sin IVA";
		expect(cleanAgentRead(raw)).toBe("resumen del trabajo\ncoste total de la sesion: $12.34 sin IVA");
	});

	it("reporte de suite con ratio (94.7%) sobrevive", () => {
		const raw = "suite verde:\n142/150 (94.7%) tests pasan hoy";
		expect(cleanAgentRead(raw)).toBe("suite verde:\n142/150 (94.7%) tests pasan hoy");
	});

	it("diffstat ↑2 ↓1 sobrevive (una señal, sin unidad k)", () => {
		const raw = "summary\nfiles ↑2 ↓1 changed\ndone";
		expect(cleanAgentRead(raw)).toBe("summary\nfiles ↑2 ↓1 changed\ndone");
	});

	it("línea débil tipo 'docs (updated)' sobrevive sin marca cercana, también al final", () => {
		const raw = "cambios:\ndocs (updated)";
		expect(cleanAgentRead(raw)).toBe("cambios:\ndocs (updated)");
	});

	it("cadena de falsos positivos no se propaga: $1.99 no arrastra líneas cortas", () => {
		const raw = "gasto $1.99\ntotal\nseguimos";
		expect(cleanAgentRead(raw)).toBe("gasto $1.99\ntotal\nseguimos");
	});

	it("statusline con coste de 3 decimales ($0.318) y fragmentos envueltos cae entero", () => {
		const raw = [
			" resultado final del trabajo",
			"",
			` ${RULE_WIDE}`,
			" ──",
			" ↑44k ↓19k R655k CH98.3% $0.318 4.8%/1.0M (auto)",
			" (zai-coding-cn) glm-5.3 •",
			" high",
		].join("\n");
		expect(cleanAgentRead(raw)).toBe(" resultado final del trabajo");
	});

	it("resto envuelto de un solo ─ también cae", () => {
		const raw = "intro\n ─\ncoda";
		expect(cleanAgentRead(raw)).toBe("intro\ncoda");
	});

	it("línea de spinner de actividad (── ⠴ Working ────) cae", () => {
		const raw = [
			"trabajando en ello, dame un momento",
			"",
			"── ⠴ Working " + "─".repeat(96),
		].join("\n");
		expect(cleanAgentRead(raw)).toBe("trabajando en ello, dame un momento");
	});

	it("braille en contenido sin run de regla sobrevive", () => {
		const raw = "⠿ DNS over HTTPS — qué es y cuándo usarlo";
		expect(cleanAgentRead(raw)).toBe("⠿ DNS over HTTPS — qué es y cuándo usarlo");
	});

	it("statusline custom con iconos, ratio (38.0%), coste y barra de progreso", () => {
		const raw = [
			"",
			"  GLM-5.3  think:high   nyx   main  380k/1.0M (38.0%)    75M  $22.37  5h ━━━───── 3",
			` ${RULE_WIDE}`,
			" >",
			` ${RULE_WIDE}`,
			" ↳ ¿Cómo forzamos un DAC?",
		].join("\n");
		expect(cleanAgentRead(raw)).toBe(" ↳ ¿Cómo forzamos un DAC?");
	});

	it("bloques de chrome apilados tras resize: el contenido entre medias sobrevive", () => {
		const raw = [
			` ${RULE_WIDE}`,
			" ~/dev/nyx (main)",
			" ↑44k ↓19k R655k CH98.3% $0.318 4.8%/1.0M (auto)   (zai-coding-cn) glm-5.3 •",
			" high",
			"",
			" strip-alias done cleanly (44f748c pushed, 186 tests).",
			" skill additions (hard rule + DAG routine) that I promised.",
			"                        ↓ Jump to latest message · Ctrl+Alt+.",
			"",
			"  GLM-5.3  think:high   main  380k/1.0M (38.0%)  $22.37",
			` ${RULE_WIDE}`,
			" >",
			` ${RULE_WIDE}`,
			" ↳ pregunta pendiente",
		].join("\n");
		expect(cleanAgentRead(raw)).toBe(
			" strip-alias done cleanly (44f748c pushed, 186 tests).\n skill additions (hard rule + DAG routine) that I promised.\n\n ↳ pregunta pendiente",
		);
	});
});
