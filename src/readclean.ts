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
 * Para quien consume la lectura (orquestador, eventos settle, tools) esto es
 * ruido; aquí se recorta antes de devolver la salida.
 *
 * Deliberadamente NO se toca el borde derecho `│` de las líneas de contenido
 * ni las tablas de caja (`├──┤`): distinguir borde de tabla real es frágil.
 */

/** Línea-regla: ≥2 separadores de caja repetidos, con borde derecho opcional. */
const RULE = /^(?:[─━═]{2,})\s*│?$/;

/** Marcas fuertes del statusline de pi: uso de contexto, contadores ↑↓,
 * ratio ctx (38.0%) o coste $ — cubre el statusline por defecto y los custom. */
const STATUS_MARK =
	/[\d.]+%\s*\/\s*[\d.]+[KMG]?\s*\(auto\)|↑\S+\s+↓\S+|[\d.]+[kKM]?\/[\d.]+[KM]?\s*\(\d+(?:\.\d+)?%\)|\$\d+\.\d\d\b/;

/** Líneas débiles que solo cuentan como chrome junto a una regla/marca:
 * prompt de input, cwd (branch), hint de mensajes nuevos. */
const STATUS_SIDE = [
	/^~\s*•\s*\S+/,
	/^~?\S*\s+\([^\s()]+\)\s*$/,
	/^↓\s*Jump to latest message/,
];

/** Radio (líneas) en el que buscar regla o marca fuerte que avale el chrome. */
const CHROME_RADIUS = 3;
/** Tamaño del borde inferior de captura donde el chrome no necesita testigo. */
const TAIL_EDGE = 4;

/** Palabra única corta: resto envuelto del statusline (p.ej. `high`). */
const STATUS_WRAPPED = /^\S{1,8}$/;

function isBlankLine(line: string): boolean {
	const t = line.trim();
	// líneas de solo padding dentro del box de pi: espacios + borde derecho
	return t === "" || t === "│";
}

function isRule(line: string): boolean {
	return RULE.test(line.trim());
}

function isStatusMark(line: string): boolean {
	return STATUS_MARK.test(line);
}

function isStatusSide(line: string): boolean {
	return STATUS_SIDE.some((p) => p.test(line.trim()));
}

/** ¿Hay una regla o marca fuerte cerca (excluida la propia línea)? También
 * vale estar en el borde inferior: el statusline vive al final del snapshot. */
function chromeWitness(lines: string[], i: number): boolean {
	if (i >= lines.length - TAIL_EDGE) return true;
	for (let j = Math.max(0, i - CHROME_RADIUS); j <= Math.min(lines.length - 1, i + CHROME_RADIUS); j++) {
		if (j !== i && (isRule(lines[j]) || isStatusMark(lines[j]))) return true;
	}
	return false;
}

/** Snapshot limpio: sin reglas, sin statusline (con testigo local), sin
 * prompts de input, blancos colapsados a un máximo de uno. */
export function cleanAgentRead(raw: string): string {
	const lines = raw.replace(/\r\n/g, "\n").split("\n");
	const kept: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (isRule(line)) continue;
		if (isBlankLine(line)) {
			if (kept.length === 0 || isBlankLine(kept[kept.length - 1])) continue;
			kept.push("");
			continue;
		}
		const looksChrome = isStatusMark(line) || isStatusSide(line) || line.trim() === ">";
		if (looksChrome && chromeWitness(lines, i)) continue;
		// resto envuelto del statusline: palabra corta justo debajo de una marca
		const wrappedTail = STATUS_WRAPPED.test(line.trim()) && (isStatusMark(lines[i - 1] ?? "") || isStatusMark(lines[i - 2] ?? ""));
		if (wrappedTail) continue;
		kept.push(line.replace(/[ \t]+$/, ""));
	}
	while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
	return kept.join("\n");
}
