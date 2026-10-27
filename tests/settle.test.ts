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

function setup(over: Partial<DispatchRecord> = {}) {
	const { run, calls } = fakeRun({
		"tab close": ok('{"result":{"type":"ok"}}'),
		"pane close": ok('{"result":{"type":"ok"}}'),
		"workspace close": ok('{"result":{"type":"ok"}}'),
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
		expect(calls[0].args).toEqual(["tab", "close", "w4:t4K"]);
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
		expect(pane.calls[0].args).toEqual(["pane", "close", "w4:p5A"]);

		const ws = setup({ topology: "workspace", targetId: "w5", paneId: "w5:p1" });
		await ws.handler("impl-x", { kind: "settled", state: "idle", output: "x" });
		expect(ws.calls[0].args).toEqual(["workspace", "close", "w5"]);
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
});
