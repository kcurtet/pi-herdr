import { describe, expect, it } from "vitest";
import { Registry, reconcile, stopAgent, type DispatchRecord } from "../src/registry.ts";
import type { RunFn } from "../src/herdr.ts";
import type { SettleHandler } from "../src/dispatch.ts";
import type { EmitFn } from "../src/settle.ts";
import type { ChildProcess } from "node:child_process";
import { fakeRun, ok, type RecordedCall } from "./helpers.ts";

function rec(over: Partial<DispatchRecord> = {}): DispatchRecord {
	return {
		agent: "impl-x",
		taskId: "hd-1",
		topology: "tab",
		targetId: "w4:t4K",
		paneId: "w4:p4M",
		cwd: "/repo",
		keepOpen: false,
		createdAt: 1_000,
		status: "live",
		...over,
	};
}

function hostStub() {
	const appended: { customType: string; data?: unknown }[] = [];
	return { appended, host: { appendEntry: (customType: string, data?: unknown) => appended.push({ customType, data }) } };
}

describe("Registry.adopt (resume)", () => {
	it("adopta sin re-persistir: cero appendEntry", () => {
		const { appended, host } = hostStub();
		const r = new Registry(host);
		r.adopt(rec({ agent: "viejo", taskId: "hd-7" }));
		expect(appended).toHaveLength(0);
		expect(r.get("viejo")!.taskId).toBe("hd-7");
	});
});

describe("Registry.nextTaskId — asignación atómica (issue #6)", () => {
	// Modela el interleave exacto de dos dispatch() concurrentes:
	// [A asigna] [B asigna] ... [A add] [B add]. Con check-then-act puro (scan
	// sin reserva) ambos verían el mismo máx y devolverían el MISMO id.
	it("dos asignaciones sin add intermedio → ids distintos (reserva monótona)", () => {
		const r = new Registry();
		const a = r.nextTaskId();
		const b = r.nextTaskId();
		expect(new Set([a, b]).size).toBe(2);
		expect([a, b]).toEqual(["hd-1", "hd-2"]);
	});

	it("asignación con await intercalado antes del add → ids distintos", async () => {
		const r = new Registry();
		const a = r.nextTaskId();
		await new Promise((res) => setTimeout(res, 0)); // ventana TOCTOU: el add de A aún no cayó
		const b = r.nextTaskId();
		expect(a).not.toBe(b);
	});

	it("considera los records restaurados: adopt hd-5 → siguiente es hd-6 (issue #1)", () => {
		const r = Registry.fromEntries([
			{ type: "custom", customType: "herdr-dispatch-record", data: rec({ agent: "previo", taskId: "hd-5", status: "closed" }) },
		]);
		expect(r.nextTaskId()).toBe("hd-6");
	});

	it("la reserva nunca retrocede: tras add real, siguiente continúa sobre el máximo emitido", () => {
		const r = new Registry();
		const a = r.nextTaskId(); // hd-1, reservado
		r.add(rec({ agent: "otro", taskId: "hd-9" })); // restaurado con id mayor
		const b = r.nextTaskId();
		expect(a).toBe("hd-1");
		expect(b).toBe("hd-10");
	});
});

describe("Registry persistencia", () => {
	it("add persiste un entry herdr-dispatch-record cuando hay host", () => {
		const { appended, host } = hostStub();
		const r = new Registry(host);
		r.add(rec());
		expect(appended).toHaveLength(1);
		expect(appended[0].customType).toBe("herdr-dispatch-record");
	});

	it("markClosed persiste el cierre", () => {
		const { appended, host } = hostStub();
		const r = new Registry(host);
		r.add(rec());
		r.markClosed("impl-x");
		expect(appended[1].customType).toBe("herdr-dispatch-close");
	});

	it("fromEntries repones solo entries propios; closures cierran; orden manda", () => {
		const entries = [
			{ type: "message", message: { role: "user" } },
			{ type: "custom", customType: "otra-cosa", data: { x: 1 } },
			{ type: "custom", customType: "herdr-dispatch-record", data: rec({ agent: "a" }) },
			{ type: "custom", customType: "herdr-dispatch-record", data: rec({ agent: "b", topology: "pane" }) },
			{ type: "custom", customType: "herdr-dispatch-close", data: { agent: "a" } },
		];
		const r = Registry.fromEntries(entries);
		expect(r.get("a")!.status).toBe("closed");
		expect(r.get("b")!.status).toBe("live");
		expect(r.get("c")).toBeUndefined();
	});
});

function agentListRun(names: string[]): RunFn {
	return async (_f, args) => {
		if (args.slice(0, 2).join(" ") === "agent list") {
			return ok(JSON.stringify({ result: { agents: names.map((n) => ({ name: n, agent_status: "idle", pane_id: "w1:p1" })) } }));
		}
		return { code: 1, stdout: "", stderr: "unmocked" };
	};
}

function reconcileDeps(over?: { run?: RunFn; registry?: Registry }) {
	const registry = over?.registry ?? new Registry();
	const armed: string[] = [];
	const cleanups: { repo: string; dir: string; branch: string }[] = [];
	const emitted: { content: string; details: Record<string, unknown> }[] = [];
	const deps = {
		run: over?.run ?? agentListRun([]),
		registry,
		cwd: "/repo",
		spawnWait: (() => ({}) as unknown as ChildProcess),
		arm: ((_wd: unknown, name: string) => {
			armed.push(name);
			return { stop() {} };
		}) as never,
		settleFor: (): SettleHandler => async () => false,
		emit: ((content: string, details: Record<string, unknown>) => {
			emitted.push({ content, details });
		}) as EmitFn,
		cleanupWorktree: async (_run: RunFn, o: { repo: string; dir: string; branch: string }) => {
			cleanups.push({ repo: o.repo, dir: o.dir, branch: o.branch });
			return { removed: true } as const;
		},
	};
	return { deps, armed, cleanups, registry, emitted };
}

describe("reconcile", () => {
	it("record live + agente vivo → re-arma watcher", async () => {
		const registry = new Registry();
		registry.add(rec());
		const { deps, armed } = reconcileDeps({ run: agentListRun(["impl-x"]), registry });
		const reArmed = await reconcile(deps);
		expect(reArmed).toEqual(["impl-x"]);
		expect(armed).toEqual(["impl-x"]);
	});

	it("record live + agente muerto → markClosed + cleanup worktree UNA vez (con repo del worktree)", async () => {
		const registry = new Registry();
		registry.add(rec({ worktree: { repo: "/w/repo", dir: "/w/.hd-worktrees/impl-x", branch: "hd/impl-x" } }));
		const { deps, cleanups } = reconcileDeps({ run: agentListRun(["otro"]), registry });
		await reconcile(deps);
		expect(registry.get("impl-x")!.status).toBe("closed");
		expect(cleanups).toEqual([{ repo: "/w/repo", dir: "/w/.hd-worktrees/impl-x", branch: "hd/impl-x" }]);
		await reconcile(deps); // segunda pasada: idempotente
		expect(cleanups).toHaveLength(1);
	});

	it("record ya closed → ni arm ni cleanup", async () => {
		const registry = new Registry();
		registry.add(rec({ worktree: { repo: "/d/repo", dir: "/d", branch: "hd/impl-x" } }));
		registry.markClosed("impl-x");
		const { deps, armed, cleanups } = reconcileDeps({ run: agentListRun(["impl-x"]), registry });
		await reconcile(deps);
		expect(armed).toHaveLength(0);
		expect(cleanups).toHaveLength(0);
	});
});

/**
 * Deps con log de ORDEN global (issue #10): los tres efectos de abandonDispatch
 * escriben sobre el MISMO array — cleanup (dep inyectable), close (closeTarget
 * vía run: [kind, "close", id]) y markClosed (appendEntry del host del registry).
 */
function orderedDeps() {
	const order: string[] = [];
	const runCalls: RecordedCall[] = [];
	const run: RunFn = async (file, args, o) => {
		runCalls.push({ file, args, opts: o });
		if (args[1] === "close") order.push(`close:${args[0]}`); // closeTarget
		if (args[0] === "agent" && args[1] === "list") {
			return ok(JSON.stringify({ result: { agents: [] } })); // nadie vivo → abandon
		}
		return ok("");
	};
	const host = {
		appendEntry: (customType: string) => {
			if (customType === "herdr-dispatch-close") order.push("markClosed");
		},
	};
	const registry = new Registry(host);
	const deps = {
		run,
		registry,
		cwd: "/repo",
		spawnWait: (() => ({}) as unknown as ChildProcess),
		arm: ((_wd: unknown, _name: string) => ({ stop() {} })) as never,
		settleFor: (): SettleHandler => async () => false,
		emit: ((_c: string, _d: Record<string, unknown>) => {}) as EmitFn,
		cleanupWorktree: async (_run: RunFn, o: { repo: string; dir: string; branch: string }) => {
			order.push("cleanup");
			return { removed: true } as const;
		},
	};
	return { deps, order, runCalls, registry };
}

describe("abandonDispatch — flag close y orden de efectos (issue #10)", () => {
	it("GIVEN reconcile de record muerto con worktree THEN sin closeTarget y orden cleanup→markClosed", async () => {
		const { deps, order, runCalls, registry } = orderedDeps();
		registry.add(rec({ worktree: { repo: "/w/repo", dir: "/w/.hd-worktrees/impl-x", branch: "hd/impl-x" } }));
		await reconcile(deps);
		// close=false en reconcile: el target ya no existe (agente muerto) — un
		// close espurio (p.ej. perder el flag y llamar con close=true) debe enrojecer.
		expect(runCalls.filter((c) => c.args[1] === "close")).toEqual([]);
		expect(order).toEqual(["cleanup", "markClosed"]);
	});

	it("GIVEN stopAgent THEN closeTarget ENTRE cleanup y markClosed (cleanup→close→markClosed)", async () => {
		const { deps, order, runCalls, registry } = orderedDeps();
		registry.add(rec({ worktree: { repo: "/w/repo", dir: "/w/.hd-worktrees/impl-x", branch: "hd/impl-x" } }));
		await stopAgent(deps, "impl-x");
		expect(runCalls.map((c) => c.args.join(" "))).toContain("tab close w4:t4K");
		expect(registry.get("impl-x")!.status).toBe("closed");
		// markClosed al INICIO del helper (antes del cleanup/close pendientes) debe enrojecer.
		expect(order).toEqual(["cleanup", "close:tab", "markClosed"]);
	});
});
