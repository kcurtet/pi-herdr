/**
 * Registro de despachos de la sesión: in-memory + persistencia vía
 * appendEntry (customType herdr-dispatch-record / herdr-dispatch-close) y
 * reconstrucción desde la rama activa. reconcile re-arma vigilancia tras
 * resume/crash (spec D6/R10).
 */
import { agentList, closeTarget, type RunFn } from "./herdr.ts";
import type { SettleHandler } from "./dispatch.ts";
import type { EmitFn, CleanupWorktreeFn } from "./settle.ts";
import type { ChildProcess } from "node:child_process";
import { armWatcher } from "./watch.ts";

export interface DispatchRecord {
	agent: string;
	taskId: string;
	topology: "tab" | "pane" | "workspace";
	/** tab_id / pane_id / workspace_id según topology: el target de close. */
	targetId: string;
	paneId: string;
	cwd: string;
	worktree?: { dir: string; branch: string };
	keepOpen: boolean;
	createdAt: number;
	status: "live" | "closed";
}

/** Subconjunto de la ExtensionAPI que el registry necesita (seam de tests). */
export interface RegistryHost {
	appendEntry(entry: unknown): void;
}

const RECORD_TYPE = "herdr-dispatch-record";
const CLOSE_TYPE = "herdr-dispatch-close";

export class Registry {
	private readonly map = new Map<string, DispatchRecord>();

	constructor(private readonly host?: RegistryHost) {}

	add(rec: DispatchRecord): void {
		this.map.set(rec.agent, rec);
		this.host?.appendEntry({ customType: RECORD_TYPE, record: { ...rec } });
	}

	get(agent: string): DispatchRecord | undefined {
		return this.map.get(agent);
	}

	list(): DispatchRecord[] {
		return [...this.map.values()];
	}

	markClosed(agent: string): void {
		const rec = this.map.get(agent);
		if (!rec) return;
		rec.status = "closed";
		this.host?.appendEntry({ customType: CLOSE_TYPE, agent });
	}

	/** Replay de entries de la rama activa: records en orden, closures cierran. */
	static fromEntries(entries: unknown[]): Registry {
		const r = new Registry();
		for (const e of entries) {
			const entry = e as { customType?: string; record?: DispatchRecord; agent?: string };
			if (entry?.customType === RECORD_TYPE && entry.record) {
				r.map.set(entry.record.agent, entry.record);
			} else if (entry?.customType === CLOSE_TYPE && entry.agent) {
				const rec = r.map.get(entry.agent);
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
	spawnWait: (name: string) => ChildProcess;
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
	const liveNames = new Set(agents.flatMap((a) => (a.name ? [a.name] : [])));
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
		// muerto: cleanup de worktree pendiente UNA vez, luego closed
		if (rec.worktree) {
			await deps
				.cleanupWorktree(deps.run, { repo: rec.cwd, dir: rec.worktree.dir, branch: rec.worktree.branch })
				.catch(() => undefined);
			rec.worktree = undefined;
		}
		deps.registry.markClosed(rec.agent);
	}
	return reArmed;
}

/** Cierre de un record vivo (shutdown/stop): close best-effort + markClosed. */
export async function closeRecord(run: RunFn, rec: DispatchRecord): Promise<void> {
	await closeTarget(run, { kind: rec.topology, id: rec.targetId }).catch(() => undefined);
}
