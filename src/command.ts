/**
 * Comando /herdr (spec 002 D6): estado de defaults, set directo, wizard
 * interactivo y autocompletado. Patrón turnkit.
 */
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { DispatchDefaults } from "./config.ts";

export const CONFIG_KEYS = ["skills", "extensions", "topology", "kind", "keepOpen", "worktree"] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

const TOPOLOGIES = ["tab", "pane", "workspace"] as const;
const BUILTIN: Record<ConfigKey, string> = {
	skills: "false",
	extensions: "false",
	topology: "tab",
	kind: "pi",
	keepOpen: "false",
	worktree: "false",
};

export interface CommandDeps {
	configPath: string;
	load: () => { defaults: DispatchDefaults; warnings: string[] };
	save: (d: DispatchDefaults) => void;
	skillNames: () => string[];
	extNames: () => string[];
	kinds: string[];
}

export interface CommandCtxLike {
	hasUI: boolean;
	ui: {
		notify(msg: string, level: "info" | "error" | "warning"): void;
		select(title: string, items: string[]): Promise<string | undefined>;
	};
}

function fmt(v: unknown): string {
	return Array.isArray(v) ? `[${v.join(", ")}]` : String(v);
}

/** Parsea el valor textual según el key; devuelve undefined si es inválido. */
function parseValue(key: ConfigKey, raw: string, deps: CommandDeps): DispatchDefaults[ConfigKey] | undefined {
	if (key === "skills" || key === "extensions") {
		if (raw === "true" || raw === "false") return raw === "true";
		const list = raw.split(/[,\s]+/).filter(Boolean);
		return list.length > 0 ? list : undefined;
	}
	if (key === "topology") return (TOPOLOGIES as readonly string[]).includes(raw) ? (raw as DispatchDefaults["topology"]) : undefined;
	if (key === "kind") return raw.length > 0 ? raw : undefined;
	if (raw === "true" || raw === "false") return raw === "true";
	return undefined;
}

function valueOptions(key: ConfigKey, deps: CommandDeps): string[] {
	switch (key) {
		case "skills":
			return ["true", "false", ...deps.skillNames()];
		case "extensions":
			return ["true", "false", ...deps.extNames()];
		case "topology":
			return [...TOPOLOGIES];
		case "kind":
			return [...deps.kinds];
		default:
			return ["true", "false"];
	}
}

function statusText(deps: CommandDeps): string {
	const { defaults, warnings } = deps.load();
	const lines = CONFIG_KEYS.map((key) => {
		const v = defaults[key];
		const shown = v === undefined ? `${BUILTIN[key]} (builtin)` : `${fmt(v)} (config)`;
		return `  ${key.padEnd(11)} ${shown}`;
	});
	return [
		"pi-herdr defaults (param de la tool > config > builtin):",
		...lines,
		...(warnings.length > 0 ? ["", `⚠ config: ${warnings.join(" · ")}`] : []),
		"",
		"Comandos:",
		"  /herdr config                       wizard interactivo",
		"  /herdr config <key> <valor>         e.g. /herdr config skills writing-specs,triage",
		"  /herdr reset [key]                  volver a builtin",
	].join("\n");
}

async function wizard(deps: CommandDeps, ctx: CommandCtxLike): Promise<void> {
	while (true) {
		const key = await ctx.ui.select("pi-herdr — default a configurar", [...CONFIG_KEYS, "Done"]);
		if (key === undefined || key === "Done") return;
		const k = key as ConfigKey;
		const opts = valueOptions(k, deps);
		const hint = k === "skills" || k === "extensions" ? " (listas: /herdr config <key> a,b)" : "";
		const value = await ctx.ui.select(`pi-herdr — ${k}${hint}`, [...opts, "Back"]);
		if (value === undefined || value === "Back") continue;
		const parsed = parseValue(k, value, deps);
		if (parsed === undefined) {
			ctx.ui.notify(`pi-herdr: valor "${value}" no válido para ${k}`, "error");
			continue;
		}
		const current = deps.load().defaults;
		(current as Record<string, unknown>)[key] = parsed;
		deps.save(current);
		ctx.ui.notify(`pi-herdr: ${k} = ${fmt(parsed)} (config)`, "info");
	}
}

function makeHandler(deps: CommandDeps) {
	return async (args: string, ctx: CommandCtxLike): Promise<void> => {
		const parts = args.trim().split(/\s+/).filter(Boolean);
		if (parts.length === 0) {
			ctx.ui.notify(statusText(deps), "info");
			return;
		}
		if (parts[0] === "reset") {
			const current = deps.load().defaults;
			if (parts[1]) {
				if (!(CONFIG_KEYS as readonly string[]).includes(parts[1])) {
					ctx.ui.notify(`pi-herdr: key desconocida "${parts[1]}" (${CONFIG_KEYS.join(", ")})`, "error");
					return;
				}
				delete current[parts[1] as ConfigKey];
				deps.save(current);
				ctx.ui.notify(`pi-herdr: ${parts[1]} vuelto a builtin`, "info");
			} else {
				deps.save({});
				ctx.ui.notify("pi-herdr: config vaciada (todo builtin)", "info");
			}
			return;
		}
		if (parts[0] === "config") {
			if (parts.length === 1) {
				if (!ctx.hasUI) {
					ctx.ui.notify("Usage: /herdr config <key> <valor>  (wizard requiere UI interactiva)", "error");
					return;
				}
				await wizard(deps, ctx);
				return;
			}
			const key = parts[1]!;
			if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
				ctx.ui.notify(`pi-herdr: key desconocida "${key}" (${CONFIG_KEYS.join(", ")})`, "error");
				return;
			}
			const raw = parts.slice(2).join(" ");
			if (!raw) {
				ctx.ui.notify(`pi-herdr: falta el valor. Opciones: ${valueOptions(key as ConfigKey, deps).join(" | ")}`, "error");
				return;
			}
			const parsed = parseValue(key as ConfigKey, raw, deps);
			if (parsed === undefined) {
				ctx.ui.notify(`pi-herdr: valor "${raw}" no válido para ${key}`, "error");
				return;
			}
			const current = deps.load().defaults;
			(current as Record<string, unknown>)[key] = parsed;
			deps.save(current);
			ctx.ui.notify(`pi-herdr: ${key} = ${fmt(parsed)} (config)`, "info");
			return;
		}
		ctx.ui.notify(`pi-herdr: subcomando desconocido "${parts[0]}" (config | reset)`, "error");
	};
}

function makeCompletions(deps: CommandDeps) {
	return (argumentPrefix: string): AutocompleteItem[] | null => {
		const endsInSpace = /\s$/.test(argumentPrefix);
		const realTokens = argumentPrefix.trim().split(/\s+/).filter(Boolean);
		// token en edición: sin espacio final es el último real; con espacio, el siguiente
		const position = Math.max(0, endsInSpace ? realTokens.length : realTokens.length - 1);
		const partial = endsInSpace ? "" : (realTokens[realTokens.length - 1] ?? "");
		const matches = (value: string) => value.startsWith(partial);
		const build = (values: string[], trailingSpace = false): AutocompleteItem[] | null => {
			const items = values.map((v) => ({ value: trailingSpace ? `${v} ` : v, label: v }));
			const filtered = items.filter((i) => matches(i.value));
			return filtered.length > 0 ? filtered : null;
		};

		if (position === 0) {
			return build(["config", "reset"], true);
		}
		const sub = realTokens[0];
		if (position === 1 && (sub === "config" || sub === "reset")) {
			return build([...CONFIG_KEYS], true);
		}
		if (position === 2 && sub === "config") {
			const key = realTokens[1] as ConfigKey;
			if ((CONFIG_KEYS as readonly string[]).includes(key)) return build(valueOptions(key, deps));
			return null;
		}
		return null;
	};
}

export function makeHerdrCommand(deps: CommandDeps): {
	handler: (args: string, ctx: CommandCtxLike) => Promise<void>;
	completions: (argumentPrefix: string) => AutocompleteItem[] | null;
} {
	return { handler: makeHandler(deps), completions: makeCompletions(deps) };
}
