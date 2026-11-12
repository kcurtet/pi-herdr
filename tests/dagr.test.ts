import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DagrRecorder, stateDirOf, wsSlug } from "../src/dagr.ts";
import type { DagrDoc } from "../src/dagrdoc.ts";

const tmpDirs: string[] = [];
afterEach(() => {
	for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpStateDir(): string {
	const d = mkdtempSync(join(tmpdir(), "pi-herdr-dagr-"));
	tmpDirs.push(d);
	return d;
}

const NOW0 = new Date("2026-11-07T11:00:00Z");
const mkNow = () => {
	let s = 0;
	return () => new Date(NOW0.getTime() + s++ * 1000);
};

interface InitOpts {
	sessionId?: string;
	workspaceLabel?: string;
	env?: Record<string, string | undefined>;
	children?: boolean;
	validate?: (path: string) => Promise<string | undefined>;
	stateDir?: string;
}

async function initRecorder(o: InitOpts = {}) {
	const warns: string[] = [];
	const composeCalls: string[] = [];
	const now = mkNow();
	const r = await DagrRecorder.init({
		sessionId: o.sessionId ?? "sess1",
		workspaceLabel: o.workspaceLabel ?? "Nyx Workspace",
		cwdTitle: "pi-herdr",
		env: o.env ?? {},
		children: o.children ?? true,
		deps: {
			stateDir: o.stateDir ?? tmpStateDir(),
			validate: o.validate ?? (async () => undefined),
			warn: (m) => warns.push(m),
			now,
			compose: async (p) => {
				composeCalls.push(p);
				return undefined;
			},
		},
	});
	return { r, warns, composeCalls };
}

function readDoc(r: DagrRecorder): DagrDoc {
	return JSON.parse(readFileSync(r.runPath, "utf8")) as DagrDoc;
}

describe("paths", () => {
	it("stateDirOf: ~/.local/state/herdr-dagr", () => {
		expect(stateDirOf("/home/kx")).toBe("/home/kx/.local/state/herdr-dagr");
	});

	it("wsSlug: normaliza labels, fallback default", () => {
		expect(wsSlug("Nyx Workspace")).toBe("nyx.workspace");
		expect(wsSlug("proyecto_¡x!")).toBe("proyecto_.x");
		expect(wsSlug("///")).toBe("default");
	});
});

describe("DagrRecorder.init", () => {
	it("crea el run eager strict-válido en <stateDir>/<slug>/<session>.json, sin tmps", async () => {
		const { r } = await initRecorder();
		expect(r.runPath).toMatch(/nyx\.workspace\/sess1\.json$/);
		const doc = readDoc(r);
		expect(doc.dagr).toBe(3);
		expect(doc.run.id).toBe("sess1");
		expect(doc.tasks).toEqual([]);
		expect(existsSync(r.runPath)).toBe(true);
		const dir = join(r.runPath, "..");
		expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
		expect(r.childrenExempt).toBe(true);
	});

	it("hereda linaje de DAGR_RUN/DAGR_TASK y lo graba en el doc", async () => {
		const { r } = await initRecorder({
			env: { DAGR_RUN: "/st/nyx/s0.json", DAGR_TASK: "builder-1", HERDR_PANE_ID: "w1:p2" },
		});
		const doc = readDoc(r);
		expect(doc.lineage).toEqual({
			parent_run: "/st/nyx/s0.json",
			parent_task: "builder-1",
			session: "sess1",
			workspace: "Nyx Workspace",
			pane: "w1:p2",
		});
	});

	it("resume: adopta tasks/events del fichero existente y continúa contadores", async () => {
		const stateDir = tmpStateDir();
		const { r: r1 } = await initRecorder({ stateDir });
		r1.born({ agent: "builder", paneId: "w1:p3", title: "tarea uno", blocked: false });
		r1.canceled("builder", "herdr_stop");
		await r1.flush();
		const { r: r2 } = await initRecorder({ stateDir });
		const doc = readDoc(r2);
		expect(doc.tasks).toHaveLength(1);
		expect(doc.tasks[0]!.state).toBe("canceled");
		const res = r2.reserve("builder");
		expect(res?.env.DAGR_TASK).toBe("builder-2");
	});

	it("fichero corrupto: arranca fresh con warn, sin throw", async () => {
		const stateDir = tmpStateDir();
		const { r: r0 } = await initRecorder({ stateDir });
		writeFileSync(r0.runPath, "{no json");
		const { r, warns } = await initRecorder({ stateDir });
		expect(warns.length).toBeGreaterThan(0);
		expect(readDoc(r).tasks).toEqual([]);
	});

	it("stateDir roto: init NO lanza; record* tampoco; warn visible", async () => {
		const notADir = join(tmpdir(), "pi-herdr-dagr-notdir");
		tmpDirs.push(notADir);
		writeFileSync(notADir, "x"); // path ocupado por un fichero
		const { r, warns } = await initRecorder({ stateDir: join(notADir, "sub") });
		expect(() =>
			r.born({ agent: "b", paneId: "w1:p1", title: "t", blocked: false })
		).not.toThrow();
		await r.flush();
		expect(warns.length).toBeGreaterThan(0);
	});
});

describe("reserve / release (R-E)", () => {
	it("reserve devuelve DAGR_RUN abs + DAGR_TASK; ids estables; release libera", async () => {
		const { r } = await initRecorder();
		const res1 = r.reserve("builder");
		expect(res1).toEqual({ env: { DAGR_RUN: r.runPath, DAGR_TASK: "builder-1" }, task: "builder-1" });
		// segunda reserva concurrente del mismo nombre → otro id (no colisión)
		expect(r.reserve("builder")?.task).toBe("builder-2");
		r.release("builder"); // libera la última reserva
		r.born({ agent: "builder", paneId: "w1:p3", title: "t", blocked: false });
		await r.flush();
		const doc = readDoc(r);
		expect(doc.tasks[0]!.id).toBe("builder-1");
		expect(doc.tasks).toHaveLength(1);
	});

	it("born tras reserve usa el id reservado", async () => {
		const { r } = await initRecorder();
		const res = r.reserve("rev");
		r.born({ agent: "rev", paneId: "w1:p9", title: "review", blocked: false });
		await r.flush();
		expect(readDoc(r).tasks[0]!.id).toBe(res?.task);
	});
});

describe("ciclo de vida grabado (writes atómicos, ordenados)", () => {
	it("born → blocked → settled → prompt → settled quedan en el fichero final", async () => {
		const { r, composeCalls } = await initRecorder();
		r.born({ agent: "builder", paneId: "w1:p3", title: "construye el login", blocked: false });
		r.blocked("builder");
		r.settled("builder", "idle");
		r.prompt("builder", "ahora los tests");
		r.settled("builder", "done");
		await r.flush();
		const doc = readDoc(r);
		const task = doc.tasks[0]!;
		expect(task.id).toBe("builder-1");
		expect(task.state).toBe("settled_unverified");
		expect(task.attempts.map((a) => a.n)).toEqual([1, 2]);
		// orden de eventos preservado y ascendente
		const ats = doc.events.map((e) => e.at);
		expect([...ats].sort()).toEqual(ats);
		expect(doc.events.length).toBeGreaterThanOrEqual(5);
		// compose regenerado tras cada write (≥1; último-gana)
		expect(composeCalls.length).toBeGreaterThanOrEqual(1);
		expect(composeCalls.at(-1)).toBe(r.runPath);
		// sin tmps residuales
		expect(readdirSync(join(r.runPath, "..")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});

	it("gone/canceled/note/prompt-rechazado (blocked idempotente)", async () => {
		const { r } = await initRecorder();
		r.born({ agent: "a1", paneId: "w1:p1", title: "t", blocked: false });
		r.born({ agent: "a2", paneId: "w1:p2", title: "t", blocked: true });
		r.blocked("a2"); // idempotente (prompt rechazado tras evento blocked)
		r.gone("a1", "wait exited 1");
		r.canceled("a2", "fin de sesión");
		r.note("a1", "post-mortem");
		await r.flush();
		const doc = readDoc(r);
		expect(doc.tasks.find((t) => t.id === "a1-1")!.state).toBe("failed");
		expect(doc.tasks.find((t) => t.id === "a2-1")!.state).toBe("canceled");
		expect(doc.tasks.find((t) => t.id === "a2-1")!.attempts).toHaveLength(1);
	});

	it("issue #20 (W209): prompt mientras trabaja + settle → a2 reconciliado lost en el run file", async () => {
		const { r } = await initRecorder();
		r.born({ agent: "impl", paneId: "w1:p3", title: "tarea", blocked: false });
		r.prompt("impl", "nudge"); // a2 working mientras a1 sigue working
		r.settled("impl", "idle"); // el pane settlea y cierra
		await r.flush();
		const doc = readDoc(r);
		const task = doc.tasks[0]!;
		expect(task.state).toBe("settled_unverified");
		expect(task.attempts.map((a) => a.state)).toEqual(["lost", "settled_unverified"]);
		expect(task.attempts[0]!.ended_at).toBeTruthy();
		expect(doc.events.at(-1)).toMatchObject({ type: "attempt_settled", attempt: task.attempts[0]!.id });
	});

	it("agente sin tarea (ajeno/desconocido): no-op sin fichero nuevo", async () => {
		const { r } = await initRecorder();
		r.settled("nadie", "idle");
		r.canceled("nadie", "x");
		await r.flush();
		expect(readDoc(r).tasks).toEqual([]);
	});
});

describe("validación blanda (R-G)", () => {
	it("validate recibe el tmp ANTES del rename; fallo → warn + rename ocurre igual", async () => {
		const seen: { path: string; exists: boolean }[] = [];
		const stateDir = tmpStateDir();
		const { r, warns } = await initRecorder({
			stateDir,
			validate: async (p) => {
				seen.push({ path: p, exists: existsSync(p) });
				return "E999 fake";
			},
		});
		r.born({ agent: "b", paneId: "w1:p1", title: "t", blocked: false });
		await r.flush();
		expect(seen.length).toBeGreaterThanOrEqual(1);
		expect(seen.every((s) => s.exists && s.path.endsWith(".tmp"))).toBe(true);
		expect(existsSync(r.runPath)).toBe(true); // publicado igualmente
		expect(warns.join("\n")).toContain("E999");
	});

	it("validate limpia → sin warn", async () => {
		const { r, warns } = await initRecorder({ validate: async () => undefined });
		r.born({ agent: "b", paneId: "w1:p1", title: "t", blocked: false });
		await r.flush();
		expect(warns).toEqual([]);
	});
});

describe("flush", () => {
	it("drena la cola incluso con writes fallidos previos", async () => {
		const stateDir = tmpStateDir();
		const { r } = await initRecorder({ stateDir });
		r.born({ agent: "b", paneId: "w1:p1", title: "t", blocked: false });
		rmSync(stateDir, { recursive: true, force: true }); // fs desaparece
		r.settled("b", "idle");
		await expect(r.flush()).resolves.toBeUndefined();
	});
});
