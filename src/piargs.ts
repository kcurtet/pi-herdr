/**
 * Builder de piArgs (spec 002 D3): flags de skills/extensiones para el
 * passthrough de `herdr agent start ... --`. Exención automática de la
 * integración de estado de herdr cuando se restringen extensiones.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedDefaults } from "./config.ts";
import { packageEntry, resolveExtensions, resolveSkills, type ResourceDirs } from "./resources.ts";

/** La resolución por nombre puede dar un DIRECTORIO (p.ej. extensions/pi-herdr):
 * -e espera un fichero → package.json pi.extensions[0] o index.ts. */
function entryFile(p: string): string | undefined {
	if (!existsSync(p)) return undefined;
	try {
		if (!statSync(p).isDirectory()) return p;
	} catch {
		return p;
	}
	try {
		return packageEntry(p);
	} catch {
		const idx = join(p, "index.ts");
		return existsSync(idx) ? idx : undefined;
	}
}

/** Exenciones automáticas extra (spec 005 D2b: pi-herdr en hijos). */
export interface PiArgsOpts {
	exemptExtensions?: string[];
}

export function buildPiArgs(
	resolved: Pick<ResolvedDefaults, "skills" | "extensions">,
	d: ResourceDirs,
	opts: PiArgsOpts = {},
): string[] {
	const args: string[] = [];

	if (resolved.skills === true) {
		// herencia completa: cero flags
	} else if (resolved.skills === false) {
		args.push("--no-skills");
	} else {
		args.push("--no-skills");
		for (const p of resolveSkills(resolved.skills, d)) args.push("--skill", p);
	}

	if (resolved.extensions === true) {
		// herencia completa
	} else {
		args.push("--no-extensions");
		if (resolved.extensions !== false) {
			for (const p of resolveExtensions(resolved.extensions, d)) {
				if (p === d.stateExt) continue; // el usuario ya lo pidió: no duplicar
				args.push("-e", p);
			}
		}
		// exención interna: estados exactos para el watcher (spec D3), sin duplicar
		if (existsSync(d.stateExt) && !args.includes(d.stateExt)) args.push("-e", d.stateExt);
		// exención de pi-herdr para hijos con grafo (spec 005 D2b): irresoluble → silencio
		for (const name of opts.exemptExtensions ?? []) {
			try {
				for (const resolved of resolveExtensions([name], d)) {
					const p = entryFile(resolved);
					if (p && !args.includes(p)) args.push("-e", p);
				}
			} catch {
				// no instalado de forma conocida: sin exención
			}
		}
	}

	return args;
}
