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
import { makeSettleHandler, trackedSettle, type EmitFn } from "./src/settle.ts";
import { cleanupWorktree } from "./src/worktree.ts";
import { armWatcher } from "./src/watch.ts";
import {
	Registry,
	reconcile,
	shutdownCleanup,
	stopDispatch,
} from "./src/registry.ts";
import type { WatchHandle } from "./src/watch.ts";
import { defaultResourceDirs, listExtNames, listSkillNames } from "./src/resources.ts";
import { loadDefaults, saveDefaults } from "./src/config.ts";
import { makeHerdrCommand } from "./src/command.ts";
import { formatGlobalList, listGlobal, scopeFrom, Watches } from "./src/global.ts";
import { join } from "node:path";

const DispatchParams = Type.Object(
	{
		task: Type.String({ description: "Texto completo de la tarea para el agente, con contexto y formato de salida esperado." }),
		name: Type.Optional(Type.String({ description: "Nombre del agente herdr (^[a-z][a-z0-9_-]{0,31}$). Default: slug de la task." })),
		cwd: Type.Optional(Type.String({ description: "Directorio donde arranca el agente. Default: cwd de esta sesión." })),
		topology: Type.Optional(Type.Union([Type.Literal("tab"), Type.Literal("pane"), Type.Literal("workspace")], { description: "Default tab (misma workspace). pane = split a la derecha; workspace = nueva con label = name." })),
		kind: Type.Optional(Type.String({ description: "Kind de agente herdr (pi|claude|codex|gemini|cursor|...). Default pi." })),
		worktree: Type.Optional(Type.Boolean({ description: "Crear worktree aislado (rama hd/<name>, dir hermano .hd-worktrees/<name>) y arrancar el agente allí. Cleanup conservador al cerrar." })),
		setupCommand: Type.Optional(Type.String({ description: "Preparación del worktree (solo con worktree:true): omitido/\"auto\" = detectar por lockfile (pnpm>bun>yarn>npm); \"none\" = sin setup; literal = bash -c <cmd> en el worktree (10 min máx). Corre antes del agente; si falla, el dispatch se aborta con rollback conservador." })),
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

const WatchParams = Type.Object(
	{
		agent: Type.String({ description: "Agente a vigilar: nombre o pane_id (p.ej. w1D:p1), tal como sale en herdr_agents." }),
		keep: Type.Optional(Type.Boolean({ description: "Seguir vigilando tras el primer 'terminado' (avisar cada ronda). Default false: un aviso y fin." })),
		label: Type.Optional(Type.String({ description: "Cómo llamarlo en los avisos (p.ej. 'el agente de screeps'). Default: kind + carpeta." })),
	},
	{ $id: "HerdrWatchParams" },
);

const UnwatchParams = Type.Object(
	{ agent: Type.String({ description: "Agente vigilado (nombre o pane_id)." }) },
	{ $id: "HerdrUnwatchParams" },
);

const StopParams = Type.Object(
	{
		agent: Type.String({ description: "Nombre del despacho a abandonar." }),
	},
	{ $id: "HerdrStopParams" },
);

export default function herdrExtension(pi: ExtensionAPI, inject?: Partial<DispatchDeps>) {
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

	const resourceDirs = defaultResourceDirs(process.env);
	// spec 004 D1: scope por sesión (env), no por config compartida
	const scope = scopeFrom(process.env);

	// config ilegible/claves inválidas: aviso visible UNA vez al arrancar.
	// FUERA del cuerpo de la factory: los action methods (sendMessage) son
	// stubs que lanzan hasta bindCore() — llamarlo durante la carga tumba toda
	// la extensión si el config del usuario tiene warnings (rev issue #4, F1).
	pi.on("session_start", () => {
		const { warnings } = loadDefaults(configPath);
		if (warnings.length === 0) return;
		pi.sendMessage({
			customType: "herdr-config-warning",
			content: `pi-herdr: ⚠ config con problemas (esas claves se ignoran): ${warnings.join(" · ")}`,
			display: true,
		});
	});

	const armTracked: typeof armWatcher = (wd, name, onEvent) => {
		const handle = armWatcher(wd, name, onEvent);
		watchers.set(name, handle);
		return handle;
	};

	// seam de tests (issue #9): overrides de deps inyectables — pi llama al default
	// export con un solo arg, así que en producción todo es real. `run` inyectado
	// fluye por todo el factory (dispatch, settle, stop, shutdown) para que la
	// inyección sea coherente; `registry` inyectado fluiría también a reconcile
	// (session_start) — hoy ningún test lo inyecta (rev #9, nit).
	const run = inject?.run ?? localRun;
	const deps: DispatchDeps = {
		run,
		registry,
		cwd: process.cwd(),
		spawnWait: herdrWaitSpawn,
		arm: armTracked,
		settleFor: () => trackedSettle(makeSettleHandler({ run, registry, emit, cleanupWorktree }), watchers),
		resourceDirs,
		getConfig: () => loadDefaults(configPath).defaults, // recargada por dispatch (R6)
		...inject,
	};

	// spec 004: vigilancias de agentes ajenos (solo global). Informan, nunca cierran (D4).
	const watches = new Watches({
		run,
		spawnWait: deps.spawnWait,
		emit: (content, details) =>
			pi.sendMessage({ customType: "herdr-watch-event", content, display: true, details }, { triggerTurn: true }),
	});

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
		description:
			scope === "global"
				? "Lee la salida terminal de CUALQUIER agente de herdr (nombre o pane_id como w1D:p1), despachado o no (recent-unwrapped)."
				: "Lee la salida terminal de un agente despachado (recent-unwrapped).",
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
			const text = await stopDispatch({ run, registry, cleanupWorktree, watchers }, params.agent);
			return { content: [{ type: "text", text }], details: { agent: params.agent } };
		},
	});

	pi.registerTool({
		name: "herdr_agents",
		label: "Herdr Agents",
		description:
			scope === "global"
				? "Lista los despachos de esta sesión Y todos los agentes vivos de herdr (pi, claude…), con objetivo (nombre o pane_id), estado, cwd y título."
				: "Lista los despachos de esta sesión (agente, estado, topología, worktree).",
		parameters: Type.Object({}, { $id: "HerdrAgentsParams" }),
		annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
		execute: async () => {
			let text = listDispatches(deps);
			if (scope === "global") {
				text += `\n\nTodos los agentes de herdr:\n${formatGlobalList(await listGlobal(run))}`;
				const watched = watches.list();
				if (watched.length > 0) text += `\n\nVigilando: ${watched.join(", ")}`;
			}
			return { content: [{ type: "text", text }], details: { count: registry.list().length, scope } };
		},
	});

	if (scope === "global") {
		pi.registerTool({
			name: "herdr_watch",
			label: "Herdr Watch",
			description:
				"Vigila un agente de herdr que NO despachaste (nombre o pane_id) y avisa como mensaje cuando termine, se bloquee o desaparezca. " +
				"No lo cierra ni lo toca. Un aviso por defecto (keep:true = cada ronda).",
			promptSnippet: "vigilar un agente ajeno de herdr y ser avisado cuando termine o se bloquee",
			promptGuidelines: [
				"Úsalo cuando te pidan 'avísame cuando termine X'. No hagas polling ni duermas: el aviso llega solo.",
				"El objetivo es el nombre o el pane_id que muestra herdr_agents.",
			],
			parameters: WatchParams,
			annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
			execute: async (_id, params) => {
				const text = await watches.watch(params.agent, { keep: params.keep, label: params.label });
				return { content: [{ type: "text", text }], details: { agent: params.agent } };
			},
		});

		pi.registerTool({
			name: "herdr_unwatch",
			label: "Herdr Unwatch",
			description: "Deja de vigilar un agente (herdr_watch).",
			parameters: UnwatchParams,
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			execute: async (_id, params) => {
				const text = watches.unwatch(params.agent);
				return { content: [{ type: "text", text }], details: { agent: params.agent } };
			},
		});
	}

	// Resume/crash: reconstruir desde la rama activa y reconciliar contra herdr
	pi.on("session_start", async (_event, ctx) => {
		const liveRestored: string[] = [];
		try {
			const branch = ctx.sessionManager.getBranch() as unknown[];
			const restored = Registry.fromEntries(branch);
			for (const rec of restored.list()) {
				registry.adopt(rec);
				if (rec.status === "live") liveRestored.push(rec.agent);
			}
			if (restored.list().length > 0) {
				const reArmed = await reconcile({ ...deps, emit, cleanupWorktree });
				if (reArmed.length > 0) {
					emit(`pi-herdr: vigilancia re-armada tras resume para ${reArmed.join(", ")}`, {
						customType: "herdr-dispatch-event",
						reArmed,
					});
				}
			}
		} catch (err) {
			// Sesión sin herdr vivo (getBranch lanza) o sin entries live restaurados:
			// nada que re-armar → silencio. PERO si ya adoptamos records live, tragar
			// el fallo los dejaría vivos sin watcher NI evento, invisibles para siempre
			// (I4, issue #13): warning visible, sin triggerTurn (sendMessage es legal
			// aquí — handler de evento, no cuerpo de la factory; rev issues #7/#4).
			if (liveRestored.length > 0) {
				pi.sendMessage({
					customType: "herdr-reconcile-warning",
					content: `pi-herdr: ⚠ no se pudo re-armar la vigilancia tras resume: ${(err as Error).message}. ${liveRestored.join(", ")} queda(n) live sin watcher: están en herdr_agents — ciérralos con herdr_stop si ya no importan, o re-despacha.`,
					display: true,
				});
			}
		}
	});

	pi.on("session_shutdown", async () => {
		watches.stopAll(); // spec 004 A6
		await shutdownCleanup({ run, registry, cleanupWorktree });
	});

	// /herdr — defaults configurables (spec 002 D6)
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
