/**
 * Política de settle (spec D4) y formato de eventos hacia el modelo.
 *
 * settled sin keepOpen → evento final + cleanup worktree (si hay) + close +
 * markClosed. blocked → aviso, nunca close. gone → markClosed + cleanup, sin
 * close (el pane ya no existe). Todo idempotente por el estado del registry.
 */
import { closeTarget, type RunFn } from "./herdr.ts";
import type { Registry } from "./registry.ts";
import type { WatchEvent, WatchHandle } from "./watch.ts";
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

/** Envuelve un settle handler para el map de watchers de la sesión (index.ts).
 * M5 (issue #13): en cierre definitivo (handler false — settled sin keepOpen,
 * gone o record ya cerrado) el handle sale del map; si no, los handles muertos
 * viven toda la sesión. blocked/keepOpen devuelven true y el handle queda. */
export function trackedSettle(inner: SettleHandler, watchers: Map<string, WatchHandle>): SettleHandler {
	return async (name, ev) => {
		const again = await inner(name, ev);
		if (!again) watchers.delete(name);
		return again;
	};
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
			// I2 (issue #13): un fallo de cleanup JAMÁS tumba la entrega — sin catch,
			// el handler revienta antes del emit: 0 eventos, record live, watcher
			// muerto. Catch como en rollback/abandonDispatch, con nota en el evento.
			let report: { removed: boolean; reason?: string } | undefined;
			try {
				report = await deps.cleanupWorktree(deps.run, w);
			} catch (err) {
				cleanupNote = `\n⚠ cleanup de worktree falló: ${(err as Error).message} — worktree CONSERVADO: ${w.dir}, rama ${w.branch} — revisalo a mano`;
			}
			if (report) {
				cleanupNote = report.removed
					? `\n(worktree eliminado: ${w.dir})`
					: `\n(worktree CONSERVADO — ${report.reason ?? "pendiente"}: ${w.dir}, rama ${w.branch})`;
			}
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
