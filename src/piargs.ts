/**
 * Builder de piArgs (spec 002 D3): flags de skills/extensiones para el
 * passthrough de `herdr agent start ... --`. Exención automática de la
 * integración de estado de herdr cuando se restringen extensiones.
 */
import { existsSync } from "node:fs";
import type { ResolvedDefaults } from "./config.ts";
import { resolveExtensions, resolveSkills, type ResourceDirs } from "./resources.ts";

export function buildPiArgs(
	resolved: Pick<ResolvedDefaults, "skills" | "extensions">,
	d: ResourceDirs,
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
	}

	return args;
}
