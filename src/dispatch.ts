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
import { armWatcher, type WatchEvent, type WaitPhase, type WatchHandle } from "./watch.ts";
import { Registry, type DispatchRecord } from "./registry.ts";
import { createWorktree, cleanupWorktree } from "./worktree.ts";
import { defaultResourceDirs, type ResourceDirs } from "./resources.ts";
import { buildPiArgs } from "./piargs.ts";
import { mergeInput, type DispatchDefaults } from "./config.ts";

export type SettleHandler = (name: string, ev: WatchEvent) => Promise<boolean>;

export interface DispatchInput {
	task: string;
	name?: string;
	cwd?: string;
	topology?: "tab" | "pane" | "workspace";
	kind?: string;
	worktree?: boolean;
	keepOpen?: boolean;
	skills?: boolean | string[];
	extensions?: boolean | string[];
}

export interface DispatchResult {
	agent: string;
	paneId: string;
	taskId: string;
	worktreePath?: string;
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
	settleFor: (rec: DispatchRecord) => SettleHandler;
	/** Dirs de resolución de skills/extensiones (spec 002). */
	resourceDirs: ResourceDirs;
	/** Defaults persistidos, RECARGADOS en cada dispatch (spec 002 D7/R6). */
	getConfig: () => DispatchDefaults;
}

/** taskId único considerando los records restaurados (issue #1). */
function nextTaskId(registry: Registry): string {
	let max = 0;
	for (const r of registry.list()) {
		const m = /^hd-(\d+)$/.exec(r.taskId);
		if (m) max = Math.max(max, Number(m[1]));
	}
	return `hd-${max + 1}`;
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
		return `El agente ${name} está bloqueado esperando aprobación o input: decide en su pane (visible en herdr) y vuelve a promptear después.`;
	}
	return `Prompt enviado a ${name}. El watcher activo notificará el próximo settle; no re-armes nada.`;
}

/** herdr_read: salida del agente (recent-unwrapped). */
export async function readAgent(deps: DispatchDeps, name: string, lines?: number): Promise<string> {
	return agentRead(deps.run, { name, lines });
}

/** herdr_agents: despachos de la sesión, línea por agente. */
export function listDispatches(deps: DispatchDeps): string {
	const recs = deps.registry.list();
	if (recs.length === 0) return "Sin despachos en esta sesión.";
	return recs
		.map((r) => {
			const parts = [r.agent, r.status, r.topology, `pane ${r.paneId}`, `task ${r.taskId}`];
			if (r.worktree) parts.push(`worktree ${r.worktree.branch} (${r.worktree.dir})`);
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
	// los flags son de la CLI de pi: jamás fluyen a otros kinds (D4)
	const piArgs = effective.kind === "pi" ? buildPiArgs(effective, deps.resourceDirs) : [];

	const cwd = input.cwd ?? deps.cwd;
	let name = await resolveName(deps.run, task, input.name);
	name = avoidRegistry(name, deps.registry, await liveNames(deps.run));
	const topology = effective.topology;

	// worktree ANTES de crear topología (spec D7: error temprano, cero side effects)
	let worktree: { repo: string; dir: string; branch: string } | undefined;
	if (input.worktree === true) {
		worktree = await createWorktree(deps.run, { repo: cwd, name });
	}
	const agentCwd = worktree?.dir ?? cwd;

	// topología → paneId (dónde vive el agente) + targetId (qué se cierra)
	let paneId: string;
	let targetId: string;
	if (topology === "pane") {
		paneId = (await paneSplitRight(deps.run, { cwd: agentCwd })).paneId;
		targetId = paneId;
	} else if (topology === "workspace") {
		const w = await workspaceCreate(deps.run, { cwd: agentCwd, label: name });
		paneId = w.paneId;
		targetId = w.workspaceId;
	} else {
		const t = await tabCreate(deps.run, { cwd: agentCwd, label: name });
		paneId = t.paneId;
		targetId = t.tabId;
	}
	try {
		await agentStart(deps.run, { name, kind: effective.kind, paneId, piArgs });
		await agentPrompt(deps.run, { name, text: task });
	} catch (err) {
		// sin agente corriendo no hay nada que vigilar: deshacer topología y worktree
		await closeTarget(deps.run, { kind: topology, id: targetId }).catch(() => undefined);
		let note = "";
		if (worktree) {
			const report = await cleanupWorktree(deps.run, worktree).catch(() => ({ removed: false, reason: "cleanup falló" }));
			note = report.removed
				? ` (worktree ${worktree.dir} eliminado en rollback)`
				: ` (worktree ${worktree.dir} CONSERVADO: ${report.reason ?? "pendiente"} — revisalo a mano)`;
		}
		throw new Error(`${(err as Error).message}${note}`);
	}

	const rec: DispatchRecord = {
		agent: name,
		taskId: nextTaskId(deps.registry),
		topology,
		targetId,
		paneId,
		cwd: agentCwd,
		worktree,
		keepOpen: effective.keepOpen,
		createdAt: Date.now(),
		status: "live",
		piArgs,
	};
	deps.registry.add(rec);

	const handle: WatchHandle = deps.arm(
		{ run: deps.run, spawnWait: deps.spawnWait },
		name,
		(ev) => deps.settleFor(rec)(name, ev),
	);
	void handle;
	return { agent: name, paneId, taskId: rec.taskId, worktreePath: worktree?.dir };
}
