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
