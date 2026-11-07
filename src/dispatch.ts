/**
 * Orquestación del dispatch: task → tab → agente → prompt → watcher.
 * Toda ejecución herdr pasa por la RunFn inyectada.
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
	agentPrompt,
	agentRead,
	agentStart,
	assertHerdrEnv,
	closeTarget,
	paneSplitRight,
	tabCreate,
	workspaceCreate,
	type RunFn,
} from "./herdr.ts";
import { liveNames, resolveName, withSuffix } from "./slug.ts";
import { firstLine } from "./dagrdoc.ts";
import { armWatcher, type WaitPhase } from "./watch.ts";
import { Registry, type DispatchRecord } from "./registry.ts";
import { createWorktree, resolveRepoRoot, rollbackNote, type WorktreeRef } from "./worktree.ts";
import { detectSetupCommand, LOCKFILE_COMMANDS, parseSetupMode, runSetup } from "./setup.ts";
import { type ResourceDirs } from "./resources.ts";
import { buildPiArgs } from "./piargs.ts";
import { mergeInput, type DispatchDefaults } from "./config.ts";
import type { DagrHook } from "./dagr.ts";
import type { SettleHandler } from "./settle.ts";

// re-export por compatibilidad: consumers (y tests) históricamente importan
// el type desde dispatch; la definición canónica vive en settle.ts
export type { SettleHandler };

export interface DispatchInput {
	task: string;
	name?: string;
	cwd?: string;
	topology?: "tab" | "pane" | "workspace";
	kind?: string;
	worktree?: boolean;
	setupCommand?: string;
	keepOpen?: boolean;
	skills?: boolean | string[];
	extensions?: boolean | string[];
}

export interface DispatchResult {
	agent: string;
	paneId: string;
	taskId: string;
	worktreePath?: string;
	/** Nota breve del setup corrido en el worktree (spec 003 D5). */
	setupNote?: string;
	/** El prompt inicial fue rechazado con agent_blocked (espera aprobación). */
	initialBlocked?: boolean;
}

export interface DispatchDeps {
	run: RunFn;
	registry: Registry;
	/** cwd por defecto cuando el input no lo trae (cwd de la sesión pi). */
	cwd: string;
	/** Spawn de `herdr agent wait` (seam de tests). */
	spawnWait: (name: string, phase?: WaitPhase) => ChildProcess;
	arm: typeof armWatcher;
	/** Handler de settle para el despacho (T5 inyecta el real). */
	settleFor: () => SettleHandler;
	/** Dirs de resolución de skills/extensiones (spec 002). */
	resourceDirs: ResourceDirs;
	/** Defaults persistidos, RECARGADOS en cada dispatch (spec 002 D7/R6). */
	getConfig: () => DispatchDefaults;
	/** Grabado del grafo dagr (spec 005); ausente = dagr off, tools idénticas. */
	dagr?: DagrHook;
}

/** Evita pisar records del registry Y agentes vivos de herdr: sufijos -2..-99, error si agota. */
function avoidRegistry(name: string, registry: Registry, live: Set<string>): string {
	const taken = (n: string): boolean => registry.get(n) !== undefined || live.has(n);
	if (!taken(name)) return name;
	for (let i = 2; i <= 99; i++) {
		const cand = withSuffix(name, `-${i}`);
		if (!taken(cand)) return cand;
	}
	throw new Error(`pi-herdr: sin nombre libre para "${name}" tras 98 colisiones — usa name explicito`);
}

/**
 * Args de `herdr agent wait` por fase (issue #7). Level-triggered: matchea al
 * instante si el estado actual ya está en el until-set.
 * - arm: working|blocked|done — confirmar arranque del turno; done/blocked
 *   cubren al agente ultra-rápido o bloqueado antes del armado.
 * - rearm: working|blocked — JAMÁS done/idle: instant-matchearía el estado
 *   recién reportado y floodearía eventos (finding 1, revisión #7).
 * - settle: sin --until (herdr matchea idle|done|blocked por defecto).
 */
export function waitArgs(name: string, phase: WaitPhase): string[] {
	if (phase === "arm") {
		return ["agent", "wait", name, "--until", "working", "--until", "blocked", "--until", "done"];
	}
	if (phase === "rearm") {
		return ["agent", "wait", name, "--until", "working", "--until", "blocked"];
	}
	if (phase === "rearmBlocked") {
		return ["agent", "wait", name, "--until", "working", "--until", "idle", "--until", "done"];
	}
	return ["agent", "wait", name];
}

/** spawnWait real: herdr agent wait <name> [args de fase], sin timeout (lo mata el watcher). */
export function herdrWaitSpawn(name: string, phase: WaitPhase = "settle"): ChildProcess {
	return spawn("herdr", waitArgs(name, phase), { stdio: ["ignore", "pipe", "pipe"] });
}

/** herdr_prompt: segunda ronda sobre un agente vivo de esta sesión. */
export async function promptAgent(deps: DispatchDeps, name: string, text: string): Promise<string> {
	const rec = deps.registry.get(name);
	if (!rec) {
		throw new Error(`pi-herdr: despacho "${name}" no encontrado en esta sesión. Usa herdr_agents para listar los vivos.`);
	}
	if (rec.status === "closed") {
		throw new Error(`pi-herdr: "${name}" ya está cerrado. Lanza un herdr_dispatch nuevo para otra tarea.`);
	}
	const r = await agentPrompt(deps.run, { name, text });
	if (r === "blocked") {
		deps.dagr?.blocked(name);
		return `El agente ${name} está bloqueado esperando aprobación o input: decide en su pane (visible en herdr) y vuelve a promptear después.`;
	}
	deps.dagr?.prompt(name, text);
	return `Prompt enviado a ${name}. El watcher activo notificará el próximo settle; no re-armes nada.`;
}

/** herdr_read: salida del agente (recent-unwrapped). */
export async function readAgent(deps: DispatchDeps, name: string, lines?: number): Promise<string> {
	return agentRead(deps.run, { name, lines });
}

/** Content de herdr_dispatch: estado del despacho al instante (issue #2: blocked visible). */
export function dispatchReport(r: DispatchResult): string {
	const base = `Despachado ${r.agent} en ${r.paneId} (task ${r.taskId}${r.worktreePath ? `, worktree ${r.worktreePath}` : ""}).`;
	const setup = r.setupNote ? ` ${r.setupNote}.` : "";
	if (r.initialBlocked) {
		return `${base}${setup} ATENCIÓN: el prompt inicial fue rechazado con agent_blocked — el agente espera aprobación o input en su pane; decídelo ahí o con herdr_prompt.`;
	}
	return `${base}${setup} Recibirás el resultado como evento; sigue con tu trabajo.`;
}

/** herdr_agents: despachos de la sesión, línea por agente. */
export function listDispatches(deps: DispatchDeps): string {
	const recs = deps.registry.list();
	if (recs.length === 0) return "Sin despachos en esta sesión.";
	return recs
		.map((r) => {
			const parts = [r.agent, r.status, r.topology, `pane ${r.paneId}`, `task ${r.taskId}`];
			if (r.worktree) parts.push(`worktree ${r.worktree.branch} (${r.worktree.dir})`);
			if (r.setupCommand) parts.push(`setup ${r.setupCommand}`);
			if (r.keepOpen) parts.push("keepOpen");
			if (r.piArgs && r.piArgs.length > 0) parts.push(`pi: ${r.piArgs.join(" ")}`);
			return parts.join(" · ");
		})
		.join("\n");
}

export async function dispatch(
	deps: DispatchDeps,
	input: DispatchInput,
	env: Record<string, string | undefined>,
): Promise<DispatchResult> {
	const task = input.task.trim();
	if (!task) throw new Error("pi-herdr: `task` es obligatoria (texto completo de la tarea)");
	assertHerdrEnv(env);

	// spec 002: param > config > builtin, gate kind!=pi, piArgs tempranos (D4/D7)
	const config = deps.getConfig();
	const effective = mergeInput(input, config);
	const resourcesSpecified =
		input.skills !== undefined || input.extensions !== undefined ||
		config.skills !== undefined || config.extensions !== undefined;
	if (effective.kind !== "pi" && resourcesSpecified) {
		throw new Error(
			`pi-herdr: skills/extensions solo aplican a kind "pi" (pedido: "${effective.kind}"). Quita esos params o usa kind pi.`,
		);
	}
	// los flags son de la CLI de pi: jamás fluyen a otros kinds (D4).
	// spec 005 D2b: con dagr activo, los hijos heredan pi-herdr auto-exento.
	const piArgs =
		effective.kind === "pi"
			? buildPiArgs(effective, deps.resourceDirs, deps.dagr?.childrenExempt ? { exemptExtensions: ["pi-herdr"] } : {})
			: [];

	const cwd = input.cwd ?? deps.cwd;
	let name = await resolveName(deps.run, task, input.name);
	name = avoidRegistry(name, deps.registry, await liveNames(deps.run));
	const topology = effective.topology;

	// spec 005 D3: reserva del task id ANTES de crear topología — el env de linaje
	// (DAGR_RUN/DAGR_TASK) va en el create; born llega tras registry.add.
	const dagrRes = deps.dagr?.reserve(name);
	try {
		return await dispatchArmed(deps, { ...input, task }, effective, piArgs, env, name, topology, cwd, dagrRes?.env);
	} catch (err) {
		// R-E: reserva sin tarea (dispatch fallido) — no contamina el grafo
		deps.dagr?.release(name);
		throw err;
	}
}

/** Fase post-reserva: todo fallo aquí libera la reserva vía el catch de dispatch(). */
async function dispatchArmed(
	deps: DispatchDeps,
	input: DispatchInput,
	effective: ReturnType<typeof mergeInput>,
	piArgs: string[],
	env: Record<string, string | undefined>,
	name: string,
	topology: "tab" | "pane" | "workspace",
	cwd: string,
	dagrEnv?: Record<string, string>,
): Promise<DispatchResult> {
	const task = input.task;

	// spec 003: modo de setup validado y detectado ANTES de crear nada (D1/D2:
	// error temprano, CERO side effects). Detección sobre la RAÍZ del repo — el
	// cwd puede ser un subdirectorio (monorepos) y el agente acaba en la raíz
	// del worktree.
	const setupMode = parseSetupMode(input.setupCommand, effective.worktree === true);
	let setupCommand: string | undefined;
	if (setupMode.kind === "auto") {
		const repoRoot = await resolveRepoRoot(deps.run, cwd);
		setupCommand = detectSetupCommand(repoRoot);
		if (setupCommand === undefined) {
			throw new Error(
				`pi-herdr: sin lockfile conocido en ${repoRoot} (buscados: ${LOCKFILE_COMMANDS.map((c) => c.file).join(", ")}) — pasa setupCommand: "none" si no quieres setup, o el comando explícito`,
			);
		}
	} else if (setupMode.kind === "literal") {
		setupCommand = setupMode.command;
	}

	// worktree ANTES de crear topología (spec D7: error temprano, cero side effects)
	// issue #12: se resuelve por jerarquía param > config > builtin (effective),
	// igual que el resto de keys — no por el input crudo
	let worktree: WorktreeRef | undefined;
	if (effective.worktree === true) {
		worktree = await createWorktree(deps.run, { repo: cwd, name });
	}
	const agentCwd = worktree?.dir ?? cwd;

	// spec 003 D3: setup oculto en el worktree ANTES de crear topología; el
	// fallo (abort + rollback) se cablea en la tarea 5
	let setupNote: string | undefined;
	if (worktree !== undefined && setupCommand !== undefined) {
		try {
			const { elapsedMs } = await runSetup(deps.run, { command: setupCommand, cwd: worktree.dir });
			setupNote = `setup OK (${setupCommand}, ${Math.round(elapsedMs / 1000)}s)`;
		} catch (err) {
			// spec 003 D4: aún no hay topología ni agente — solo rollback del
			// worktree, conservador (rollbackNote: wording compartido con agentStart)
			const note = await rollbackNote(deps.run, worktree);
			throw new Error(`${(err as Error).message}${note}`);
		}
	}

	// topología → paneId (dónde vive el agente) + targetId (qué se cierra).
	// issue #11: tab/pane anclan al workspace/pane de ESTA sesión (env de herdr),
	// no al que el usuario tenga enfocado; env ausente → comportamiento histórico.
	let paneId: string;
	let targetId: string;
	if (topology === "pane") {
		paneId = (await paneSplitRight(deps.run, { cwd: agentCwd, pane: env.HERDR_PANE_ID, env: dagrEnv })).paneId;
		targetId = paneId;
	} else if (topology === "workspace") {
		const w = await workspaceCreate(deps.run, { cwd: agentCwd, label: name, env: dagrEnv });
		paneId = w.paneId;
		targetId = w.workspaceId;
	} else {
		const t = await tabCreate(deps.run, { cwd: agentCwd, label: name, workspace: env.HERDR_WORKSPACE_ID, env: dagrEnv });
		paneId = t.paneId;
		targetId = t.tabId;
	}
	let promptResult: "submitted" | "blocked";
	try {
		await agentStart(deps.run, { name, kind: effective.kind, paneId, piArgs });
		promptResult = await agentPrompt(deps.run, { name, text: task });
	} catch (err) {
		// sin agente corriendo no hay nada que vigilar: deshacer topología y worktree.
		// issue #9: si el close de rollback TAMBIÉN falla, el error debe mencionar
		// ambos fallos — si no, la tab queda abierta en silencio.
		let closeNote = "";
		await closeTarget(deps.run, { kind: topology, id: targetId }).catch((closeErr) => {
			closeNote = `\n⚠ rollback: close de ${topology} ${targetId} falló: ${(closeErr as Error).message} — revisa la tab a mano`;
		});
		let note = "";
		if (worktree) {
			note = await rollbackNote(deps.run, worktree);
		}
		throw new Error(`${(err as Error).message}${closeNote}${note}`);
	}

	const rec: DispatchRecord = {
		agent: name,
		taskId: deps.registry.nextTaskId(),
		topology,
		targetId,
		paneId,
		cwd: agentCwd,
		worktree,
		setupCommand,
		keepOpen: effective.keepOpen,
		createdAt: Date.now(),
		status: "live",
		piArgs,
	};
	deps.registry.add(rec);

	deps.arm(
		{ run: deps.run, spawnWait: deps.spawnWait },
		name,
		(ev) => deps.settleFor()(name, ev),
	);
	// spec 005 D1: nace la tarea del grafo — con el estado REAL de herdr
	deps.dagr?.born({
		agent: name,
		paneId,
		title: firstLine(task),
		blocked: promptResult === "blocked",
	});
	return { agent: name, paneId, taskId: rec.taskId, worktreePath: worktree?.dir, setupNote, initialBlocked: promptResult === "blocked" || undefined };
}
