/**
 * Modo global (spec 004): ver, leer y VIGILAR agentes que esta sesión no despachó.
 *
 * Activado por PI_HERDR_SCOPE=global en el entorno de la sesión (D1). Los agentes
 * ajenos son de solo lectura + vigilancia (D2): nunca se cierran ni se promptean desde
 * aquí, y su watcher no pasa por settle.ts (D4).
 */
import { agentList, agentRead, type RunFn } from "./herdr.ts";
import { armWatcher, type WatchDeps, type WatchEvent, type WatchHandle } from "./watch.ts";

export type Scope = "session" | "global";

export function scopeFrom(env: Record<string, string | undefined>): Scope {
	return env.PI_HERDR_SCOPE?.trim().toLowerCase() === "global" ? "global" : "session";
}

/** Info de `herdr agent list` que usamos (el resto de campos se ignora). */
export interface GlobalAgent {
	name?: string;
	agent?: string;
	agent_status?: string;
	pane_id: string;
	cwd?: string;
	terminal_title_stripped?: string;
	terminal_title?: string;
	focused?: boolean;
}

/** Cómo referirse a un agente: su nombre si lo tiene, si no su pane_id. */
export function targetOf(a: GlobalAgent): string {
	return a.name || a.pane_id;
}

function shortCwd(cwd: string | undefined, home: string | undefined): string {
	if (!cwd) return "?";
	return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

/** Una línea por agente: objetivo · kind · estado · cwd · título. */
export function formatGlobalList(agents: GlobalAgent[], home = process.env.HOME): string {
	if (agents.length === 0) return "No hay agentes en herdr.";
	return agents
		.map((a) => {
			const title = (a.terminal_title_stripped ?? a.terminal_title ?? "").trim();
			const parts = [
				targetOf(a),
				a.agent ?? "?",
				a.agent_status ?? "unknown",
				shortCwd(a.cwd, home),
			];
			if (title) parts.push(`"${title}"`);
			if (a.focused) parts.push("(enfocado)");
			return `- ${parts.join(" · ")}`;
		})
		.join("\n");
}

export async function listGlobal(run: RunFn): Promise<GlobalAgent[]> {
	return (await agentList(run)) as unknown as GlobalAgent[];
}

/** Busca un agente por nombre o pane_id (D6). */
export async function findAgent(run: RunFn, target: string): Promise<GlobalAgent | undefined> {
	const agents = await listGlobal(run);
	return agents.find((a) => a.name === target || a.pane_id === target);
}

export async function readAny(run: RunFn, target: string, lines?: number): Promise<string> {
	return agentRead(run, { name: target, lines });
}

const TAIL = 40;

function tail(output: string, n = TAIL): string {
	const lines = output.split("\n");
	return lines.slice(Math.max(0, lines.length - n)).join("\n").trim();
}

export type WatchEmit = (content: string, details: Record<string, unknown>) => void;

export interface GlobalWatchDeps extends Omit<WatchDeps, "verifyAgent"> {
	emit: WatchEmit;
	/** Seam de tests: por defecto armWatcher real. */
	arm?: typeof armWatcher;
}

/**
 * Vigilancias de agentes ajenos. Solo informan (D4): ningún close, ningún registro.
 */
export class Watches {
	private handles = new Map<string, WatchHandle>();

	constructor(private deps: GlobalWatchDeps) {}

	has(target: string): boolean {
		return this.handles.has(target);
	}

	list(): string[] {
		return [...this.handles.keys()];
	}

	/** D7: no-op si ya se vigila. D6: la vida se verifica por nombre o pane_id. */
	async watch(target: string, opts: { keep?: boolean; label?: string } = {}): Promise<string> {
		if (this.handles.has(target)) return `Ya estaba vigilando ${target}.`;
		const found = await findAgent(this.deps.run, target);
		if (!found) throw new Error(`pi-herdr: no hay ningún agente "${target}" en herdr (usa herdr_agents).`);
		const label = opts.label || describe(found);
		const arm = this.deps.arm ?? armWatcher;
		const verifyAgent = async (t: string): Promise<boolean> => !!(await findAgent(this.deps.run, t));
		const handle = arm({ run: this.deps.run, spawnWait: this.deps.spawnWait, verifyAgent }, target, async (ev) =>
			this.onEvent(target, label, ev, !!opts.keep),
		);
		this.handles.set(target, handle);
		return `Vigilando ${label} (${target}). Avisaré cuando ${opts.keep ? "termine cada ronda o se bloquee" : "termine o se bloquee"}.`;
	}

	unwatch(target: string): string {
		const h = this.handles.get(target);
		if (!h) return `No estaba vigilando ${target}.`;
		h.stop();
		this.handles.delete(target);
		return `Dejo de vigilar ${target}.`;
	}

	stopAll(): void {
		for (const h of this.handles.values()) h.stop();
		this.handles.clear();
	}

	/** true = seguir vigilando (contrato de armWatcher). */
	private async onEvent(target: string, label: string, ev: WatchEvent, keep: boolean): Promise<boolean> {
		const details = { target, label, kind: ev.kind };
		if (ev.kind === "blocked") {
			this.deps.emit(`herdr: ${label} está bloqueado esperando una decisión en su panel (${target}).`, details);
			return true; // D5: blocked siempre re-arma (espera el cambio)
		}
		if (ev.kind === "settled") {
			const out = tail(ev.output);
			this.deps.emit(`herdr: ${label} ha terminado (${ev.state}).\n\nÚltima salida:\n${out}`, {
				...details,
				state: ev.state,
			});
			if (!keep) this.handles.delete(target);
			return keep;
		}
		this.handles.delete(target);
		const why = ev.kind === "gone" ? "ha desaparecido" : "ya no se puede vigilar";
		this.deps.emit(`herdr: ${label} ${why} (${ev.reason}).`, details);
		return false;
	}
}

function describe(a: GlobalAgent): string {
	const where = a.cwd ? a.cwd.split("/").filter(Boolean).pop() : undefined;
	const kind = a.agent ?? "agente";
	if (a.name) return `${kind} "${a.name}"`;
	return where ? `${kind} de ${where}` : `${kind} ${a.pane_id}`;
}
