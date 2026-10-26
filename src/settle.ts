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
import type { SettleHandler } from "./dispatch.ts";

export type EmitFn = (content: string, details: Record<string, unknown>) => void;

export interface CleanupWorktreeFn {
	(run: RunFn, o: { repo: string; dir: string; branch: string }): Promise<{ removed: boolean; reason?: string }>;
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
			return `[${name}] settled (${ev.state})\n\n${ev.output}`;
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
			const report = await deps.cleanupWorktree(deps.run, {
				repo: rec.cwd,
				dir: rec.worktree.dir,
				branch: rec.worktree.branch,
			});
			cleanupNote = report.removed
				? `\n(worktree eliminado: ${rec.worktree.dir})`
				: `\n(worktree CONSERVADO — ${report.reason ?? "pendiente"}: ${rec.worktree.dir}, rama ${rec.worktree.branch})`;
		}
		deps.emit(formatEvent(name, ev) + cleanupNote, {
			customType: "herdr-dispatch-event",
			agent: name,
			kind: ev.kind,
		});

		if (ev.kind === "settled") {
			await closeTarget(deps.run, { kind: rec.topology, id: rec.targetId }).catch(() => undefined);
		}
		deps.registry.markClosed(name);
		return false;
	};
}
