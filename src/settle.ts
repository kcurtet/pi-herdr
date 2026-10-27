/**
 * Política de settle (spec D4) y formato de eventos hacia el modelo.
 *
 * settled sin keepOpen → evento final + cleanup worktree (si hay) + close +
 * markClosed. blocked → aviso, nunca close. gone → markClosed + cleanup, sin
 * close (el pane ya no existe). Todo idempotente por el estado del registry.
 */
import { closeTarget, type RunFn } from "./herdr.ts";
import type { Registry } from "./registry.ts";
import type { WatchEvent } from "./watch.ts";
import type { WorktreeRef } from "./worktree.ts";

/** Handler de settle por agente: true = re-armar vigilancia, false = cerrar. */
export type SettleHandler = (name: string, ev: WatchEvent) => Promise<boolean>;

export type EmitFn = (content: string, details: Record<string, unknown>) => void;

export interface CleanupWorktreeFn {
	(run: RunFn, o: WorktreeRef): Promise<{ removed: boolean; reason?: string }>;
}

export interface SettleDeps {
	run: RunFn;
	registry: Registry;
	emit: EmitFn;
	cleanupWorktree: CleanupWorktreeFn;
}

export function formatEvent(name: string, ev: WatchEvent): string {
	switch (ev.kind) {
		case "blocked":
			return `[${name}] blocked — el agente espera aprobación o input. Decídelo en su pane (visible en herdr) o responde con herdr_prompt.`;
		case "settled":
			return `[${name}] settled (${ev.state})\n\n${ev.output.trim() === "" ? "(sin captura de salida — léelo con herdr_read si sigue vivo)" : ev.output}`;
		case "gone":
			return `[${name}] gone — ${ev.reason}`;
	}
}

export function makeSettleHandler(deps: SettleDeps): SettleHandler {
	return async (name: string, ev: WatchEvent): Promise<boolean> => {
		const rec = deps.registry.get(name);
		if (!rec) return false;
		if (rec.status === "closed") return false;

		if (ev.kind === "blocked") {
			deps.emit(formatEvent(name, ev), { customType: "herdr-dispatch-event", agent: name, kind: ev.kind });
			return true;
		}

		if (ev.kind === "settled" && rec.keepOpen) {
			const content = `${formatEvent(name, ev)}\n\n(keepOpen: el pane queda abierto — usa herdr_prompt para otra ronda o herdr_stop para cerrar)`;
			deps.emit(content, { customType: "herdr-dispatch-event", agent: name, kind: ev.kind, keepOpen: true });
			return true;
		}

		// cierre definitivo: settled sin keepOpen, o gone
		let cleanupNote = "";
		if (rec.worktree) {
			const w = rec.worktree;
			const report = await deps.cleanupWorktree(deps.run, w);
			cleanupNote = report.removed
				? `\n(worktree eliminado: ${w.dir})`
				: `\n(worktree CONSERVADO — ${report.reason ?? "pendiente"}: ${w.dir}, rama ${w.branch})`;
		}
		let closeNote = "";
		if (ev.kind === "settled") {
			await closeTarget(deps.run, { kind: rec.topology, id: rec.targetId }).catch((err) => {
				closeNote = `\n⚠ close de ${rec.topology} ${rec.targetId} falló: ${(err as Error).message} — revisa la tab a mano`;
			});
		}
		deps.registry.markClosed(name);
		deps.emit(formatEvent(name, ev) + cleanupNote + closeNote, {
			customType: "herdr-dispatch-event",
			agent: name,
			kind: ev.kind,
		});
		return false;
	};
}
