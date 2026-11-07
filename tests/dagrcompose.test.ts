import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeFrom, findRoot, fsComposeIO, sessPrefix } from "../src/dagrcompose.ts";
import { newDoc, taskBorn, type DagrDoc } from "../src/dagrdoc.ts";

const DAGR_BIN_GLOB = `${process.env.HOME ?? ""}/.config/herdr/plugins/github/herdr-dagr-*/bin/dagr`;

function dagrBin(): string | undefined {
	try {
		const out = execFileSync("sh", ["-c", `command -v dagr || ls ${DAGR_BIN_GLOB} 2>/dev/null | head -1`], {
			encoding: "utf8",
		}).trim();
		return out && existsSync(out) ? out : undefined;
	} catch {
		return undefined;
	}
}

const tmpDirs: string[] = [];
afterEach(() => {
	for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function newStateDir(): string {
	const d = mkdtempSync(join(tmpdir(), "pi-herdr-comp-"));
	tmpDirs.push(d);
	return d;
}

function writeRun(stateDir: string, ws: string, sessionId: string, doc: DagrDoc): string {
	const dir = join(stateDir, ws);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${sessionId}.json`);
	writeFileSync(path, JSON.stringify(doc, null, "\t"));
	return path;
}

function readJson(path: string): DagrDoc & { projects?: { id: string; title: string; parent?: string }[] } {
	return JSON.parse(readFileSync(path, "utf8")) as never;
}

const T0 = new Date("2026-11-07T12:00:00Z");
const at = (s: number) => new Date(T0.getTime() + s * 1000);

/** Escenario A7: raíz nyx → orquestador (workspace) → trabajador. */
function threeLevels(stateDir: string) {
	const root = newDoc({ sessionId: "root-nyx", title: "nyx", now: at(0), lineage: { session: "root-nyx", workspace: "nyx" } });
	taskBorn(root, { agent: "abre", paneId: "w1:p2", title: "abre el proyecto screeps", blocked: false, now: at(1) });
	const rootPath = writeRun(stateDir, "nyx", "root-nyx", root);

	const orch = newDoc({
		sessionId: "orch-9f3a",
		title: "screeps",
		now: at(2),
		lineage: { parent_run: rootPath, parent_task: "abre-1", session: "orch-9f3a", workspace: "screeps" },
	});
	taskBorn(orch, { agent: "builder", paneId: "w2:p1", title: "impl login", blocked: false, now: at(3) });
	const orchPath = writeRun(stateDir, "screeps", "orch-9f3a", orch);

	const worker = newDoc({
		sessionId: "work-77",
		title: "screeps",
		now: at(4),
		lineage: { parent_run: orchPath, parent_task: "builder-1", session: "work-77", workspace: "screeps" },
	});
	taskBorn(worker, { agent: "tests", paneId: "w2:p5", title: "tests del login", blocked: false, now: at(5) });
	const workPath = writeRun(stateDir, "screeps", "work-77", worker);

	return { rootPath, orchPath, workPath };
}

describe("sessPrefix", () => {
	it("prefijo corto y saneado por sesión", () => {
		expect(sessPrefix("orch-9f3a")).toBe("orch-9f3a");
		expect(sessPrefix("20261107-143000-a1b2c3d4e5f6")).toHaveLength(10);
		expect(sessPrefix("SES!IÓN")).toBe("sesin");
	});
});

describe("findRoot", () => {
	it("sin linaje → uno mismo", async () => {
		const st = newStateDir();
		const { rootPath } = threeLevels(st);
		expect(await findRoot(fsComposeIO(st), rootPath)).toBe(rootPath);
	});

	it("hijo → raíz walk-up por parent_run", async () => {
		const st = newStateDir();
		const { rootPath, workPath } = threeLevels(st);
		expect(await findRoot(fsComposeIO(st), workPath)).toBe(rootPath);
	});

	it("ciclo parent_run mutuo → termina devolviendo un path definido", async () => {
		const st = newStateDir();
		const a = newDoc({ sessionId: "a", title: "a", now: at(0), lineage: { parent_run: join(st, "w", "b.json"), parent_task: "t", session: "a", workspace: "w" } });
		const b = newDoc({ sessionId: "b", title: "b", now: at(0), lineage: { parent_run: join(st, "w", "a.json"), parent_task: "t", session: "b", workspace: "w" } });
		writeRun(st, "w", "a", a);
		writeRun(st, "w", "b", b);
		const root = await findRoot(fsComposeIO(st), join(st, "w", "a.json"));
		expect(typeof root).toBe("string");
	});
});

describe("composeFrom (D4)", () => {
	it("tres niveles: wrappers por parent_task, hijos prefijados, ids únicos, strict válido", async () => {
		const st = newStateDir();
		const { rootPath } = threeLevels(st);
		const warns: string[] = [];
		const io = fsComposeIO(st, (m) => warns.push(m));
		const composedPath = await composeFrom(io, rootPath);
		expect(composedPath).toBe(join(st, "composed-nyx.json"));
		expect(existsSync(composedPath!)).toBe(true);
		const doc = readJson(composedPath!);
		const projects = doc.projects ?? [];
		const pfxOrch = sessPrefix("orch-9f3a");
		const pfxWork = sessPrefix("work-77");
		const ids = projects.map((p) => p.id);
		expect(ids).toContain("w-abre-1");
		expect(ids).toContain(`${pfxOrch}-root`);
		expect(ids).toContain(`w-${pfxOrch}-builder-1`);
		expect(ids).toContain(`${pfxWork}-root`);
		const rootProj = projects.find((p) => p.id === `${pfxOrch}-root`)!;
		expect(rootProj.parent).toBe("w-abre-1");
		expect(rootProj.title).toBe("screeps");
		// tarea del padre re-homeada dentro del wrapper
		const abre = doc.tasks.find((t) => t.id === "abre-1")!;
		expect(abre.project).toBe("w-abre-1");
		// tarea del hijo prefijada y colgada de su proyecto raíz
		const builder = doc.tasks.find((t) => t.id === `${pfxOrch}-builder-1`)!;
		expect(builder.project).toBe(`${pfxOrch}-root`);
		expect(builder.attempts[0]!.id).toBe(`${pfxOrch}-builder-1·a1`);
		// el wrapper del nieto anida dentro del proyecto raíz del hijo (sin desarraigar al builder)
		const nestWrap = projects.find((p) => p.id === `w-${pfxOrch}-builder-1`)!;
		expect(nestWrap.parent).toBe(`${pfxOrch}-root`);
		// nieto bajo SU tarea (wrapper del hijo, con id prefijado)
		const tests = doc.tasks.find((t) => t.id === `${pfxWork}-tests-1`)!;
		expect(tests.project).toBe(`${pfxWork}-root`);
		const workRoot = projects.find((p) => p.id === `${pfxWork}-root`)!;
		expect(workRoot.parent).toBe(`w-${pfxOrch}-builder-1`);
		// ids de tarea únicos (E110)
		const taskIds = doc.tasks.map((t) => t.id);
		expect(new Set(taskIds).size).toBe(taskIds.length);
		// eventos mergeados y ascendentes
		const ats = doc.events.map((e) => e.at);
		expect([...ats].sort()).toEqual(ats);
		expect(doc.events.some((e) => e.task === `${pfxOrch}-builder-1`)).toBe(true);
		// sin linaje en el composed (es la vista raíz)
		expect((doc as { lineage?: unknown }).lineage).toBeUndefined();
		// sin tmps residuales
		expect(readdirSync(st).filter((f) => f.endsWith(".tmp"))).toEqual([]);
		// golden: dagr check --strict real
		const bin = dagrBin();
		if (bin) {
			const out = execFileSync(bin, ["check", composedPath!, "--strict"], { encoding: "utf8" });
			expect(out).toMatch(/clean/);
		}
	});

	it("raíz sin hijos → no compone (undefined, sin fichero)", async () => {
		const st = newStateDir();
		const root = newDoc({ sessionId: "solo", title: "x", now: at(0), lineage: { session: "solo", workspace: "solo" } });
		const rootPath = writeRun(st, "solo", "solo", root);
		expect(await composeFrom(fsComposeIO(st), rootPath)).toBeUndefined();
		expect(existsSync(join(st, "composed-solo.json"))).toBe(false);
	});

	it("parent_task huérfano → hijo skippeado con warn; composed válido sin él", async () => {
		const st = newStateDir();
		const root = newDoc({ sessionId: "root-nyx", title: "nyx", now: at(0), lineage: { session: "root-nyx", workspace: "nyx" } });
		taskBorn(root, { agent: "abre", paneId: "w1:p2", title: "t", blocked: false, now: at(1) });
		const rootPath = writeRun(st, "nyx", "root-nyx", root);
		const orphan = newDoc({
			sessionId: "orph",
			title: "o",
			now: at(2),
			lineage: { parent_run: rootPath, parent_task: "no-existe", session: "orph", workspace: "otro" },
		});
		writeRun(st, "otro", "orph", orphan);
		const warns: string[] = [];
		const composedPath = await composeFrom(fsComposeIO(st), rootPath, (m) => warns.push(m));
		expect(composedPath).toBeDefined();
		const doc = readJson(composedPath!);
		expect(doc.tasks.map((t) => t.id)).toEqual(["abre-1"]);
		expect(warns.join("\n")).toMatch(/huérfano|parent_task/i);
	});

	it("dos compositions consecutivos → último-gana, fichero íntegro ambas veces", async () => {
		const st = newStateDir();
		const { rootPath } = threeLevels(st);
		const io = fsComposeIO(st);
		const p1 = await composeFrom(io, rootPath);
		expect(existsSync(p1!)).toBe(true);
		const p2 = await composeFrom(io, rootPath);
		expect(p2).toBe(p1);
		expect(() => readJson(p2!)).not.toThrow();
	});

	it("hijo corrupto (JSON roto) → sin hijos legibles: no compone; con OTRO hijo válido, compone solo con él", async () => {
		const st = newStateDir();
		const { rootPath, orchPath } = threeLevels(st);
		writeFileSync(orchPath, "{roto");
		// sin más hijos legibles → no compone (nada que integrar)
		expect(await composeFrom(fsComposeIO(st), rootPath)).toBeUndefined();
		expect(existsSync(join(st, "composed-nyx.json"))).toBe(false);
		// con otro hijo válido → compone sin tocar el corrupto (su subárbol no aparece)
		const ok2 = newDoc({
			sessionId: "other-1",
			title: "otro-ws",
			now: at(6),
			lineage: { parent_run: rootPath, parent_task: "abre-1", session: "other-1", workspace: "otro-ws" },
		});
		taskBorn(ok2, { agent: "rev", paneId: "w3:p1", title: "review", blocked: false, now: at(7) });
		writeRun(st, "otro-ws", "other-1", ok2);
		const composedPath = await composeFrom(fsComposeIO(st), rootPath);
		expect(composedPath).toBeDefined();
		const doc = readJson(composedPath!);
		expect(doc.tasks.map((t) => t.id)).toEqual(["abre-1", `${sessPrefix("other-1")}-rev-1`]);
	});
});

describe("revisión 005 — F1: colisión de prefijo entre hermanos", () => {
	it("sessPrefix: uuid usa la COLA (aleatoria), no la cabeza (timestamp uuidv7)", () => {
		// dos uuidv7 nacidos a <1s comparten cabeza pero no cola
		const a = sessPrefix("01a1b66c-44ba-76c5-adc4-ab9440364a2d");
		const b = sessPrefix("01a1b66c-4d01-76c5-adc4-ffffffffffff");
		expect(a).not.toBe(b);
		expect(a).toBe("9440364a2d"); // últimos 10 chars saneados
	});

	it("dos hijos con el MISMO prefijo efectivo → bump -2, ids únicos, strict válido", async () => {
		const st = newStateDir();
		const root = newDoc({ sessionId: "root-nyx", title: "nyx", now: at(0), lineage: { session: "root-nyx", workspace: "nyx" } });
		taskBorn(root, { agent: "abre", paneId: "w1:p2", title: "t", blocked: false, now: at(1) });
		const rootPath = writeRun(st, "nyx", "root-nyx", root);
		// ambos hijos con session id NO-uuid que sanea igual → prefijo idéntico
		for (const sess of ["same-prefix", "same·prefix"]) {
			const child = newDoc({
				sessionId: sess,
				title: sess,
				now: at(2),
				lineage: { parent_run: rootPath, parent_task: "abre-1", session: sess, workspace: `ws-${sess}` },
			});
			taskBorn(child, { agent: "builder", paneId: "w9:p1", title: "impl", blocked: false, now: at(3) });
			writeRun(st, `ws-${sess.replace(/[^a-z]/g, "")}`, sess.replace(/[^a-z0-9-]/g, ""), child);
		}
		const composedPath = await composeFrom(fsComposeIO(st), rootPath);
		expect(composedPath).toBeDefined();
		const doc = readJson(composedPath!);
		const projIds = (doc.projects ?? []).map((p) => p.id);
		expect(new Set(projIds).size).toBe(projIds.length); // sin E104
		const taskIds = doc.tasks.map((t) => t.id);
		expect(new Set(taskIds).size).toBe(taskIds.length); // sin E110
		expect(projIds.filter((id) => id.endsWith("-root"))).toHaveLength(2);
		const bin = dagrBin();
		if (bin) {
			const out = execFileSync(bin, ["check", composedPath!, "--strict"], { encoding: "utf8" });
			expect(out).toMatch(/clean/);
		}
	});
});

describe("revisión 005 — F3: ciclo que incluye a la raíz", () => {
	it("A↔B: composeFrom(A) integra a B y NO duplica a A bajo B; warn de ciclo", async () => {
		const st = newStateDir();
		const aPath = join(st, "w", "a.json");
		const bPath = join(st, "w", "b.json");
		const a = newDoc({ sessionId: "a", title: "a", now: at(0), lineage: { parent_run: bPath, parent_task: "b-1", session: "a", workspace: "w" } });
		taskBorn(a, { agent: "ta", paneId: "w1:p1", title: "tarea a", blocked: false, now: at(1) });
		const b = newDoc({ sessionId: "b", title: "b", now: at(0), lineage: { parent_run: aPath, parent_task: "ta-1", session: "b", workspace: "w" } });
		taskBorn(b, { agent: "tb", paneId: "w1:p2", title: "tarea b", blocked: false, now: at(1) });
		writeRun(st, "w", "a", a);
		writeRun(st, "w", "b", b);
		const warns: string[] = [];
		const composedPath = await composeFrom(fsComposeIO(st), aPath, (m) => warns.push(m));
		expect(composedPath).toBeDefined();
		const doc = readJson(composedPath!);
		// A aparece UNA vez (como raíz), B integrada bajo la tarea de A… B es hija
		// de A (parent_run=aPath) → wrapper w-a-1; A no reaparece prefijada
		const taskIds = doc.tasks.map((t) => t.id);
		expect(taskIds.filter((id) => id.includes("ta-1"))).toHaveLength(1);
		expect(warns.join("\n")).toMatch(/ciclo/);
	});
});

describe("patrón del hook de index (D4: el hijo regenera el composed de SU raíz)", () => {
	it("findRoot(runPath del hijo) → composeFrom(raíz) integra al hijo recién escrito", async () => {
		const st = newStateDir();
		const { rootPath } = threeLevels(st);
		// sesión hija nueva que escribe su run con linaje
		const child = newDoc({
			sessionId: "nueva-1",
			title: "nueva",
			now: at(8),
			lineage: { parent_run: rootPath, parent_task: "abre-1", session: "nueva-1", workspace: "nueva-ws" },
		});
		taskBorn(child, { agent: "extra", paneId: "w4:p1", title: "trabajo extra", blocked: false, now: at(9) });
		const childPath = writeRun(st, "nueva-ws", "nueva-1", child);
		const io = fsComposeIO(st);
		const root = await findRoot(io, childPath);
		expect(root).toBe(rootPath);
		const out = await composeFrom(io, root!);
		expect(out).toBeDefined();
		const doc = readJson(out!);
		expect(doc.tasks.some((t) => t.id === `${sessPrefix("nueva-1")}-extra-1`)).toBe(true);
	});
});
