/**
 * pi-herdr — dispatch visible en herdr como tools de pi.
 *
 * Una llamada herdr_dispatch = tab + agente + prompt + vigilancia + cierre.
 * Eventos (blocked/settled/gone) llegan como mensajes que disparan turno.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { localRun } from "./src/herdr.ts";
import {
	dispatch,
	dispatchReport,
	herdrWaitSpawn,
	listDispatches,
	promptAgent,
	readAgent,
	type DispatchDeps,
	type DispatchResult,
} from "./src/dispatch.ts";
import { makeSettleHandler, type EmitFn } from "./src/settle.ts";
import { cleanupWorktree } from "./src/worktree.ts";
import { armWatcher } from "./src/watch.ts";
import {
	Registry,
	reconcile,
	shutdownCleanup,
	stopDispatch,
	type DispatchRecord,
} from "./src/registry.ts";
import type { WatchHandle } from "./src/watch.ts";
import { defaultResourceDirs, listExtNames, listSkillNames } from "./src/resources.ts";
import { loadDefaults, saveDefaults } from "./src/config.ts";
import { makeHerdrCommand } from "./src/command.ts";
import { join } from "node:path";

const DispatchParams = Type.Object(
	{
		task: Type.String({ description: "Texto completo de la tarea para el agente, con contexto y formato de salida esperado." }),
		name: Type.Optional(Type.String({ description: "Nombre del agente herdr (^[a-z][a-z0-9_-]{0,31}$). Default: slug de la task." })),
		cwd: Type.Optional(Type.String({ description: "Directorio donde arranca el agente. Default: cwd de esta sesión." })),
		topology: Type.Optional(Type.Union([Type.Literal("tab"), Type.Literal("pane"), Type.Literal("workspace")], { description: "Default tab (misma workspace). pane = split a la derecha; workspace = nueva con label = name." })),
		kind: Type.Optional(Type.String({ description: "Kind de agente herdr (pi|claude|codex|gemini|cursor|...). Default pi." })),
		worktree: Type.Optional(Type.Boolean({ description: "Crear worktree aislado (rama hd/<name>, dir hermano .hd-worktrees/<name>) y arrancar el agente allí. Cleanup conservador al cerrar." })),
		keepOpen: Type.Optional(Type.Boolean({ description: "No auto-cerrar al settle: el pane queda para más rondas (herdr_prompt/herdr_stop). Default false." })),
		skills: Type.Optional(Type.Union([Type.Boolean(), Type.Array(Type.String())], { description: "Skills del agente despachado: false (default) = ninguna (--no-skills); true = herencia nativa completa; [lista] = solo esas (nombres o paths, resueltos antes de crear nada)." })),
		extensions: Type.Optional(Type.Union([Type.Boolean(), Type.Array(Type.String())], { description: "Extensiones del agente despachado: false (default) = ninguna (--no-extensions, salvo la integración de estado de herdr); true = herencia nativa; [lista] = solo esas (nombres instalados, paths o builtin:<name>)." })),
	},
	{ $id: "HerdrDispatchParams" },
);

const PromptParams = Type.Object(
	{
		agent: Type.String({ description: "Nombre del agente (despacho vivo de esta sesión)." }),
		text: Type.String({ description: "Prompt para la siguiente ronda." }),
	},
	{ $id: "HerdrPromptParams" },
);

const ReadParams = Type.Object(
	{
		agent: Type.String({ description: "Nombre del agente." }),
		lines: Type.Optional(Type.Number({ description: "Últimas N líneas (default 200)." })),
	},
	{ $id: "HerdrReadParams" },
);

const StopParams = Type.Object(
	{
		agent: Type.String({ description: "Nombre del despacho a abandonar." }),
	},
	{ $id: "HerdrStopParams" },
);

export default function herdrExtension(pi: ExtensionAPI) {
	const registry = new Registry(pi);
	const watchers = new Map<string, WatchHandle>();
	const configPath = join(
		process.env.PI_HOME ?? join(process.env.HOME ?? "/home/user", ".pi", "agent"),
		"extensions-config",
		"pi-herdr.json",
	);

	const emit: EmitFn = (content, details) => {
		pi.sendMessage({ customType: "herdr-dispatch-event", content, display: true, details }, { triggerTurn: true });
	};

	const armTracked: typeof armWatcher = (wd, name, onEvent) => {
		const handle = armWatcher(wd, name, onEvent);
		watchers.set(name, handle);
		return handle;
	};

	const deps: DispatchDeps = {
		run: localRun,
		registry,
		cwd: process.cwd(),
		spawnWait: herdrWaitSpawn,
		arm: armTracked,
		settleFor: (rec: DispatchRecord) =>
			makeSettleHandler({ run: localRun, registry, emit, cleanupWorktree }),
		resourceDirs: defaultResourceDirs(process.env),
		getConfig: () => loadDefaults(configPath).defaults, // recargada por dispatch (R6)
	};

	pi.registerTool({
		name: "herdr_dispatch",
		label: "Herdr Dispatch",
		description:
			"Despacha un agente VISIBLE en herdr (default: tab nueva en la workspace actual) y devuelve al instante {agent, paneId, taskId}. " +
			"El resultado llega solo: eventos blocked/settled/gone llegan como mensajes que disparan turno en idle — no hagas polling ni duermas. " +
			"Al settle el tab se auto-cierra (salvo keepOpen); blocked NUNCA cierra (decisión humana en el pane). " +
			"Requiere correr dentro de herdr (HERDR_ENV=1).",
		promptSnippet: "despachar un agente visible en herdr y ser notificado del resultado",
		promptGuidelines: [
			"Una llamada basta: task con todo el contexto; el resto tiene defaults.",
			"No vigiles con monitor ni duermas: los eventos de settle llegan solos como mensajes.",
			"Tras settle, el resultado ya viene en el evento; usa herdr_read solo si necesitas más salida.",
			"Para otra ronda con el mismo agente usa herdr_prompt (requiere keepOpen o agente aún vivo).",
		],
		parameters: DispatchParams,
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
		execute: async (_id, params) => {
			const result: DispatchResult = await dispatch(deps, params, process.env);
			return {
				content: [{ type: "text", text: dispatchReport(result) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "herdr_prompt",
		label: "Herdr Prompt",
		description: "Envía otra ronda de prompt a un agente despachado y aún vivo de esta sesión.",
		parameters: PromptParams,
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
		execute: async (_id, params) => {
			const text = await promptAgent(deps, params.agent, params.text);
			return { content: [{ type: "text", text }], details: { agent: params.agent } };
		},
	});

	pi.registerTool({
		name: "herdr_read",
		label: "Herdr Read",
		description: "Lee la salida terminal de un agente despachado (recent-unwrapped).",
		parameters: ReadParams,
		annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
		execute: async (_id, params) => {
			const text = await readAgent(deps, params.agent, params.lines);
			return { content: [{ type: "text", text }], details: { agent: params.agent } };
		},
	});

	pi.registerTool({
		name: "herdr_stop",
		label: "Herdr Stop",
		description: "Abandona un despacho ya: cierra su tab/pane/workspace y limpia su worktree (conservador).",
		parameters: StopParams,
		annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
		execute: async (_id, params) => {
			const text = await stopDispatch({ run: localRun, registry, cleanupWorktree, watchers }, params.agent);
			return { content: [{ type: "text", text }], details: { agent: params.agent } };
		},
	});

	pi.registerTool({
		name: "herdr_agents",
		label: "Herdr Agents",
		description: "Lista los despachos de esta sesión (agente, estado, topología, worktree).",
		parameters: Type.Object({}, { $id: "HerdrAgentsParams" }),
		annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
		execute: async () => {
			const text = listDispatches(deps);
			return { content: [{ type: "text", text }], details: { count: registry.list().length } };
		},
	});

	// Resume/crash: reconstruir desde la rama activa y reconciliar contra herdr
	pi.on("session_start", async (_event, ctx) => {
		try {
			const branch = ctx.sessionManager.getBranch() as unknown[];
			const restored = Registry.fromEntries(branch);
			for (const rec of restored.list()) registry.adopt(rec);
			if (restored.list().length > 0) {
				const reArmed = await reconcile({ ...deps, emit, cleanupWorktree });
				if (reArmed.length > 0) {
					emit(`pi-herdr: vigilancia re-armada tras resume para ${reArmed.join(", ")}`, {
						customType: "herdr-dispatch-event",
						reArmed,
					});
				}
			}
		} catch {
			// sesión sin herdr vivo o sin entries: nada que re-armar
		}
	});

	pi.on("session_shutdown", async () => {
		await shutdownCleanup({ run: localRun, registry, cleanupWorktree });
	});

	// /herdr — defaults configurables (spec 002 D6)
	const resourceDirs = defaultResourceDirs(process.env);
	const cmd = makeHerdrCommand({
		configPath,
		load: () => loadDefaults(configPath),
		save: (d) => saveDefaults(configPath, d),
		skillNames: () => listSkillNames(resourceDirs),
		extNames: () => listExtNames(resourceDirs),
		kinds: ["pi", "claude", "codex", "gemini", "cursor"],
	});
	pi.registerCommand("herdr", {
		description: "Defaults de herdr_dispatch: /herdr [config <key> <valor> | reset [key]]",
		handler: async (args, ctx) => cmd.handler(args, ctx as unknown as Parameters<typeof cmd.handler>[1]),
		getArgumentCompletions: (argumentPrefix: string) => cmd.completions(argumentPrefix),
	});
}
