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
	workspace_id?: string;
	tab_id?: string;
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

export interface Workspace {
	workspace_id: string;
	label?: string;
}

export interface Project {
	id: string;
	label: string;
	/** Agentes SIN nombre: los lanzó la persona → orquestador(es) del proyecto. */
	leads: GlobalAgent[];
	/** Agentes CON nombre: despachados por el orquestador (implementadores, reviewers…). */
	workers: GlobalAgent[];
	blocked: number;
	/** La sesión que pregunta vive en este workspace (p.ej. Trinity en el suyo). */
	self: boolean;
}

/**
 * Agrupa por workspace (= proyecto). Orquestador = agente sin nombre (lo lanzó la persona);
 * trabajadores = agentes con nombre (los despacha pi-herdr). Lo bloqueado primero.
 */
export function groupByProject(agents: GlobalAgent[], workspaces: Workspace[], selfPane?: string): Project[] {
	const labels = new Map(workspaces.map((w) => [w.workspace_id, w.label || w.workspace_id]));
	const byWs = new Map<string, Project>();
	for (const a of agents) {
		const id = a.workspace_id ?? a.pane_id.split(":")[0] ?? "?";
		let p = byWs.get(id);
		if (!p) {
			p = { id, label: labels.get(id) ?? id, leads: [], workers: [], blocked: 0, self: false };
			byWs.set(id, p);
		}
		(a.name ? p.workers : p.leads).push(a);
		if (a.agent_status === "blocked") p.blocked++;
		if (selfPane && a.pane_id === selfPane) p.self = true;
	}
	// orden: bloqueados primero, luego los que trabajan, luego el resto; el propio al final
	const rank = (p: Project) =>
		p.self ? 3 : p.blocked > 0 ? 0 : [...p.leads, ...p.workers].some((a) => a.agent_status === "working") ? 1 : 2;
	return [...byWs.values()].sort((x, y) => rank(x) - rank(y) || x.label.localeCompare(y.label));
}

function agentLine(a: GlobalAgent, home: string | undefined): string {
	const title = (a.terminal_title_stripped ?? a.terminal_title ?? "").trim();
	const parts = [targetOf(a), a.agent ?? "?", a.agent_status ?? "unknown", shortCwd(a.cwd, home)];
	if (title) parts.push(`"${title}"`);
	if (a.focused) parts.push("(enfocado)");
	return parts.join(" · ");
}

/** herdr_agents en modo global: un bloque por proyecto, orquestador y trabajadores. */
export function formatByProject(projects: Project[], home = process.env.HOME): string {
	if (projects.length === 0) return "No hay agentes en herdr.";
	const out: string[] = [];
	let blocked = 0;
	let busy = 0;
	for (const p of projects) {
		if (!p.self) blocked += p.blocked;
		const tag = p.self ? " (tu propio workspace)" : p.blocked ? ` ⚠ ${p.blocked} bloqueado(s)` : "";
		out.push(`## ${p.label} [${p.id}]${tag}`);
		if (p.leads.length === 0) {
			out.push("  orquestador: ninguno (solo trabajadores sueltos)");
		} else if (p.leads.length === 1) {
			out.push(`  orquestador: ${agentLine(p.leads[0]!, home)}`);
		} else {
			out.push(`  orquestadores (${p.leads.length}, ¿se pisan?):`);
			for (const a of p.leads) out.push(`    - ${agentLine(a, home)}`);
		}
		if (p.workers.length > 0) {
			const working = p.workers.filter((a) => a.agent_status === "working").length;
			if (!p.self) busy += working; // la propia sesión no cuenta en el repaso
			const wb = p.workers.filter((a) => a.agent_status === "blocked").length;
			out.push(`  trabajadores: ${p.workers.length} (${working} trabajando${wb ? `, ${wb} bloqueado(s)` : ""})`);
			for (const a of p.workers) out.push(`    - ${agentLine(a, home)}`);
		}
	}
	const n = projects.filter((p) => !p.self).length;
	out.push("", `Resumen: ${n} proyecto(s) · ${busy} trabajador(es) trabajando · ${blocked} bloqueado(s)`);
	return out.join("\n");
}

export async function listWorkspaces(run: RunFn): Promise<Workspace[]> {
	const r = await run("herdr", ["workspace", "list"]);
	if (r.code !== 0) return [];
	try {
		return (JSON.parse(r.stdout) as { result?: { workspaces?: Workspace[] } }).result?.workspaces ?? [];
	} catch {
		return [];
	}
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

/** Cómo debe contarlo quien recibe el aviso (pensado para orquestadoras por voz). */
export const BRIEF_HINT =
	"Cuéntaselo a la persona en UNA sola frase: qué agente y qué ha pasado, y si tiene que decidir algo. Sin listas ni pegar la salida; el detalle solo si te lo pide.";

function tail(output: string, n = TAIL): string {
	const lines = output.split("\n");
	return lines.slice(Math.max(0, lines.length - n)).join("\n").trim();
}

export type WatchEmit = (content: string, details: Record<string, unknown>) => void;

export interface GlobalWatchDeps extends Omit<WatchDeps, "verifyAgent"> {
	emit: WatchEmit;
	/** Seam de tests: por defecto armWatcher real. */
	arm?: typeof armWatcher;
	/** spec 005 D1: eventos de vigilados para el grabado dagr (index decide si
	 * el target es despacho propio). Invocado tras el manejo propio; nunca lanza. */
	onOwnEvent?: (target: string, ev: WatchEvent) => void;
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
		this.ownEvent(target, ev);
		const details = { target, label, kind: ev.kind };
		if (ev.kind === "blocked") {
			this.deps.emit(`herdr: ${label} está bloqueado esperando una decisión en su panel (${target}).\n\n${BRIEF_HINT}`, details);
			return true; // D5: blocked siempre re-arma (espera el cambio)
		}
		if (ev.kind === "settled") {
			const out = tail(ev.output);
			this.deps.emit(`herdr: ${label} ha terminado (${ev.state}).\n\n${BRIEF_HINT}\n\nÚltima salida (contexto, no para leerla entera):\n${out}`, {
				...details,
				state: ev.state,
			});
			if (!keep) this.handles.delete(target);
			return keep;
		}
		this.handles.delete(target);
		const why = ev.kind === "gone" ? "ha desaparecido" : "ya no se puede vigilar";
		this.deps.emit(`herdr: ${label} ${why} (${ev.reason}).\n\n${BRIEF_HINT}`, details);
		return false;
	}

	/** El grafo jamás tumba la vigilancia (restricción spec 005). */
	private ownEvent(target: string, ev: WatchEvent): void {
		try {
			this.deps.onOwnEvent?.(target, ev);
		} catch {
			// grabado opcional: tragado a propósito
		}
	}
}

function describe(a: GlobalAgent): string {
	const where = a.cwd ? a.cwd.split("/").filter(Boolean).pop() : undefined;
	const kind = a.agent ?? "agente";
	if (a.name) return `${kind} "${a.name}"`;
	return where ? `${kind} de ${where}` : `${kind} ${a.pane_id}`;
}
