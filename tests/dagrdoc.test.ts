import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	firstLine,
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
} from "../src/dagrdoc.ts";

const DAGR_BIN_GLOB = `${process.env.HOME ?? ""}/.config/herdr/plugins/github/herdr-dagr-*/bin/dagr`;

function dagrBin(): string | undefined {
	try {
		const out = execFileSync(
			"sh",
			["-c", `command -v dagr || ls ${DAGR_BIN_GLOB} 2>/dev/null | head -1`],
			{ encoding: "utf8" },
		).trim();
		return out && existsSync(out) ? out : undefined;
	} catch {
		return undefined;
	}
}

const tmpDirs: string[] = [];
afterEach(() => {
	for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Serializa doc a tmp y corre `dagr check --strict` real (skip si no hay binario). */
function checkStrict(doc: DagrDoc): void {
	const bin = dagrBin();
	if (!bin) return; // validación blanda: sin binario, el golden se salta
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-dagrdoc-"));
	tmpDirs.push(dir);
	const path = join(dir, "run.json");
	writeFileSync(path, JSON.stringify(doc));
	const r = execFileSync(bin, ["check", path, "--strict"], { encoding: "utf8" }).trim();
	expect(r).toMatch(/clean/);
}

const T0 = new Date("2026-11-07T10:00:00Z");
const t = (s: number): Date => new Date(T0.getTime() + s * 1000);

describe("firstLine", () => {
	it("primera línea no vacía, recortada a 80", () => {
		expect(firstLine("  \nconstruye el login\nmás contexto")).toBe("construye el login");
		expect(firstLine("x".repeat(120)).length).toBeLessThanOrEqual(80);
	});
});

describe("newDoc", () => {
	it("doc mínimo strict-válido, sin linaje", () => {
		const doc = newDoc({ sessionId: "s1", title: "pi-herdr", now: T0 });
		expect(doc.dagr).toBe(3);
		expect(doc.run).toEqual({ id: "s1", title: "pi-herdr", started_at: T0.toISOString() });
		expect(doc.tasks).toEqual([]);
		expect(doc.events).toEqual([]);
		expect(doc.generated_at).toBe(T0.toISOString());
		checkStrict(doc);
	});

	it("doc con linaje de hijo (parent_run/parent_task dentro del fichero)", () => {
		const doc = newDoc({
			sessionId: "s2",
			title: "screeps",
			now: T0,
			lineage: { parent_run: "/st/nyx/s1.json", parent_task: "builder-1", session: "s2", workspace: "screeps" },
		});
		expect(doc.lineage?.parent_run).toBe("/st/nyx/s1.json");
		expect(doc.lineage?.parent_task).toBe("builder-1");
		checkStrict(doc);
	});
});

describe("ciclo de vida D0 (reducers)", () => {
	it("born working → task working + a1 working con locator y liveness", () => {
		const doc = newDoc({ sessionId: "s1", title: "x", now: T0 });
		taskBorn(doc, { agent: "builder", paneId: "w1:p3", title: "construye el login", blocked: false, now: t(1) });
		const task = doc.tasks[0]!;
		expect(task.id).toBe("builder-1");
		expect(task.title).toBe("construye el login");
		expect(task.kind).toBe("agent");
		expect(task.owner).toBe("builder");
		expect(task.state).toBe("working");
		const a1 = task.attempts[0]!;
		expect(a1).toMatchObject({ id: "builder-1·a1", n: 1, state: "working", actor: "builder" });
		expect(a1.cause).toEqual({ type: "initial" });
		expect(a1.locator).toEqual({ pane: "w1:p3", agent: "builder" });
		expect(a1.liveness?.prompt_acknowledged).toBe(true);
		expect(doc.events.at(-1)).toMatchObject({ type: "attempt_started", task: "builder-1", attempt: "builder-1·a1" });
	});

	it("born initialBlocked → task blocked + a1 working + queued_input", () => {
		const doc = newDoc({ sessionId: "s1", title: "x", now: T0 });
		taskBorn(doc, { agent: "builder", paneId: "w1:p3", title: "t", blocked: true, now: t(1) });
		expect(doc.tasks[0]!.state).toBe("blocked");
		expect(doc.tasks[0]!.unblock).toBe("operator");
		expect(doc.tasks[0]!.attempts[0]!.state).toBe("working");
		expect(doc.tasks[0]!.attempts[0]!.liveness?.queued_input).toBe(1);
	});

	it("blocked tras working: idempotente, intento sigue working", () => {
		const doc = newDoc({ sessionId: "s1", title: "x", now: T0 });
		taskBorn(doc, { agent: "b", paneId: "w1:p3", title: "t", blocked: false, now: t(1) });
		taskBlocked(doc, "b", t(2));
		taskBlocked(doc, "b", t(3)); // duplicado (p.ej. watch + prompt rechazado)
		expect(doc.tasks[0]!.state).toBe("blocked");
		expect(doc.tasks[0]!.unblock).toBe("operator");
		expect(doc.tasks[0]!.attempts).toHaveLength(1);
		expect(doc.tasks[0]!.attempts[0]!.state).toBe("working");
	});

	it("prompt → a2 working con cause followup(ref a1) + task working; agent_blocked no crea intento", () => {
		const doc = newDoc({ sessionId: "s1", title: "x", now: T0 });
		taskBorn(doc, { agent: "b", paneId: "w1:p3", title: "t", blocked: false, now: t(1) });
		taskSettled(doc, "b", "idle", t(2));
		taskPrompt(doc, "b", "otra ronda", t(3));
		const task = doc.tasks[0]!;
		expect(task.state).toBe("working");
		const a2 = task.attempts[1]!;
		expect(a2).toMatchObject({ id: "b-1·a2", n: 2, state: "working" });
		expect(a2.cause).toEqual({ type: "followup", ref: "b-1·a1", reason: "herdr_prompt: otra ronda" });
		expect(a2.liveness?.prompt_acknowledged).toBe(true);
		// prompt rechazado con agent_blocked sobre tarea ya blocked: idempotente
		taskBlocked(doc, "b", t(4));
		taskBlocked(doc, "b", t(5));
		expect(task.attempts).toHaveLength(2);
		expect(task.state).toBe("blocked");
	});

	it("settled → intento terminal settled_unverified/asserted + task settled_unverified; sin locator/liveness terminal", () => {
		const doc = newDoc({ sessionId: "s1", title: "x", now: T0 });
		taskBorn(doc, { agent: "b", paneId: "w1:p3", title: "t", blocked: false, now: t(1) });
		taskSettled(doc, "b", "done", t(2));
		const task = doc.tasks[0]!;
		expect(task.state).toBe("settled_unverified");
		const a1 = task.attempts[0]!;
		expect(a1.state).toBe("settled_unverified");
		expect(a1.ended_at).toBe(t(2).toISOString());
		expect(a1.outcome).toEqual({ result: "settled_unverified", evidence: "asserted" });
		expect(a1.locator).toBeUndefined();
		expect(a1.liveness).toBeUndefined();
		// settle posterior (duplicado/keepOpen raro): no rompe el terminal
		taskSettled(doc, "b", "idle", t(3));
		expect(task.attempts).toHaveLength(1);
	});

	it("gone → intento lost outcome verified/receipt + task failed", () => {
		const doc = newDoc({ sessionId: "s1", title: "x", now: T0 });
		taskBorn(doc, { agent: "b", paneId: "w1:p3", title: "t", blocked: false, now: t(1) });
		taskGone(doc, "b", "wait exited 1", t(2));
		const task = doc.tasks[0]!;
		expect(task.state).toBe("failed");
		expect(task.attempts[0]).toMatchObject({
			state: "lost",
			outcome: { result: "lost", evidence: "verified", receipt: "wait exited 1" },
		});
	});

	it("canceled → task canceled + intento lost con receipt", () => {
		const doc = newDoc({ sessionId: "s1", title: "x", now: T0 });
		taskBorn(doc, { agent: "b", paneId: "w1:p3", title: "t", blocked: false, now: t(1) });
		taskCanceled(doc, "b", "herdr_stop", t(2));
		const task = doc.tasks[0]!;
		expect(task.state).toBe("canceled");
		expect(task.attempts[0]).toMatchObject({
			state: "lost",
			outcome: { result: "lost", evidence: "verified", receipt: "herdr_stop" },
		});
	});

	it("transición sobre tarea terminal/blocked: settle no reabre; note no cambia estado", () => {
		const doc = newDoc({ sessionId: "s1", title: "x", now: T0 });
		taskBorn(doc, { agent: "b", paneId: "w1:p3", title: "t", blocked: false, now: t(1) });
		taskSettled(doc, "b", "idle", t(2));
		taskSettled(doc, "b", "idle", t(3)); // duplicado tardío
		expect(doc.tasks[0]!.state).toBe("settled_unverified");
		taskNote(doc, "b", "stranded: wait murió, agente vivo", t(4));
		expect(doc.tasks[0]!.state).toBe("settled_unverified");
		expect(doc.events.at(-1)).toMatchObject({ type: "note", task: "b-1", detail: expect.stringContaining("stranded") });
	});

	it("agente desconocido → no-op sin throw", () => {
		const doc = newDoc({ sessionId: "s1", title: "x", now: T0 });
		expect(() => {
			taskBlocked(doc, "nadie", t(1));
			taskSettled(doc, "nadie", "idle", t(2));
			taskGone(doc, "nadie", "x", t(3));
			taskCanceled(doc, "nadie", "x", t(4));
			taskPrompt(doc, "nadie", "n", t(5));
			taskNote(doc, "nadie", "n", t(6));
		}).not.toThrow();
		expect(doc.tasks).toHaveLength(0);
	});
});

describe("nextTaskId — ids estables por sesión+nombre+contador", () => {
	it("re-dispatch del mismo nombre tras cierre → -2, -3 (no por pane)", () => {
		const doc = newDoc({ sessionId: "s1", title: "x", now: T0 });
		expect(nextTaskId(doc, "builder")).toBe("builder-1");
		taskBorn(doc, { agent: "builder", paneId: "w1:p1", title: "t", blocked: false, now: t(1) });
		taskCanceled(doc, "builder", "herdr_stop", t(2));
		expect(nextTaskId(doc, "builder")).toBe("builder-2");
		taskBorn(doc, { agent: "builder", paneId: "w9:p9", title: "t2", blocked: false, now: t(3) });
		expect(nextTaskId(doc, "builder")).toBe("builder-3");
		expect(nextTaskId(doc, "otro")).toBe("otro-1");
	});
});

describe("golden: ciclo completo strict-válido con dagr real", () => {
	it("born → blocked → prompt → settled → re-dispatch → gone → canceled", () => {
		const doc = newDoc({
			sessionId: "s-nyx",
			title: "nyx · pi-herdr",
			now: T0,
			lineage: { session: "s-nyx", workspace: "nyx" },
		});
		taskBorn(doc, { agent: "builder", paneId: "w1:p3", title: "construye el login del admin", blocked: false, now: t(1) });
		taskBlocked(doc, "builder", t(60));
		taskSettled(doc, "builder", "idle", t(120));
		taskPrompt(doc, "builder", "ahora los tests", t(130));
		taskSettled(doc, "builder", "done", t(200));
		taskBorn(doc, { agent: "builder", paneId: "w1:p7", title: "segunda tarea", blocked: true, now: t(300) });
		taskGone(doc, "builder", "wait exited 1: server caído", t(400));
		taskBorn(doc, { agent: "rev", paneId: "w1:p8", title: "review del login", blocked: false, now: t(500) });
		taskCanceled(doc, "rev", "fin de sesión", t(600));
		checkStrict(doc);
	});
});
