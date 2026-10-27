/**
 * Registro de despachos de la sesión: in-memory + persistencia vía
 * appendEntry (customType herdr-dispatch-record / herdr-dispatch-close) y
 * reconstrucción desde la rama activa. reconcile re-arma vigilancia tras
 * resume/crash (spec D6/R10).
 */
import { agentList, closeTarget, type RunFn } from "./herdr.ts";
import type { SettleHandler } from "./settle.ts";
import type { EmitFn, CleanupWorktreeFn } from "./settle.ts";
import type { ChildProcess } from "node:child_process";
import { armWatcher, type WaitPhase } from "./watch.ts";
import type { WorktreeRef } from "./worktree.ts";
import { nameSet } from "./slug.ts";

export interface DispatchRecord {
	agent: string;
	taskId: string;
	topology: "tab" | "pane" | "workspace";
	/** tab_id / pane_id / workspace_id según topology: el target de close. */
	targetId: string;
	paneId: string;
	cwd: string;
	worktree?: WorktreeRef;
	keepOpen: boolean;
	createdAt: number;
	status: "live" | "closed";
	/** Flags pi que recibió el agente (skills/extensiones, spec 002). */
	piArgs?: string[];
}

/** Subconjunto de la ExtensionAPI que el registry necesita (seam de tests). */
export interface RegistryHost {
	appendEntry(customType: string, data?: unknown): void;
}

const RECORD_TYPE = "herdr-dispatch-record";
const CLOSE_TYPE = "herdr-dispatch-close";

export class Registry {
	private readonly map = new Map<string, DispatchRecord>();
	/** Máximo taskId EMITIDO (reserva): recuerda ids asignados cuyo record aún no
	 * se ha añadido — cierra la ventana TOCTOU asignar→add (issue #6). */
	private issuedTaskId = 0;

	constructor(private readonly host?: RegistryHost) {}

	/**
	 * Próximo taskId, atómico respecto a add (issue #6): scan de los records
	 * (incluye restaurados, issue #1) y reserva del contador en el MISMO bloque
	 * síncrono. La reserva persiste aunque el add llegue después (incluso tras
	 * awaits futuros en dispatch), así dos dispatch concurrentes jamás reciben
	 * el mismo id. Los ids solo garantizan unicidad: un dispatch que falle tras
	 * asignar deja un hueco, no un duplicado.
	 */
	nextTaskId(): string {
		let max = this.issuedTaskId;
		for (const r of this.map.values()) {
			const m = /^hd-(\d+)$/.exec(r.taskId);
			if (m) max = Math.max(max, Number(m[1]));
		}
		this.issuedTaskId = max + 1;
		return `hd-${max + 1}`;
	}

	add(rec: DispatchRecord): void {
		this.map.set(rec.agent, rec);
		this.host?.appendEntry(RECORD_TYPE, { ...rec });
	}

	get(agent: string): DispatchRecord | undefined {
		return this.map.get(agent);
	}

	/** Como add pero SIN persistir: adopción de records restaurados en resume. */
	adopt(rec: DispatchRecord): void {
		this.map.set(rec.agent, rec);
	}

	list(): DispatchRecord[] {
		return [...this.map.values()];
	}

	markClosed(agent: string): void {
		const rec = this.map.get(agent);
		if (!rec) return;
		rec.status = "closed";
		this.host?.appendEntry(CLOSE_TYPE, { agent });
	}

	/** Replay de entries de la rama activa: records en orden, closures cierran. */
	static fromEntries(entries: unknown[]): Registry {
		const r = new Registry();
		for (const e of entries) {
			const entry = e as { type?: string; customType?: string; data?: { agent?: string } & Partial<DispatchRecord> };
			if (entry?.type !== "custom") continue;
			if (entry.customType === RECORD_TYPE && entry.data?.agent) {
				r.map.set(entry.data.agent, entry.data as DispatchRecord);
			} else if (entry.customType === CLOSE_TYPE && entry.data?.agent) {
				const rec = r.map.get(entry.data.agent);
				if (rec) rec.status = "closed";
			}
		}
		return r;
	}
}

export interface ReconcileDeps {
	run: RunFn;
	registry: Registry;
	cwd: string;
	spawnWait: (name: string, phase?: WaitPhase) => ChildProcess;
	arm: typeof armWatcher;
	settleFor: (rec: DispatchRecord) => SettleHandler;
	emit: EmitFn;
	cleanupWorktree: CleanupWorktreeFn;
}

/**
 * Tras resume/crash: vivos (según herdr agent list) recuperan watcher;
 * muertos se marcan closed y su worktree pendiente se limpia UNA vez.
 * Devuelve los agentes re-armados.
 */
export async function reconcile(deps: ReconcileDeps): Promise<string[]> {
	const agents = await agentList(deps.run);
	const liveNames = nameSet(agents);
	const reArmed: string[] = [];
	for (const rec of deps.registry.list()) {
		if (rec.status !== "live") continue;
		if (liveNames.has(rec.agent)) {
			deps.arm(
				{ run: deps.run, spawnWait: deps.spawnWait },
				rec.agent,
				(ev) => deps.settleFor(rec)(rec.agent, ev),
			);
			reArmed.push(rec.agent);
			continue;
		}
		// muerto: cleanup de worktree pendiente UNA vez, luego closed (sin close:
		// el agente y su pane ya no existen)
		await abandonDispatch(deps, rec, false);
	}
	return reArmed;
}

/** Cierre best-effort del target topológico: devuelve el error si falla (lo decide el caller). */
export async function closeRecord(run: RunFn, rec: DispatchRecord): Promise<Error | undefined> {
	try {
		await closeTarget(run, { kind: rec.topology, id: rec.targetId });
	} catch (err) {
		return err as Error;
	}
	return undefined;
}

/**
 * Abandona un despacho vivo: cleanup del worktree pendiente (best-effort) +
 * close del target topológico (salvo close=false: el target ya no existe,
 * p.ej. agente muerto en reconcile) + markClosed. Idempotente por estado.
 * Devuelve el error del close si falló: el caller decide cómo reportarlo
 * (stopAgent lo menciona; shutdownCleanup/reconcile lo tragan a propósito).
 */
async function abandonDispatch(deps: CleanupDeps, rec: DispatchRecord, close = true): Promise<Error | undefined> {
	if (rec.worktree) {
		await deps.cleanupWorktree(deps.run, rec.worktree).catch(() => undefined);
		rec.worktree = undefined;
	}
	const closeErr = close ? await closeRecord(deps.run, rec) : undefined;
	deps.registry.markClosed(rec.agent);
	return closeErr;
}

export interface CleanupDeps {
	run: RunFn;
	registry: Registry;
	cleanupWorktree: CleanupWorktreeFn;
}

/** herdr_stop: abandona ya — cleanup worktree + close + markClosed. */
export async function stopAgent(deps: CleanupDeps, agent: string): Promise<string> {
	const rec = deps.registry.get(agent);
	if (!rec) throw new Error(`pi-herdr: despacho "${agent}" no encontrado. Usa herdr_agents para listar.`);
	if (rec.status === "closed") throw new Error(`pi-herdr: "${agent}" ya está cerrado.`);
	const closeErr = await abandonDispatch(deps, rec);
	if (closeErr) {
		// issue #9: jamás afirmar 'cerrado' si el close falló — la tab puede seguir abierta
		return `Despacho ${agent} detenido; ojo: close de ${rec.topology} ${rec.targetId} falló — ${closeErr.message}. Revisa la tab a mano.`;
	}
	return `Despacho ${agent} detenido y ${rec.topology} cerrado.`;
}

/** herdr_stop completo (spec D1): para el watcher ANTES de cerrar el despacho. */
export async function stopDispatch(
	deps: CleanupDeps & { watchers: Map<string, { stop(): void }> },
	agent: string,
): Promise<string> {
	deps.watchers.get(agent)?.stop();
	return stopAgent(deps, agent);
}

/** session_shutdown: cierra todo lo live, idempotente, sin lanzar por fallos individuales. */
export async function shutdownCleanup(deps: CleanupDeps): Promise<void> {
	for (const rec of deps.registry.list()) {
		if (rec.status !== "live") continue;
		await abandonDispatch(deps, rec);
	}
}
