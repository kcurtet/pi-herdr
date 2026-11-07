/**
 * Limpieza del chrome del TUI de pi en lecturas de pane (`herdr agent read`).
 *
 * `recent-unwrapped` devuelve el snapshot crudo del terminal: reglas full-width
 * que al envolverse dejan restos (`──`), bloques statusline (cwd `(branch)`,
 * stats `↑↓`, `N%/ctx (auto)`, ratio `(38.0%)`, coste, modelo) y ráfagas de
 * blancos de padding. Tras un resize pueden quedar varios bloques apilados en
 * el scrollback con contenido real entre medias, así que el filtrado es por
 * línea con contexto local — no "recortar de la marca al final".
 *
 * Anti falsos positivos (review 140b31a): una línea de statusline real siempre
 * acumula varias señales (↑↓ + %/ctx + $ + modo), mientras que la prosa que
 * parece statusline (`142/150 (94.7%)`, `$12.34 sin IVA`, `↑2 ↓1`) solo tiene
 * una. Por eso una MARCA exige ≥2 señales en la misma línea, y las líneas
 * débiles solo cuentan como chrome con una marca (no una regla: las reglas
 * pueden ser contenido) a ≤3 líneas. Sin testigos incondicionales por posición:
 * el mensaje final del agente vive justo al final del snapshot.
 *
 * Deliberadamente NO se toca el borde derecho `│` de las líneas de contenido
 * ni las tablas de caja (`├──┤`): distinguir borde de tabla real es frágil.
 * Tampoco se preservan blancos múltiples dentro de bloques de código citado
 * ni los hard breaks de markdown (dos espacios finales): en un snapshot de
 * terminal ese whitespace es padding en el 99% de los casos.
 */

/** Línea-regla: separadores de caja repetidos, con borde derecho opcional. */
const RULE = /^(?:[─━═]+)\s*│?$/;

/** Señales del statusline de pi; una línea es MARCA con ≥2 en la misma línea. */
const SIGNALS: RegExp[] = [
	/\d+(?:\.\d+)?%\s*\/\s*[\d.]+[KM]?\s*\(auto\)/, // 4.8%/1.0M (auto)
	/[\d.]+[kKM]?\s*\/\s*[\d.]+[KM]?\s*\(\d+(?:\.\d+)?%\)/, // 380k/1.0M (38.0%)
	/↑\d+[kKM]\s+↓\d+[kKM]/, // ↑44k ↓19k (con unidad; un diffstat ↑2 ↓1 no llega a 2 señales)
	/\$\d+(?:\.\d+)?\b/, // $0.318 / $22.37
	/━{2,}─{2,}/, // barra de progreso ━━━─────
	/[•·]\s*(?:high|medium|low|auto|thinking)\b/, // glm-5.3 • high
];

/** Radio (líneas) en el que buscar una marca que avale el chrome. */
const CHROME_RADIUS = 3;

/** Spinner de actividad de pi: carácter braille de spinner + run de regla. */
const SPINNER = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;

function isSpinner(line: string): boolean {
	return SPINNER.test(line) && /[─━═]{4,}/.test(line);
}

function isBlankLine(line: string): boolean {
	const t = line.trim();
	// líneas de solo padding dentro del box de pi: espacios + borde derecho
	return t === "" || t === "│";
}

function isRule(line: string): boolean {
	return RULE.test(line.trim());
}

/** Línea de statusline: ≥2 señales acumuladas (ver cabecera). */
function isStatusMark(line: string): boolean {
	return SIGNALS.filter((p) => p.test(line)).length >= 2;
}

/** Líneas débiles: solo cuentan como chrome junto a una marca cercana.
 * Prompt de input, cwd (branch), hint de mensajes nuevos y fragmentos
 * envueltos del propio statusline (provider/modelo sin señales completas). */
function isStatusSide(line: string): boolean {
	const t = line.trim();
	return (
		/^~\s*•\s*\S+/.test(t) ||
		/^~?\S*\s+\([^\s()]+\)\s*$/.test(t) ||
		/^↓\s*Jump to latest message/.test(t) ||
		/^\([a-z0-9][a-z0-9.-]*\)\s*\S+/.test(t) ||
		/[•·]$/.test(t)
	);
}

/** ¿Hay una marca (no regla) a ≤CHROME_RADIUS líneas, excluida la propia? */
function markNearby(lines: string[], i: number): boolean {
	for (let j = Math.max(0, i - CHROME_RADIUS); j <= Math.min(lines.length - 1, i + CHROME_RADIUS); j++) {
		if (j !== i && isStatusMark(lines[j])) return true;
	}
	return false;
}

/** Snapshot limpio: sin reglas, sin statusline (marca ≥2 señales o línea débil
 * con marca cerca), sin prompts de input, blancos colapsados a un máximo de
 * uno. */
export function cleanAgentRead(raw: string): string {
	const lines = raw.replace(/\r\n/g, "\n").split("\n");
	const kept: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (isRule(line) || isSpinner(line)) continue;
		if (isBlankLine(line)) {
			if (kept.length === 0 || isBlankLine(kept[kept.length - 1])) continue;
			kept.push("");
			continue;
		}
		if (isStatusMark(line)) continue;
		if (isStatusSide(line) && markNearby(lines, i)) continue;
		if (line.trim() === ">" && markNearby(lines, i)) continue;
		// resto envuelto del statusline: palabra corta justo debajo de una marca
		if (/^\S{1,8}$/.test(line.trim()) && [i - 1, i - 2, i - 3].some((j) => isStatusMark(lines[j] ?? ""))) {
			continue;
		}
		kept.push(line.replace(/[ \t]+$/, ""));
	}
	while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
	return kept.join("\n");
}
