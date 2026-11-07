/**
 * DagrRecorder (spec 005 D2/D3/D5): dueño del run.json de la sesión.
 *
 * - Fichero: <stateDir>/<wsSlug(label)>/<sessionId>.json; linaje heredado de
 *   DAGR_RUN/DAGR_TASK grabado DENTRO del doc (campo top-level no-contratado,
 *   tolerado por dagr check — ruling R-D).
 * - Writes SIEMPRE tmp→rename en el mismo directorio, serializados en una
 *   cadena interna (orden de eventos preservado), fire-and-forget: ningún
 *   método lanza ni bloquea el path de una tool (restricción spec). Fallo →
 *   warn y seguir (el doc vive en memoria; el próximo write reintenta entero).
 * - Validación blanda (R-G): validate(tmp) tras escribir, antes del rename;
 *   fallo → warn, rename SIEMPRE. Sin validador/binario → silencio.
 * - Tras cada write: compose(runPath) si el linaje de la raíz tiene hijos
 *   (inyectado por index.ts; T7).
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	newDoc,
	nextTaskId,
	taskBorn,
	taskBlocked,
	taskCanceled,
	taskGone,
	taskNote,
	taskPrompt,
	taskSettled,
	type DagrDoc,
} from "./dagrdoc.ts";

const execFileAsync = promisify(execFile);

export interface DagrHook {
	/** Reserva el task id del agente + env de linaje para la topología. */
	reserve(agent: string): { env: Record<string, string>; task: string } | undefined;
	born(o: { agent: string; paneId: string; title: string; blocked: boolean }): void;
	/** Despacho fallido tras reserva: libera el id, sin tarea (ruling R-E). */
	release(agent: string): void;
	/** Auto-exención de pi-herdr en hijos activa (herdr_dagr_children && recorder vivo). */
	readonly childrenExempt: boolean;
	prompt(agent: string, note: string): void;
	blocked(agent: string): void;
	settled(agent: string, state: string): void;
	gone(agent: string, receipt?: string): void;
	canceled(agent: string, receipt?: string): void;
	note(agent: string, detail: string): void;
}

export interface RecorderDeps {
	/** Default: ~/.local/state/herdr-dagr */
	stateDir?: string;
	/** undefined = válido/limpio o sin binario; string = salida del check (warn). */
	validate?: (path: string) => Promise<string | undefined>;
	warn?: (msg: string) => void;
	now?: () => Date;
	/** Regeneración del composed tras cada write (inyectado en index). */
	compose?: (runPath: string) => Promise<string | undefined>;
}

/** Hook no-op para sesiones con dagr apagado: tools idénticas (A5). */
export const NO_DAGR: DagrHook = {
	reserve: () => undefined,
	born: () => undefined,
	release: () => undefined,
	childrenExempt: false,
	prompt: () => undefined,
	blocked: () => undefined,
	settled: () => undefined,
	gone: () => undefined,
	canceled: () => undefined,
	note: () => undefined,
};

export function stateDirOf(home: string): string {
	return join(home, ".local", "state", "herdr-dagr");
}

/** Label de workspace → componente de directorio seguro. */
export function wsSlug(label: string): string {
	const slug = label.toLowerCase().replace(/[^a-z0-9._-]+/g, ".").replace(/^\.+|\.+$/g, "");
	return slug || "default";
}

/** Binario dagr: PATH o ruta del plugin instalado. Cacheado (undefined = no hay). */
let dagrBinCache: string | undefined | null = null;
async function resolveDagrBin(): Promise<string | undefined> {
	if (dagrBinCache !== null) return dagrBinCache;
	try {
		const glob = `${homedir()}/.config/herdr/plugins/github/herdr-dagr-*/bin/dagr`;
		const { stdout } = await execFileAsync(
			"sh",
			["-c", `command -v dagr || ls ${glob} 2>/dev/null | head -1`],
			{ timeout: 5_000 },
		);
		const bin = stdout.trim().split("\n")[0] ?? "";
		dagrBinCache = bin && existsSync(bin) ? bin : undefined;
	} catch {
		dagrBinCache = undefined;
	}
	return dagrBinCache;
}

/** Validador real: `dagr check --strict <tmp>` con timeout 2s (R-G). */
async function defaultValidate(path: string): Promise<string | undefined> {
	const bin = await resolveDagrBin();
	if (!bin) return undefined;
	try {
		const { stdout } = await execFileAsync(bin, ["check", path, "--strict"], { timeout: 2_000 });
		return /clean/.test(stdout) ? undefined : stdout.trim();
	} catch (err) {
		const e = err as { stdout?: string; message?: string };
		return (e.stdout ?? e.message ?? "check falló").toString().trim();
	}
}

export class DagrRecorder implements DagrHook {
	readonly runPath: string;
	readonly childrenExempt: boolean;
	private doc: DagrDoc;
	private readonly deps: Required<Pick<RecorderDeps, "warn" | "now" | "compose">> & {
		validate: (path: string) => Promise<string | undefined>;
	};
	/** Cadena de writes: serializa y preserva orden; errores aislados. */
	private queue: Promise<unknown> = Promise.resolve();
	/** Ids reservados sin born todavía (reserva→born puede atravesar awaits). */
	private readonly reserved = new Map<string, Set<string>>();
	private tmpSeq = 0;

	private constructor(runPath: string, doc: DagrDoc, childrenExempt: boolean, deps: RecorderDeps) {
		this.runPath = runPath;
		this.doc = doc;
		this.childrenExempt = childrenExempt;
		this.deps = {
			warn: deps.warn ?? ((m) => console.warn(`pi-herdr dagr: ${m}`)),
			now: deps.now ?? (() => new Date()),
			compose: deps.compose ?? (async () => undefined),
			validate: deps.validate ?? defaultValidate,
		};
	}

	/**
	 * Nunca lanza (restricción spec): fs roto → warn + recorder en memoria.
	 * Crea eager el run si no existe; adopta el existente en resume.
	 */
	static async init(o: {
		sessionId: string;
		workspaceLabel: string;
		cwdTitle: string;
		env: Record<string, string | undefined>;
		children: boolean;
		deps?: RecorderDeps;
	}): Promise<DagrRecorder> {
		const deps = o.deps ?? {};
		const stateDir = deps.stateDir ?? stateDirOf(process.env.HOME ?? homedir());
		const dir = join(stateDir, wsSlug(o.workspaceLabel));
		const runPath = join(dir, `${o.sessionId}.json`);
		const lineage =
			o.env.DAGR_RUN && o.env.DAGR_TASK
				? {
						parent_run: o.env.DAGR_RUN,
						parent_task: o.env.DAGR_TASK,
						session: o.sessionId,
						workspace: o.workspaceLabel,
						pane: o.env.HERDR_PANE_ID,
					}
				: { session: o.sessionId, workspace: o.workspaceLabel, pane: o.env.HERDR_PANE_ID };
		const title = o.cwdTitle || o.workspaceLabel || o.sessionId;
		const warns = deps.warn ?? ((m: string) => console.warn(`pi-herdr dagr: ${m}`));

		let doc: DagrDoc | undefined;
		let adopted = false;
		try {
			if (existsSync(runPath)) {
				const parsed = JSON.parse(readFileSync(runPath, "utf8")) as DagrDoc;
				if (parsed && Array.isArray(parsed.tasks) && Array.isArray(parsed.events)) {
					doc = { ...parsed, run: { ...parsed.run, id: o.sessionId } };
					adopted = true;
				} else {
					warns(`run existente sin forma válida (${runPath}) — se arranca fresh`);
				}
			}
		} catch {
			warns(`run existente ilegible (${runPath}) — se arranca fresh`);
			doc = undefined;
		}
		if (!doc) doc = newDoc({ sessionId: o.sessionId, title, now: new Date(), lineage });

		const r = new DagrRecorder(runPath, doc, o.children, deps);
		if (!adopted) r.scheduleWrite(); // fresh/corrupto → publicar eager
		await r.flush();
		return r;
	}

	flush(): Promise<void> {
		return this.queue.then(() => undefined, () => undefined);
	}

	reserve(agent: string): { env: Record<string, string>; task: string } | undefined {
		try {
			const taken = this.reserved.get(agent) ?? new Set<string>();
			let task = nextTaskId(this.doc, agent);
			let n = 0;
			while (taken.has(task) && n++ < 99) task = bump(task);
			const next = new Set(taken);
			next.add(task);
			this.reserved.set(agent, next);
			return { env: { DAGR_RUN: this.runPath, DAGR_TASK: task }, task };
		} catch (err) {
			this.deps.warn(`reserve(${agent}) falló: ${(err as Error).message}`);
			return undefined;
		}
	}

	release(agent: string): void {
		this.reserved.delete(agent);
	}

	born(o: { agent: string; paneId: string; title: string; blocked: boolean }): void {
		this.guard(() => {
			const reservedIds = this.reserved.get(o.agent);
			const taskId = reservedIds?.values().next().value as string | undefined;
			if (reservedIds) {
				reservedIds.delete(taskId!);
				if (reservedIds.size === 0) this.reserved.delete(o.agent);
			}
			taskBorn(this.doc, { ...o, now: this.deps.now(), taskId });
			this.scheduleWrite();
		}, "born");
	}

	prompt(agent: string, note: string): void {
		this.guard(() => {
			taskPrompt(this.doc, agent, note, this.deps.now());
			this.scheduleWrite();
		}, "prompt");
	}

	blocked(agent: string): void {
		this.guard(() => {
			taskBlocked(this.doc, agent, this.deps.now());
			this.scheduleWrite();
		}, "blocked");
	}

	settled(agent: string, state: string): void {
		this.guard(() => {
			taskSettled(this.doc, agent, state, this.deps.now());
			this.scheduleWrite();
		}, "settled");
	}

	gone(agent: string, receipt?: string): void {
		this.guard(() => {
			taskGone(this.doc, agent, receipt ?? "agente desaparecido", this.deps.now());
			this.scheduleWrite();
		}, "gone");
	}

	canceled(agent: string, receipt?: string): void {
		this.guard(() => {
			taskCanceled(this.doc, agent, receipt ?? "canceled", this.deps.now());
			this.scheduleWrite();
		}, "canceled");
	}

	note(agent: string, detail: string): void {
		this.guard(() => {
			taskNote(this.doc, agent, detail, this.deps.now());
			this.scheduleWrite();
		}, "note");
	}

	/** Ningún método público lanza: reducers/fs rompen → warn y seguir. */
	private guard(fn: () => void, what: string): void {
		try {
			fn();
		} catch (err) {
			this.deps.warn(`${what} falló: ${(err as Error).message}`);
		}
	}

	private scheduleWrite(): void {
		this.queue = this.queue
			.then(() => this.writeNow())
			.catch((err) => this.deps.warn(`write falló: ${(err as Error).message}`));
	}

	private async writeNow(): Promise<void> {
		const tmp = `${this.runPath}.${process.pid}.${this.tmpSeq++}.tmp`;
		mkdirSync(join(this.runPath, ".."), { recursive: true });
		writeFileSync(tmp, JSON.stringify(this.doc, null, "\t") + "\n");
		try {
			const bad = await this.deps.validate(tmp);
			if (bad) this.deps.warn(`dagr check hallazgos (se publica igualmente):\n${bad}`);
		} catch (err) {
			this.deps.warn(`validate falló (se publica igualmente): ${(err as Error).message}`);
		}
		renameSync(tmp, this.runPath);
		try {
			await this.deps.compose(this.runPath);
		} catch (err) {
			this.deps.warn(`compose falló: ${(err as Error).message}`);
		}
	}
}

/** `<agent>-<n>` → `<agent>-<n+1>` (colisiones de reserva). */
function bump(id: string): string {
	const m = /^(.*)-(\d+)$/.exec(id);
	return m ? `${m[1]}-${Number(m[2]) + 1}` : `${id}-2`;
}
