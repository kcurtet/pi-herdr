/**
 * Orquestación del dispatch: task → tab → agente → prompt → watcher.
 * Toda ejecución herdr pasa por la RunFn inyectada.
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
	agentPrompt,
	agentStart,
	assertHerdrEnv,
	closeTarget,
	tabCreate,
	type RunFn,
} from "./herdr.ts";
import { resolveName } from "./slug.ts";
import { armWatcher, type WatchEvent, type WatchHandle } from "./watch.ts";
import { Registry, type DispatchRecord } from "./registry.ts";

export type SettleHandler = (name: string, ev: WatchEvent) => Promise<boolean>;

export interface DispatchInput {
	task: string;
	name?: string;
	cwd?: string;
	topology?: "tab" | "pane" | "workspace";
	kind?: string;
	worktree?: boolean;
	keepOpen?: boolean;
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
	spawnWait: (name: string) => ChildProcess;
	arm: typeof armWatcher;
	/** Handler de settle para el despacho (T5 inyecta el real). */
	settleFor: (rec: DispatchRecord) => SettleHandler;
}

let nextTaskId = 1;

/** spawnWait real: herdr agent wait <name>, sin timeout (lo mata el watcher). */
export function herdrWaitSpawn(name: string): ChildProcess {
	return spawn("herdr", ["agent", "wait", name], { stdio: ["ignore", "pipe", "pipe"] });
}

export async function dispatch(
	deps: DispatchDeps,
	input: DispatchInput,
	env: Record<string, string | undefined>,
): Promise<DispatchResult> {
	const task = input.task.trim();
	if (!task) throw new Error("pi-herdr: `task` es obligatoria (texto completo de la tarea)");
	assertHerdrEnv(env);

	const cwd = input.cwd ?? deps.cwd;
	const name = await resolveName(deps.run, task, input.name);
	const topology = input.topology ?? "tab";

	// T4: rama tab. pane/workspace llegan en T7, worktree en T8.
	const t = await tabCreate(deps.run, { cwd, label: name });
	try {
		await agentStart(deps.run, { name, kind: input.kind ?? "pi", paneId: t.paneId });
		await agentPrompt(deps.run, { name, text: task });
	} catch (err) {
		// sin agente corriendo no hay nada que vigilar: deshacer la topología
		await closeTarget(deps.run, { kind: "tab", id: t.tabId }).catch(() => undefined);
		throw err;
	}

	const rec: DispatchRecord = {
		agent: name,
		taskId: `hd-${nextTaskId++}`,
		topology,
		targetId: t.tabId,
		paneId: t.paneId,
		cwd,
		keepOpen: input.keepOpen === true,
		createdAt: Date.now(),
		status: "live",
	};
	deps.registry.add(rec);

	const handle: WatchHandle = deps.arm(
		{ run: deps.run, spawnWait: deps.spawnWait },
		name,
		(ev) => deps.settleFor(rec)(name, ev),
	);
	void handle;
	return { agent: name, paneId: t.paneId, taskId: rec.taskId };
}
