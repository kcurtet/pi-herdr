import { describe, expect, it } from "vitest";
import { formatEvent, makeSettleHandler, trackedSettle } from "../src/settle.ts";
import { Registry, type DispatchRecord } from "../src/registry.ts";
import type { WatchEvent, WatchHandle } from "../src/watch.ts";
import type { RunFn } from "../src/herdr.ts";
import { fakeRun, ok } from "./helpers.ts";

function baseRec(over: Partial<DispatchRecord> = {}): DispatchRecord {
	return {
		agent: "impl-x",
		taskId: "hd-1",
		topology: "tab",
		targetId: "w4:t4K",
		paneId: "w4:p4M",
		cwd: "/repo",
		keepOpen: false,
		createdAt: Date.now(),
		status: "live",
		...over,
	};
}

/** JSON de `agent get` con el estado que queramos (spec 006: settle verificado). */
const getJson = (status: string) =>
	`{"id":"cli:agent:get","result":{"agent":{"agent_status":"${status}","name":"impl-x","pane_id":"w4:p4M"}},"type":"agent_info"}`;

function setup(over: Partial<DispatchRecord> = {}) {
	const { run, calls } = fakeRun({
		"tab close": ok('{"result":{"type":"ok"}}'),
		"pane close": ok('{"result":{"type":"ok"}}'),
		"workspace close": ok('{"result":{"type":"ok"}}'),
		"agent get": ok(getJson("idle")),
	});
	const emitted: { content: string; details: Record<string, unknown> }[] = [];
	const emit = (content: string, details: Record<string, unknown>) => {
		emitted.push({ content, details });
	};
	const cleanups: { repo: string; dir: string; branch: string }[] = [];
	const registry = new Registry();
	const rec = baseRec(over);
	registry.add(rec);
	const cleanupWorktree = async (_run: RunFn, o: { repo: string; dir: string; branch: string }) => {
		cleanups.push({ repo: o.repo, dir: o.dir, branch: o.branch });
		return { removed: true } as const;
	};
	const handler = makeSettleHandler({ run, registry, emit, cleanupWorktree });
	return { handler, rec, registry, emitted, calls, cleanups };
}

describe("makeSettleHandler — settled", () => {
	it("sin keepOpen: emite evento final, cierra el target UNA vez, markClosed, devuelve false", async () => {
		const { handler, registry, emitted, calls } = setup();
		const again = await handler("impl-x", { kind: "settled", state: "idle", output: "resultado" });
		expect(again).toBe(false);
		expect(calls.filter((c) => c.args[1] === "close")).toHaveLength(1);
		expect(calls.find((c) => c.args[1] === "close")!.args).toEqual(["tab", "close", "w4:t4K"]);
		expect(registry.get("impl-x")!.status).toBe("closed");
		expect(emitted).toHaveLength(1);
		expect(emitted[0].content).toContain("settled (idle)");
		expect(emitted[0].content).toContain("resultado");
	});

	it("con keepOpen: NO cierra, devuelve true (sigue vigilando)", async () => {
		const { handler, calls, emitted } = setup({ keepOpen: true });
		const again = await handler("impl-x", { kind: "settled", state: "done", output: "ronda 1 lista" });
		expect(again).toBe(true);
		expect(calls).toHaveLength(0);
		expect(emitted[0].content).toContain("keepOpen");
	});

	it("con worktree y cierre definitivo: cleanup conservador ANTES de cerrar, con repo del worktree (no rec.cwd)", async () => {
		const { handler, cleanups, calls } = setup({
			cwd: "/x/.hd-worktrees/impl-x",
			worktree: { repo: "/x/repo", dir: "/x/.hd-worktrees/impl-x", branch: "hd/impl-x" },
		});
		await handler("impl-x", { kind: "settled", state: "idle", output: "ok" });
		expect(cleanups).toEqual([{ repo: "/x/repo", dir: "/x/.hd-worktrees/impl-x", branch: "hd/impl-x" }]);
		expect(calls.filter((c) => c.args[1] === "close")).toHaveLength(1);
	});
});

describe("makeSettleHandler — blocked", () => {
	it("emite aviso con 'blocked' y 'aprobación', NO cierra, devuelve true", async () => {
		const { handler, calls, emitted } = setup();
		const again = await handler("impl-x", { kind: "blocked" });
		expect(again).toBe(true);
		expect(calls).toHaveLength(0);
		expect(emitted[0].content).toMatch(/blocked/i);
		expect(emitted[0].content).toMatch(/aprobaci/i);
	});
});

describe("makeSettleHandler — gone", () => {
	// pinning issue #14 (criterio 2): gone verificado (agente ausente) mantiene
	// el comportamiento exacto de siempre — markClosed + cleanup, SIN close.
	it("markClosed, devuelve false, SIN close del pane", async () => {
		const { handler, registry, calls, emitted } = setup();
		const again = await handler("impl-x", { kind: "gone", reason: "pane cerrado a mano" });
		expect(again).toBe(false);
		expect(calls).toHaveLength(0);
		expect(registry.get("impl-x")!.status).toBe("closed");
		expect(emitted[0].content).toContain("pane cerrado a mano");
	});

	it("gone con worktree: cleanup una sola vez, sin close", async () => {
		const { handler, cleanups, calls } = setup({
			worktree: { repo: "/x/repo", dir: "/x/.hd-worktrees/impl-x", branch: "hd/impl-x" },
		});
		await handler("impl-x", { kind: "gone", reason: "muerto" });
		expect(cleanups).toHaveLength(1);
		expect(calls).toHaveLength(0);
	});
});

describe("makeSettleHandler — idempotencia", () => {
	it("record ya closed + evento repetido: ni re-cierra ni re-limpia ni emite", async () => {
		const { handler, registry, calls, emitted, cleanups } = setup({
			worktree: { repo: "/x/repo", dir: "/d", branch: "hd/impl-x" },
		});
		await handler("impl-x", { kind: "settled", state: "idle", output: "x" });
		const callsAfterFirst = calls.length;
		registry.markClosed("impl-x"); // ya closed por el primer evento
		const again = await handler("impl-x", { kind: "settled", state: "idle", output: "x" });
		expect(again).toBe(false);
		expect(calls.length).toBe(callsAfterFirst);
		expect(cleanups).toHaveLength(1);
		expect(emitted).toHaveLength(1);
	});

	it("agente desconocido en el registry: devuelve false sin tocar nada", async () => {
		const { handler, calls, emitted } = setup();
		const again = await handler("fantasma", { kind: "blocked" });
		expect(again).toBe(false);
		expect(calls).toHaveLength(0);
		expect(emitted).toHaveLength(0);
	});
});

describe("makeSettleHandler — cierre con error", () => {
	it("closeTarget falla → el evento final lo dice y el record queda closed", async () => {
		const { run } = fakeRun({ "tab close": { code: 1, stdout: "", stderr: "boom-close" } });
		const registry = new Registry();
		registry.add({
			agent: "impl-x",
			taskId: "hd-1",
			topology: "tab",
			targetId: "w4:t4K",
			paneId: "w4:p4M",
			cwd: "/repo",
			keepOpen: false,
			createdAt: 1,
			status: "live",
		});
		const emitted: { content: string }[] = [];
		const handler = makeSettleHandler({
			run,
			registry,
			emit: (content) => emitted.push({ content }),
			cleanupWorktree: async () => ({ removed: true }) as const,
		});
		const again = await handler("impl-x", { kind: "settled", state: "idle", output: "ok" });
		expect(again).toBe(false);
		expect(registry.get("impl-x")!.status).toBe("closed");
		expect(emitted[0].content).toMatch(/boom-close/);
		expect(emitted[0].content).toMatch(/close|tab/i);
	});
});

describe("makeSettleHandler — cierre por topología", () => {
	it("record pane cierra pane, record workspace cierra workspace", async () => {
		const pane = setup({ topology: "pane", targetId: "w4:p5A", paneId: "w4:p5A" });
		await pane.handler("impl-x", { kind: "settled", state: "idle", output: "x" });
		expect(pane.calls.find((c) => c.args[1] === "close")!.args).toEqual(["pane", "close", "w4:p5A"]);

		const ws = setup({ topology: "workspace", targetId: "w5", paneId: "w5:p1" });
		await ws.handler("impl-x", { kind: "settled", state: "idle", output: "x" });
		expect(ws.calls.find((c) => c.args[1] === "close")!.args).toEqual(["workspace", "close", "w5"]);
	});
});

describe("makeSettleHandler — cleanup de worktree fallido (I2, issue #13)", () => {
	function setupFailingCleanup() {
		const { run, calls } = fakeRun({
			"tab close": ok('{"result":{"type":"ok"}}'),
			"pane close": ok('{"result":{"type":"ok"}}'),
			"workspace close": ok('{"result":{"type":"ok"}}'),
		});
		const registry = new Registry();
		registry.add(baseRec({ worktree: { repo: "/x/repo", dir: "/x/.hd-worktrees/impl-x", branch: "hd/impl-x" } }));
		const emitted: { content: string; details: Record<string, unknown> }[] = [];
		const handler = makeSettleHandler({
			run,
			registry,
			emit: (content, details) => emitted.push({ content, details }),
			cleanupWorktree: async () => {
				throw new Error("git colgado");
			},
		});
		return { handler, registry, emitted, calls };
	}

	it("settled: el evento LLEGA con ⚠ nota de error + CONSERVADO, record cierra y close se intenta", async () => {
		const { handler, registry, emitted, calls } = setupFailingCleanup();
		const again = await handler("impl-x", { kind: "settled", state: "idle", output: "resultado" });
		expect(again).toBe(false);
		expect(emitted).toHaveLength(1);
		expect(emitted[0].content).toContain("settled (idle)");
		expect(emitted[0].content).toContain("resultado");
		expect(emitted[0].content).toMatch(/cleanup de worktree falló: git colgado/);
		expect(emitted[0].content).toMatch(/CONSERVADO/);
		expect(emitted[0].content).toMatch(/hd\/impl-x/);
		expect(registry.get("impl-x")!.status).toBe("closed");
		expect(calls.filter((c) => c.args[1] === "close")).toHaveLength(1);
	});

	it("gone: el evento gone LLEGA con nota de error, markClosed, sin close del pane", async () => {
		const { handler, registry, emitted, calls } = setupFailingCleanup();
		const again = await handler("impl-x", { kind: "gone", reason: "pane cerrado a mano" });
		expect(again).toBe(false);
		expect(emitted).toHaveLength(1);
		expect(emitted[0].content).toContain("pane cerrado a mano");
		expect(emitted[0].content).toMatch(/cleanup de worktree falló: git colgado/);
		expect(registry.get("impl-x")!.status).toBe("closed");
		expect(calls).toHaveLength(0);
	});
});

describe("makeSettleHandler — stranded (issue #14: wait falló con el agente vivo)", () => {
	it("record queda LIVE, evento visible con guía, SIN close NI cleanup, devuelve false", async () => {
		// con worktree a propósito: nada se limpia — el agente puede seguir usándolo
		const { handler, registry, calls, emitted, cleanups } = setup({
			worktree: { repo: "/x/repo", dir: "/x/.hd-worktrees/impl-x", branch: "hd/impl-x" },
		});
		const again = await handler("impl-x", {
			kind: "stranded",
			reason: "wait exited 3: herdr: server unreachable pero el agente SIGUE vivo — no se cierra; usa herdr_stop si quieres abortarlo",
		});
		expect(again).toBe(false);
		expect(registry.get("impl-x")!.status).toBe("live"); // herdr_stop sigue disponible
		expect(calls).toHaveLength(0); // sin close: la tab sigue abierta
		expect(cleanups).toHaveLength(0); // sin cleanup: el worktree sigue en juego
		expect(emitted).toHaveLength(1);
		expect(emitted[0].content).toContain("[impl-x] stranded");
		expect(emitted[0].content).toMatch(/SIGUE vivo/);
		expect(emitted[0].content).toMatch(/herdr_stop/);
		expect(emitted[0].details.kind).toBe("stranded");
	});

	it("idempotente e inofensivo si llega repetido sobre record live", async () => {
		const { handler, registry, emitted } = setup();
		await handler("impl-x", { kind: "stranded", reason: "wait exited 3" });
		const again = await handler("impl-x", { kind: "stranded", reason: "wait exited 3" });
		expect(again).toBe(false);
		expect(registry.get("impl-x")!.status).toBe("live");
		expect(emitted).toHaveLength(2); // re-emite el aviso (no cierra nada), p.ej. tras reconcile
	});
});

describe("makeSettleHandler — anti-blip + grace del interrupt (spec 006)", () => {
	function setup006(o: { status?: string; getThrows?: boolean; rec?: Partial<DispatchRecord> } = {}) {
		const getRoute = o.getThrows ? { code: 1, stdout: "", stderr: "boom-get" } : ok(getJson(o.status ?? "idle"));
		const { run, calls } = fakeRun({
			"tab close": ok('{"result":{"type":"ok"}}'),
			"pane close": ok('{"result":{"type":"ok"}}'),
			"workspace close": ok('{"result":{"type":"ok"}}'),
			"agent get": getRoute,
		});
		const emitted: { content: string; details: Record<string, unknown> }[] = [];
		const emit = (content: string, details: Record<string, unknown>) => emitted.push({ content, details });
		const cleanups: unknown[] = [];
		const dagrCalls: { what: string; arg?: unknown }[] = [];
		const dagr = {
			reserve: () => undefined,
			born: () => undefined,
			release: () => undefined,
			childrenExempt: false,
			prompt: () => undefined,
			blocked: () => undefined,
			settled: (a: string, s: string) => dagrCalls.push({ what: "settled", arg: [a, s] }),
			gone: () => undefined,
			canceled: () => undefined,
			note: (a: string, d: string) => dagrCalls.push({ what: "note", arg: [a, d] }),
		};
		const registry = new Registry();
		const rec = baseRec(o.rec);
		registry.add(rec);
		const cleanupWorktree = async () => {
			cleanups.push(1);
			return { removed: true } as const;
		};
		const handler = makeSettleHandler({ run, registry, emit, cleanupWorktree, dagr });
		return { handler, rec, registry, emitted, calls, cleanups, dagrCalls, getRoute };
	}

	it("blip: settled con el agente YA working (grace activo) → suprimido: 0 emit/close/cleanup/dagr, record intacto, true, grace clear (GWT5/R5)", async () => {
		const s = setup006({ status: "working", rec: { interruptGrace: true } });
		const again = await s.handler("impl-x", { kind: "settled", state: "idle", output: "blip" });
		expect(again).toBe(true);
		expect(s.emitted).toHaveLength(0);
		expect(s.calls.filter((c) => c.args[1] === "close")).toHaveLength(0);
		expect(s.cleanups).toHaveLength(0);
		expect(s.dagrCalls).toHaveLength(0);
		expect(s.registry.get("impl-x")!.status).toBe("live");
		expect(s.rec.interruptGrace).toBe(false);
	});

	it("blip sin grace también se suprime: settle transitorio genérico, no solo del interrupt", async () => {
		const s = setup006({ status: "working" });
		const again = await s.handler("impl-x", { kind: "settled", state: "idle", output: "blip" });
		expect(again).toBe(true);
		expect(s.emitted).toHaveLength(0);
		expect(s.calls.filter((c) => c.args[1] === "close")).toHaveLength(0);
		expect(s.registry.get("impl-x")!.status).toBe("live");
	});

	it("grace + agente idle: evento interrupted (kind en details), SIN close/markClosed con keepOpen:false, dagr.note, true, grace clear (GWT6/R6)", async () => {
		const s = setup006({ status: "idle", rec: { interruptGrace: true, keepOpen: false } });
		const again = await s.handler("impl-x", { kind: "settled", state: "idle", output: "abortado" });
		expect(again).toBe(true);
		expect(s.emitted).toHaveLength(1);
		expect(s.emitted[0]!.details.kind).toBe("interrupted");
		expect(s.emitted[0]!.details.agent).toBe("impl-x");
		expect(s.emitted[0]!.content).toMatch(/\[impl-x\] interrupted/);
		expect(s.emitted[0]!.content).toMatch(/herdr_prompt/);
		expect(s.emitted[0]!.content).toMatch(/herdr_stop/);
		expect(s.calls.filter((c) => c.args[1] === "close")).toHaveLength(0);
		expect(s.cleanups).toHaveLength(0);
		expect(s.registry.get("impl-x")!.status).toBe("live");
		expect(s.dagrCalls).toEqual([{ what: "note", arg: ["impl-x", "interrupted — idle a la espera de decisión"] }]);
		expect(s.rec.interruptGrace).toBe(false);
	});

	it("grace con keepOpen:true también: interrupted — el grace manda sobre keepOpen (D5)", async () => {
		const s = setup006({ status: "idle", rec: { keepOpen: true, interruptGrace: true } });
		const again = await s.handler("impl-x", { kind: "settled", state: "idle", output: "abortado" });
		expect(again).toBe(true);
		expect(s.emitted[0]!.details.kind).toBe("interrupted");
		expect(s.calls).toHaveLength(1); // solo el agent get de verificación
		expect(s.registry.get("impl-x")!.status).toBe("live");
	});

	it("grace + agent get que LANZA: grace path igual — interrupted, sin cierre con estado no verificable (GWT7)", async () => {
		const s = setup006({ getThrows: true, rec: { interruptGrace: true } });
		const again = await s.handler("impl-x", { kind: "settled", state: "idle", output: "x" });
		expect(again).toBe(true);
		expect(s.emitted).toHaveLength(1);
		expect(s.emitted[0]!.details.kind).toBe("interrupted");
		expect(s.calls.filter((c) => c.args[1] === "close")).toHaveLength(0);
		expect(s.registry.get("impl-x")!.status).toBe("live");
		expect(s.rec.interruptGrace).toBe(false);
	});

	it("sin grace + agente idle: emit final + close + markClosed — idéntico a hoy, dagr.settled (GWT8/R7)", async () => {
		const s = setup006({ status: "idle" });
		const again = await s.handler("impl-x", { kind: "settled", state: "idle", output: "resultado" });
		expect(again).toBe(false);
		expect(s.emitted).toHaveLength(1);
		expect(s.emitted[0]!.content).toContain("settled (idle)");
		expect(s.emitted[0]!.content).toContain("resultado");
		expect(s.calls.filter((c) => c.args[1] === "close")).toHaveLength(1);
		expect(s.registry.get("impl-x")!.status).toBe("closed");
		expect(s.dagrCalls).toEqual([{ what: "settled", arg: ["impl-x", "idle"] }]);
	});

	it("sin grace + agent get que lanza: entrega como hoy — JAMÁS suprimir sin verificación (GWT9)", async () => {
		const s = setup006({ getThrows: true });
		const again = await s.handler("impl-x", { kind: "settled", state: "idle", output: "resultado" });
		expect(again).toBe(false);
		expect(s.emitted).toHaveLength(1);
		expect(s.emitted[0]!.content).toContain("settled (idle)");
		expect(s.calls.filter((c) => c.args[1] === "close")).toHaveLength(1);
		expect(s.registry.get("impl-x")!.status).toBe("closed");
	});

	it("flujo interrupt→blip→settle final: SOLO se entrega el evento final; target cerrado UNA vez (GWT10/R8)", async () => {
		const s = setup006({ status: "working", rec: { interruptGrace: true } });
		const again1 = await s.handler("impl-x", { kind: "settled", state: "idle", output: "blip" });
		expect(again1).toBe(true); // suprimido: la ronda encolada ya está working
		expect(s.emitted).toHaveLength(0);
		s.getRoute.stdout = getJson("idle"); // el settle de la ronda completada
		const again2 = await s.handler("impl-x", { kind: "settled", state: "idle", output: "resultado final" });
		expect(again2).toBe(false);
		expect(s.emitted).toHaveLength(1);
		expect(s.emitted[0]!.content).toContain("resultado final");
		expect(s.calls.filter((c) => c.args[1] === "close")).toHaveLength(1);
		expect(s.registry.get("impl-x")!.status).toBe("closed");
	});

	it("keepOpen:true SIN grace: byte-idéntico a hoy — ni siquiera verifica (0 calls) (objetivo 5)", async () => {
		const s = setup006({ status: "working", rec: { keepOpen: true } });
		const again = await s.handler("impl-x", { kind: "settled", state: "done", output: "r1" });
		expect(again).toBe(true);
		expect(s.calls).toHaveLength(0);
		expect(s.emitted[0]!.content).toContain("keepOpen");
		expect(s.dagrCalls).toEqual([{ what: "settled", arg: ["impl-x", "done"] }]);
	});
});

describe("trackedSettle — el map de watchers suelta el handle en cierre definitivo (M5, issue #13)", () => {
	it("handler false (settled sin keepOpen / gone / ya closed) → elimina el handle del map", async () => {
		const watchers = new Map<string, WatchHandle>([["impl-x", { stop() {} }]]);
		const wrapped = trackedSettle(async () => false, watchers);
		expect(await wrapped("impl-x", { kind: "settled", state: "idle", output: "" })).toBe(false);
		expect(watchers.has("impl-x")).toBe(false);
	});

	it("handler true (blocked / settled con keepOpen) → el handle queda en el map", async () => {
		const watchers = new Map<string, WatchHandle>([["impl-x", { stop() {} }]]);
		const wrapped = trackedSettle(async () => true, watchers);
		expect(await wrapped("impl-x", { kind: "blocked" })).toBe(true);
		expect(watchers.has("impl-x")).toBe(true);
	});

	it("handler que lanza → el handle sale del map igualmente (issue #17: deliver mata el watcher con el throw)", async () => {
		const watchers = new Map<string, WatchHandle>([["impl-x", { stop() {} }]]);
		const wrapped = trackedSettle(async () => {
			throw new Error("boom del handler");
		}, watchers);
		await expect(wrapped("impl-x", { kind: "settled", state: "idle", output: "" })).rejects.toThrow("boom del handler");
		expect(watchers.has("impl-x")).toBe(false);
	});

	it("agente sin handle en el map: delete no-op, no lanza", async () => {
		const wrapped = trackedSettle(async () => false, new Map<string, WatchHandle>());
		await expect(wrapped("fantasma", { kind: "gone", reason: "x" })).resolves.toBe(false);
	});
});

describe("formatEvent", () => {
	it("settled: primera línea con nombre y estado, cuerpo con output", () => {
		const s = formatEvent("impl-x", { kind: "settled", state: "idle", output: "línea 1\nlínea 2" });
		expect(s.split("\n")[0]).toBe("[impl-x] settled (idle)");
		expect(s).toContain("línea 1\nlínea 2");
	});
	it("settled sin captura → lo dice explícitamente, no parece éxito vacío", () => {
		const s = formatEvent("impl-x", { kind: "settled", state: "idle", output: "" });
		expect(s).toMatch(/sin captura de salida/i);
		const s2 = formatEvent("impl-x", { kind: "settled", state: "done", output: "   \n  " });
		expect(s2).toMatch(/sin captura de salida/i);
	});
	it("blocked y gone legibles", () => {
		expect(formatEvent("a", { kind: "blocked" })).toMatch(/blocked/);
		expect(formatEvent("a", { kind: "gone", reason: "crash" })).toMatch(/gone/);
	});
	it("stranded legible: [name] stranded — reason (issue #14)", () => {
		expect(formatEvent("a", { kind: "stranded", reason: "wait exited 3" })).toBe("[a] stranded — wait exited 3");
	});
});

describe("makeSettleHandler — grabado dagr (spec 005 D0)", () => {
	function dagrFake() {
		const calls: { what: string; arg?: unknown }[] = [];
		return {
			calls,
			hook: {
				reserve: () => undefined,
				born: () => undefined,
				release: () => undefined,
				childrenExempt: false,
				prompt: (a: string, n: string) => calls.push({ what: "prompt", arg: [a, n] }),
				blocked: (a: string) => calls.push({ what: "blocked", arg: a }),
				settled: (a: string, s: string) => calls.push({ what: "settled", arg: [a, s] }),
				gone: (a: string, r?: string) => calls.push({ what: "gone", arg: [a, r] }),
				canceled: (a: string, r?: string) => calls.push({ what: "canceled", arg: [a, r] }),
				note: (a: string, d: string) => calls.push({ what: "note", arg: [a, d] }),
			},
		};
	}

	it("blocked/settled/keepOpen/gone/stranded llaman al hook con el agente", async () => {
		const dagr = dagrFake();
		const registry = new Registry();
		registry.add(baseRec({ agent: "a1" }));
		registry.add(baseRec({ agent: "a2", keepOpen: true }));
		const { run } = fakeRun({ "tab close": ok('{"result":{"type":"ok"}}') });
		const handler = makeSettleHandler({
			run,
			registry,
			emit: () => {},
			cleanupWorktree: async () => ({ removed: true }),
			dagr: dagr.hook,
		});
		await handler("a1", { kind: "blocked" });
		await handler("a2", { kind: "settled", state: "done", output: "r1" });
		await handler("a1", { kind: "settled", state: "idle", output: "fin" });
		registry.adopt(baseRec({ agent: "a3" }));
		await handler("a3", { kind: "gone", reason: "pane cerrado" });
		registry.adopt(baseRec({ agent: "a4" }));
		await handler("a4", { kind: "stranded", reason: "wait murió" });
		const whats = dagr.calls.map((c) => c.what);
		expect(whats).toEqual(["blocked", "settled", "settled", "gone", "note"]);
		expect(dagr.calls[1]!.arg).toEqual(["a2", "done"]);
		expect(String(dagr.calls[3]!.arg)).toContain("pane cerrado");
		expect(String(dagr.calls[4]!.arg)).toContain("stranded");
	});

	it("record cerrado/desconocido → hook NO llamado", async () => {
		const dagr = dagrFake();
		const registry = new Registry();
		registry.add(baseRec({ agent: "a1", status: "closed" }));
		const { run } = fakeRun({ "tab close": ok('{"result":{"type":"ok"}}') });
		const handler = makeSettleHandler({ run, registry, emit: () => {}, cleanupWorktree: async () => ({ removed: true }), dagr: dagr.hook });
		await handler("a1", { kind: "settled", state: "idle", output: "x" });
		await handler("nadie", { kind: "settled", state: "idle", output: "x" });
		expect(dagr.calls).toHaveLength(0);
	});

	it("sin hook: comportamiento intacto (regresión A5)", async () => {
		const { handler, emitted } = setup();
		const again = await handler("impl-x", { kind: "settled", state: "idle", output: "ok" });
		expect(again).toBe(false);
		expect(emitted).toHaveLength(1);
	});
});
