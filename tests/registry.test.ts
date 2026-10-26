import { describe, expect, it } from "vitest";
import { Registry, reconcile, type DispatchRecord } from "../src/registry.ts";
import type { RunFn } from "../src/herdr.ts";
import type { SettleHandler } from "../src/dispatch.ts";
import type { EmitFn } from "../src/settle.ts";
import type { ChildProcess } from "node:child_process";
import { fakeRun, ok } from "./helpers.ts";

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
	const cleanups: { dir: string; branch: string }[] = [];
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
		cleanupWorktree: async (_run: RunFn, o: { dir: string; branch: string }) => {
			cleanups.push({ dir: o.dir, branch: o.branch });
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

	it("record live + agente muerto → markClosed + cleanup worktree UNA vez", async () => {
		const registry = new Registry();
		registry.add(rec({ worktree: { dir: "/w/.hd-worktrees/impl-x", branch: "hd/impl-x" } }));
		const { deps, cleanups } = reconcileDeps({ run: agentListRun(["otro"]), registry });
		await reconcile(deps);
		expect(registry.get("impl-x")!.status).toBe("closed");
		expect(cleanups).toEqual([{ dir: "/w/.hd-worktrees/impl-x", branch: "hd/impl-x" }]);
		await reconcile(deps); // segunda pasada: idempotente
		expect(cleanups).toHaveLength(1);
	});

	it("record ya closed → ni arm ni cleanup", async () => {
		const registry = new Registry();
		registry.add(rec({ worktree: { dir: "/d", branch: "hd/impl-x" } }));
		registry.markClosed("impl-x");
		const { deps, armed, cleanups } = reconcileDeps({ run: agentListRun(["impl-x"]), registry });
		await reconcile(deps);
		expect(armed).toHaveLength(0);
		expect(cleanups).toHaveLength(0);
	});
});
