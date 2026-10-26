/**
 * Generación de nombres de agente herdr desde la task.
 *
 * Regla herdr: ^[a-z][a-z0-9_-]{0,31}$ y único entre agentes vivos.
 */
import { agentList, type RunFn } from "./herdr.ts";

const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_LEN = 32;
/** Palabras funcionales que no aportan identidad a un slug. */
const STOPWORDS = new Set(["the", "and", "for", "with", "del", "las", "los", "que", "por", "una", "con"]);

/** Slug de la task: 3 primeras palabras ≥3 chars, [a-z0-9-], máx 32, "" si nada útil. */
export function slugify(task: string): string {
	const normalized = task
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase();
	const words = normalized
		.split(/[^a-z0-9]+/)
		.filter((w) => w.length >= 3 && !STOPWORDS.has(w))
		.slice(0, 3);
	if (words.length === 0) return "";
	return words.join("-").slice(0, MAX_LEN).replace(/-+$/, "");
}

/** Candidato con sufijo respetando el límite de 32 chars. */
export function withSuffix(base: string, suffix: string): string {
	const room = MAX_LEN - suffix.length;
	return base.slice(0, room) + suffix;
}

async function liveNames(run: RunFn): Promise<Set<string>> {
	const agents = await agentList(run);
	return new Set(agents.flatMap((a) => (a.name ? [a.name] : [])));
}

/**
 * Resuelve el nombre del agente: explicit validado, o slug de la task.
 * Colisiones: sufijos -2..-9; irrelevante o todo colisionado → dispatch-<n>.
 */
export async function resolveName(run: RunFn, task: string, explicit?: string): Promise<string> {
	const taken = await liveNames(run);
	if (explicit !== undefined) {
		if (!NAME_RE.test(explicit)) {
			throw new Error(
				`pi-herdr: nombre inválido "${explicit}" (debe ser ^[a-z][a-z0-9_-]{0,31}$, máx ${MAX_LEN} chars)`,
			);
		}
		if (taken.has(explicit)) {
			const suggestion = withSuffix(explicit, "-2");
			throw new Error(`pi-herdr: ya existe un agente vivo "${explicit}". Prueba "${suggestion}"`);
		}
		return explicit;
	}
	const base = slugify(task);
	const candidates: string[] = [];
	if (base) {
		candidates.push(base);
		for (let i = 2; i <= 9; i++) candidates.push(withSuffix(base, `-${i}`));
	}
	for (const c of candidates) {
		if (!taken.has(c)) return c;
	}
	// fallback: dispatch-<n> esquivando colisiones
	for (let n = taken.size + 1; n < taken.size + 100; n++) {
		const c = `dispatch-${n}`;
		if (!taken.has(c)) return c;
	}
	throw new Error("pi-herdr: no quedó nombre disponible (inesperado)");
}
