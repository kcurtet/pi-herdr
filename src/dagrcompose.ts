/**
 * Compositor D4 (spec 005): la vista integrada de un linaje.
 *
 * Tras cada write del propio run, la sesión regenera el composed DE SU RAÍZ
 * (walk-up por lineage.parent_run). Integración v3 (parent es siempre project):
 * por cada parent_task se crea un PROYECTO WRAPPER con el id y título de esa
 * tarea, la tarea del padre se re-homea dentro del wrapper (task.project) y el
 * proyecto raíz del hijo cuelga del wrapper. Ids de hijos prefijados por sesión
 * (sin colisiones); events re-escritos con el mismo mapa y sorteados asc.
 *
 * El composed es un artefacto derivado: atómico (tmp→rename), último-gana,
 * jamás bloquea a nadie (lo llama el recorder desde su cola de writes).
 * Huérfanos (parent_task inexistente / fichero corrupto) → hijo skippeado + warn.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { DagrDoc, DagrEvent, DagrTask } from "./dagrdoc.ts";

export interface ComposeIO {
	/** Todos los run.json del state dir (sin composed-*, sin tmps). */
	listRunFiles(): Promise<string[]>;
	readDoc(path: string): Promise<DagrDoc | undefined>;
	writeAtomic(path: string, doc: DagrDoc): Promise<void>;
}

const MAX_DEPTH = 16;

/** Prefijo de ids por sesión: [a-z0-9-], máx 10 chars. */
export function sessPrefix(sessionId: string): string {
	const p = sessionId.toLowerCase().replace(/[^a-z0-9-]+/g, "").slice(0, 10);
	return p || "s";
}

/** IO real sobre el state dir. */
export function fsComposeIO(stateDir: string, warn: (m: string) => void = () => {}): ComposeIO {
	let tmpSeq = 0;
	return {
		async listRunFiles() {
			const out: string[] = [];
			let wsDirs: string[] = [];
			try {
				wsDirs = readdirSync(stateDir).map((d) => join(stateDir, d)).filter((p) => {
					try {
						return statSync(p).isDirectory();
					} catch {
						return false;
					}
				});
			} catch {
				return out;
			}
			for (const dir of wsDirs) {
				try {
					for (const f of readdirSync(dir)) {
						if (f.endsWith(".json") && !f.startsWith("composed-")) out.push(join(dir, f));
					}
				} catch (err) {
					warn(`listado de ${dir} falló: ${(err as Error).message}`);
				}
			}
			return out;
		},
		async readDoc(path) {
			try {
				const parsed = JSON.parse(readFileSync(path, "utf8")) as DagrDoc;
				return parsed && Array.isArray(parsed.tasks) ? parsed : undefined;
			} catch {
				return undefined;
			}
		},
		async writeAtomic(path, doc) {
			mkdirSync(dirname(path), { recursive: true });
			const tmp = `${path}.${process.pid}.${tmpSeq++}.tmp`;
			writeFileSync(tmp, JSON.stringify(doc, null, "\t") + "\n");
			renameSync(tmp, path);
		},
	};
}

/** Raíz del linaje de runPath: walk-up por lineage.parent_run (visited + depth). */
export async function findRoot(io: ComposeIO, runPath: string): Promise<string | undefined> {
	const visited = new Set<string>();
	let cur = runPath;
	for (let depth = 0; depth < MAX_DEPTH; depth++) {
		if (visited.has(cur)) return cur; // ciclo defensivo: nunca colgar
		visited.add(cur);
		const doc = await io.readDoc(cur);
		if (!doc) return cur; // ilegible: no podemos subir más — esta es la raíz reachable
		const parent = doc.lineage?.parent_run;
		if (!parent || !existsSync(parent)) return cur;
		cur = parent;
	}
	return cur;
}

interface Integrated {
	/** task ids locales → ids en el composed (raíz: identidad). */
	taskMap: Map<string, string>;
}

/**
 * Compone desde rootPath: carga raíz + descendientes (BFS por parent_run),
 * integra wrappers/hijos y escribe `<stateDir>/composed-<slug raíz>.json`.
 * undefined si la raíz no tiene hijos (nada que integrar) o es ilegible.
 */
export async function composeFrom(io: ComposeIO, rootPath: string, warn: (m: string) => void = () => {}): Promise<string | undefined> {
	const rootDoc = await io.readDoc(rootPath);
	if (!rootDoc) {
		warn(`compose: raíz ilegible (${rootPath}) — no se compone`);
		return undefined;
	}

	// cargar todos los docs indexados por path (los ilegibles no existen)
	const files = await io.listRunFiles();
	const docs = new Map<string, DagrDoc>();
	for (const f of files) {
		const d = await io.readDoc(f);
		if (d) docs.set(f, d);
	}
	// hijos por parent_run
	const childrenOf = new Map<string, string[]>();
	for (const [path, d] of docs) {
		const parent = d.lineage?.parent_run;
		if (!parent) continue;
		const list = childrenOf.get(parent) ?? [];
		list.push(path);
		childrenOf.set(parent, list);
	}
	const rootChildren = childrenOf.get(rootPath) ?? [];
	if (rootChildren.length === 0) return undefined; // sin hijos: no compone (spec)

	const now = new Date().toISOString();
	const composed: DagrDoc = {
		...structuredClone(rootDoc),
		generated_at: now,
		lineage: undefined,
		projects: [],
	};
	const integrated = new Map<string, Integrated>([[rootPath, { taskMap: new Map(rootDoc.tasks.map((t) => [t.id, t.id])) }]]);

	// BFS con guardas de ciclo: un path ya integrado no se reintegra
	const queue = [...rootChildren];
	const done = new Set<string>();
	while (queue.length > 0) {
		const childPath = queue.shift()!;
		if (done.has(childPath)) continue; // ciclo: ya está debajo
		done.add(childPath);
		const child = docs.get(childPath);
		if (!child) {
			warn(`compose: hijo ilegible (${childPath}) — se salta`);
			continue;
		}
		const parentPath = child.lineage!.parent_run!;
		const parentInt = integrated.get(parentPath);
		if (!parentInt) {
			warn(`compose: padre no integrado (${basename(childPath)}) — se salta`);
			continue;
		}
		// parent_task resuelto al contexto del padre (prefijado si el padre es hijo)
		const parentTaskId = parentInt.taskMap.get(child.lineage!.parent_task ?? "");
		const parentTask = parentTaskId ? composed.tasks.find((t) => t.id === parentTaskId) : undefined;
		if (!parentTask) {
			warn(`compose: parent_task huérfano "${child.lineage!.parent_task}" (${basename(childPath)}) — se salta y se loguea`);
			continue;
		}

		const prefix = sessPrefix(child.run.id);
		const taskMap = new Map<string, string>();
		for (const t of child.tasks) taskMap.set(t.id, `${prefix}-${t.id}`);
		const attemptMap = new Map<string, string>();
		for (const t of child.tasks) {
			for (const a of t.attempts) attemptMap.set(a.id, `${prefix}-${a.id}`);
		}
		const rootProjectId = `${prefix}-root`;
		const wrapperId = `w-${parentTaskId}`;
		const projects = composed.projects ?? (composed.projects = []);

		// wrapper con id y título de la tarea padre. Si la tarea padre vive en la
		// raíz del run (sin project): se re-homea dentro del wrapper y el wrapper
		// queda hijo del run. Si YA vive en un proyecto (padre es a su vez hijo):
		// el wrapper anida DENTRO de ese proyecto, sin tocar la tarea — así el
		// nieto cuelga de SU tarea sin desarraigar al padre de su propio scope.
		const existing = projects.find((p) => p.id === wrapperId);
		if (!existing) {
			if (parentTask.project === undefined) {
				projects.push({ id: wrapperId, title: parentTask.title });
				parentTask.project = wrapperId; // re-home de la tarea del padre
			} else {
				projects.push({ id: wrapperId, title: parentTask.title, parent: parentTask.project });
			}
		}
		projects.push({ id: rootProjectId, title: child.run.title, parent: wrapperId });

		// tareas del hijo: ids prefijados, project = su raíz
		const cloneTask = (t: DagrTask): DagrTask => ({
			...structuredClone(t),
			id: taskMap.get(t.id)!,
			project: rootProjectId,
			attempts: t.attempts.map((a) => ({ ...structuredClone(a), id: attemptMap.get(a.id)! })),
		});
		composed.tasks.push(...child.tasks.map(cloneTask));

		// events del hijo reescritos; refs que no mapan se sueltan (E170)
		const remapEvent = (e: DagrEvent): DagrEvent | undefined => {
			const task = e.task !== undefined ? taskMap.get(e.task) : undefined;
			const attempt = e.attempt !== undefined ? attemptMap.get(e.attempt) : undefined;
			if ((e.task !== undefined && task === undefined) || (e.attempt !== undefined && attempt === undefined)) return undefined;
			return { ...e, task, attempt };
		};
		composed.events.push(...child.events.map(remapEvent).filter((e): e is DagrEvent => e !== undefined));

		integrated.set(childPath, { taskMap });
		queue.push(...(childrenOf.get(childPath) ?? []));
	}

	// eventos ascendentes (W207): root primero, hijos ya añadidos tras el BFS
	composed.events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
	composed.generated_at = now;

	const slug = basename(dirname(rootPath));
	const composedPath = join(dirname(rootPath), "..", `composed-${slug}.json`);
	await io.writeAtomic(composedPath, composed);
	return composedPath;
}
