/**
 * Config persistida de pi-herdr (spec 002 D7/D8): defaults de dispatch en
 * $PI_HOME/extensions-config/pi-herdr.json, jerarquía param > config > builtin.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface DispatchDefaults {
	skills?: boolean | string[];
	extensions?: boolean | string[];
	topology?: "tab" | "pane" | "workspace";
	kind?: string;
	keepOpen?: boolean;
	worktree?: boolean;
}

/** Resultado del merge: TODOS los keys resueltos (builtin incluido). */
export interface ResolvedDefaults {
	skills: boolean | string[];
	extensions: boolean | string[];
	topology: "tab" | "pane" | "workspace";
	kind: string;
	keepOpen: boolean;
	worktree: boolean;
}

export const BUILTIN: ResolvedDefaults = {
	skills: false,
	extensions: false,
	topology: "tab",
	kind: "pi",
	keepOpen: false,
	worktree: false,
};

export const TOPOLOGIES = ["tab", "pane", "workspace"] as const;

function validSkillValue(v: unknown): boolean {
	return v === true || v === false || (Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0));
}

function validate(raw: unknown): { defaults: DispatchDefaults; warnings: string[] } {
	const warnings: string[] = [];
	const out: DispatchDefaults = {};
	if (!raw || typeof raw !== "object") return { defaults: out, warnings };
	const d = raw as Record<string, unknown>;
	for (const key of ["skills", "extensions"] as const) {
		const v = d[key];
		if (v === undefined) continue;
		if (validSkillValue(v)) out[key] = v as boolean | string[];
		else warnings.push(`skills/extensions: valor no válido (${JSON.stringify(v)}) — se ignora`);
	}
	if (typeof d.topology === "string" && (TOPOLOGIES as readonly string[]).includes(d.topology)) {
		out.topology = d.topology as "tab" | "pane" | "workspace";
	} else if (d.topology !== undefined) warnings.push(`topology: "${String(d.topology)}" no válido (${TOPOLOGIES.join("|")}) — se ignora`);
	if (typeof d.kind === "string" && d.kind.length > 0) out.kind = d.kind;
	else if (d.kind !== undefined) warnings.push(`kind: valor no válido — se ignora`);
	for (const key of ["keepOpen", "worktree"] as const) {
		const v = d[key];
		if (v === undefined) continue;
		if (typeof v === "boolean") out[key] = v;
		else warnings.push(`${key}: valor no válido (${JSON.stringify(v)}) — se ignora`);
	}
	return { defaults: out, warnings };
}

export function loadDefaults(path: string): { defaults: DispatchDefaults; warnings: string[] } {
	if (!existsSync(path)) return { defaults: {}, warnings: [] };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { defaults?: unknown };
		return validate(parsed?.defaults ?? {});
	} catch {
		return { defaults: {}, warnings: [`config ilegible (${path}) — se ignora`] };
	}
}

/**
 * Defaults CRUDOS del fichero, sin filtrar (M2): lo que hay en disco, incluidas
 * claves inválidas o desconocidas que loadDefaults descarta al cargar. Base
 * para reescribir el fichero sin mutar claves ajenas al cambio pedido.
 * Fichero inexistente, ilegible o sin objeto `defaults` → {}.
 */
export function loadRawDefaults(path: string): DispatchDefaults {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { defaults?: unknown };
		const d = parsed?.defaults;
		return d && typeof d === "object" && !Array.isArray(d) ? (d as DispatchDefaults) : {};
	} catch {
		return {};
	}
}

export function saveDefaults(path: string, d: DispatchDefaults): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify({ defaults: d }, null, "\t") + "\n");
}

/** param explícito (por key) > config > builtin. `[]` cuenta como explícito. */
export function mergeInput(
	param: Partial<Record<keyof ResolvedDefaults, unknown>>,
	config: DispatchDefaults,
): ResolvedDefaults {
	const merged: ResolvedDefaults = { ...BUILTIN };
	for (const key of Object.keys(BUILTIN) as (keyof ResolvedDefaults)[]) {
		const p = param[key];
		const target = merged as unknown as Record<string, unknown>;
		if (p !== undefined) {
			// el param ya viene validado por el schema de la tool; cast controlado
			target[key] = p;
		} else if (config[key] !== undefined) {
			target[key] = config[key];
		}
	}
	return merged;
}
