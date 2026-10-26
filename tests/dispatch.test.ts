import { describe, expect, it } from "vitest";
import { dispatch, promptAgent, readAgent, type DispatchDeps } from "../src/dispatch.ts";
import { Registry, type DispatchRecord } from "../src/registry.ts";
import type { WatchEvent } from "../src/watch.ts";
import type { ChildProcess } from "node:child_process";
import { fakeRun, fx, ok } from "./helpers.ts";

type SettleHandler = (name: string, ev: WatchEvent) => Promise<boolean>;

function makeDeps(overrides?: Partial<DispatchDeps> & { settleDecisions?: boolean[] }): {
	deps: DispatchDeps;
	settleEvents: { name: string; ev: WatchEvent }[];
	armedWith: string[];
} {
	const settleEvents: { name: string; ev: WatchEvent }[] = [];
	const armedWith: string[] = [];
	const decisions = overrides?.settleDecisions ?? [false];
	let i = 0;
	const settleFor = (rec: DispatchRecord): SettleHandler => {
		return async (name, ev) => {
			settleEvents.push({ name, ev });
			return decisions[Math.min(i++, decisions.length - 1)] ?? false;
		};
	};
	const deps: DispatchDeps = {
		run: overrides?.run ?? fakeRun({}).run,
		registry: overrides?.registry ?? new Registry(),
		cwd: overrides?.cwd ?? "/repo",
		spawnWait: overrides?.spawnWait ?? (() => ({ kill() {} }) as unknown as ChildProcess),
		arm:
			overrides?.arm ??
			((_wd, name, _onEvent) => {
				armedWith.push(name);
				return { stop() {} };
			}),
		settleFor: overrides?.settleFor ?? settleFor,
	};
	return { deps, settleEvents, armedWith };
}

const routes = {
	"agent list": ok('{"id":"cli:agent:list","result":{"agents":[]},"type":"agent_list"}'),
	"tab create": ok(fx("tab-create")),
	"agent start": ok('{"result":{"type":"ok"}}'),
	"agent prompt": ok('{"result":{"type":"ok"}}'),
	"tab close": ok('{"result":{"type":"ok"}}'),
};

const baseRecord: import("../src/registry.ts").DispatchRecord = {
	agent: "impl-x",
	taskId: "hd-1",
	topology: "tab",
	targetId: "w4:t4K",
	paneId: "w4:p4M",
	cwd: "/repo",
	keepOpen: false,
	createdAt: Date.now(),
	status: "live",
};

	describe("herdr_prompt", () => {
	it("agente desconocido: error que remite a herdr_agents", async () => {
		const { run } = fakeRun(routes);
		const { deps } = makeDeps({ run });
		await expect(promptAgent(deps, "fantasma", "sigue")).rejects.toThrow(/no encontrado.*herdr_agents/s);
	});

	it("record cerrado: error que sugiere nuevo dispatch", async () => {
		const { run } = fakeRun(routes);
		const registry = new Registry();
		const { deps } = makeDeps({ run, registry });
		registry.add({ ...baseRecord, agent: "viejo", status: "closed" });
		await expect(promptAgent(deps, "viejo", "sigue")).rejects.toThrow(/herdr_dispatch/);
	});

	it("agent_blocked: devuelve aviso de aprobación sin lanzar", async () => {
		const { run } = fakeRun({ ...routes, "agent prompt": { code: 1, stdout: "", stderr: "agent_blocked" } });
		const registry = new Registry();
		const { deps } = makeDeps({ run, registry });
		registry.add(baseRecord);
		const msg = await promptAgent(deps, "impl-x", "sigue");
		expect(msg).toMatch(/aprobaci/i);
	});

	it("submitted: OK sin re-armar watcher (arm no llamado)", async () => {
		const { run } = fakeRun(routes);
		const registry = new Registry();
		const { deps, armedWith } = makeDeps({ run, registry });
		registry.add(baseRecord);
		const msg = await promptAgent(deps, "impl-x", "segunda ronda");
		expect(msg).toMatch(/impl-x/);
		expect(armedWith).toHaveLength(0);
	});
});

describe("herdr_read", () => {
	it("passthrough de agentRead con lines default 200", async () => {
		const { run, calls } = fakeRun({ ...routes, "agent read": ok("texto del agente") });
		const { deps } = makeDeps({ run });
		const out = await readAgent(deps, "impl-x");
		expect(out).toBe("texto del agente");
		expect(calls[0].args).toEqual(["agent", "read", "impl-x", "--source", "recent-unwrapped", "--lines", "200"]);
	});
});

describe("dispatch — gates", () => {
	it("sin HERDR_ENV: throw ANTES de cualquier llamada herdr (cero side effects)", async () => {
		const { run, calls } = fakeRun(routes);
		const { deps } = makeDeps({ run });
		await expect(dispatch(deps, { task: "revisa el login" }, {})).rejects.toThrow(/herdr/i);
		expect(calls).toHaveLength(0);
	});

	it("task vacía: throw de validación sin tocar herdr", async () => {
		const { run, calls } = fakeRun(routes);
		const { deps } = makeDeps({ run });
		await expect(dispatch(deps, { task: "   " }, { HERDR_ENV: "1" })).rejects.toThrow(/task/i);
		expect(calls).toHaveLength(0);
	});

	it("name explicit colisionante: error sin crear tab", async () => {
		const { run, calls } = fakeRun({
			...routes,
			"agent list": ok('{"result":{"agents":[{"name":"ya-existe","agent_status":"idle","pane_id":"w1:p1"}]}}'),
		});
		const { deps } = makeDeps({ run });
		await expect(dispatch(deps, { task: "x", name: "ya-existe" }, { HERDR_ENV: "1" })).rejects.toThrow(/ya-existe-2/);
		expect(calls.filter((c) => c.args[1] === "create")).toHaveLength(0);
	});
});

describe("dispatch — worktree", () => {
	it("worktree true: crea rama+dir ANTES, tab arranca con cwd=worktree, record lleva worktree", async () => {
		const { run, calls } = fakeRun({
			...routes,
			"git -C": ok("/w/repo"),
		});
		// fakeRun enruta por 2 primeros args; git va como file=git → mock aparte:
		const gitCalls: { file: string; args: string[] }[] = [];
		const runBoth: import("../src/herdr.ts").RunFn = async (file, args, opts) => {
			if (file === "git") {
				gitCalls.push({ file, args });
			if (args.includes("rev-parse")) return ok("/w/repo");
			return ok("");
			}
			return run(file, args, opts);
		};
		const registry = new Registry();
		const { deps } = makeDeps({ run: runBoth, registry });
		const r = await dispatch(deps, { task: "revisa el login", worktree: true }, { HERDR_ENV: "1" });
		expect(r.worktreePath).toBe("/w/.hd-worktrees/" + r.agent);
		expect(gitCalls[0].args).toContain("rev-parse");
		expect(gitCalls.find((c) => c.args[2] === "worktree")!.args).toContain("-b");
		const tabCall = calls.find((c) => c.args[1] === "create")!;
		expect(tabCall.args[tabCall.args.indexOf("--cwd") + 1]).toBe(r.worktreePath);
		expect(registry.get(r.agent)!.worktree).toEqual({ dir: r.worktreePath!, branch: `hd/${r.agent}` });
	});

	it("worktree true en cwd no-git: error ANTES de crear topología", async () => {
		const { run, calls } = fakeRun(routes);
		const runBoth: import("../src/herdr.ts").RunFn = async (file, args, opts) => {
			if (file === "git") return { code: 128, stdout: "", stderr: "not a git repository" };
			return run(file, args, opts);
		};
		const { deps } = makeDeps({ run: runBoth });
		await expect(dispatch(deps, { task: "revisa", worktree: true }, { HERDR_ENV: "1" })).rejects.toThrow(/repo git/i);
		expect(calls.filter((c) => c.args[1] === "create")).toHaveLength(0);
	});
});

describe("dispatch — topologías", () => {
	it("pane: split derecha del actual, record target = paneId, args exactos", async () => {
		const { run, calls } = fakeRun({ ...routes, "pane split": ok(fx("pane-split")) });
		const registry = new Registry();
		const { deps } = makeDeps({ run, registry });
		const r = await dispatch(deps, { task: "revisa el login", topology: "pane" }, { HERDR_ENV: "1" });
		expect(r.paneId).toBe("w4:p5A");
		expect(calls.find((c) => c.args[1] === "split")!.args).toEqual([
			"pane",
			"split",
			"--current",
			"--direction",
			"right",
			"--cwd",
			"/repo",
		]);
		expect(registry.get(r.agent)).toMatchObject({ topology: "pane", targetId: "w4:p5A", paneId: "w4:p5A" });
	});

	it("workspace: create con label=name y --no-focus, record target = workspaceId", async () => {
		const { run, calls } = fakeRun({ ...routes, "workspace create": ok(fx("workspace-create")) });
		const registry = new Registry();
		const { deps } = makeDeps({ run, registry });
		const r = await dispatch(deps, { task: "revisa el login", topology: "workspace" }, { HERDR_ENV: "1" });
		expect(r.paneId).toBe("w5:p1");
		const wsCall = calls.find((c) => c.args[1] === "create")!;
		expect(wsCall.args).toContain("--no-focus");
		expect(wsCall.args[wsCall.args.indexOf("--label") + 1]).toBe(r.agent);
		expect(registry.get(r.agent)).toMatchObject({ topology: "workspace", targetId: "w5", paneId: "w5:p1" });
	});

	it("prompt falla en topology pane: rollback cierra el PANE (no un tab)", async () => {
		const { run, calls } = fakeRun({
			...routes,
			"pane split": ok(fx("pane-split")),
			"agent prompt": { code: 1, stdout: "", stderr: "boom" },
		});
		const { deps } = makeDeps({ run });
		await expect(dispatch(deps, { task: "revisa el login", topology: "pane" }, { HERDR_ENV: "1" })).rejects.toThrow(/boom/);
		expect(calls.filter((c) => c.args[1] === "close").map((c) => c.args)).toEqual([["pane", "close", "w4:p5A"]]);
	});
});

describe("dispatch — happy path tab", () => {
	it("secuencia completa: list→tab create (label=name, no-focus, cwd)→start(pi)→prompt(sin wait)→registry→arm", async () => {
		const { run, calls } = fakeRun(routes);
		const registry = new Registry();
		const { deps, armedWith } = makeDeps({ run, registry });
		const r = await dispatch(deps, { task: "Revisa el login del admin" }, { HERDR_ENV: "1" });

		expect(r.agent).toBe("revisa-login-admin");
		expect(r.paneId).toBe("w4:p4M");
		expect(r.taskId).toMatch(/^hd-/);
		expect(r.worktreePath).toBeUndefined();

		const promptCall = calls.find((c) => c.args[1] === "prompt")!;
		expect(promptCall.args).not.toContain("--wait");
		expect(promptCall.args).not.toContain("--until");
		expect(promptCall.args).toContain("Revisa el login del admin");

		const rec = registry.get("revisa-login-admin")!;
		expect(rec).toMatchObject({
			agent: "revisa-login-admin",
			topology: "tab",
			targetId: "w4:t4K",
			paneId: "w4:p4M",
			cwd: "/repo",
			keepOpen: false,
			status: "live",
		});
		expect(armedWith).toEqual(["revisa-login-admin"]);
	});

	it("cwd default viene de deps.cwd y viaja al tab create", async () => {
		const { run, calls } = fakeRun(routes);
		const { deps } = makeDeps({ run, cwd: "/otro/repo" });
		await dispatch(deps, { task: "revisa el login" }, { HERDR_ENV: "1" });
		const tabCall = calls.find((c) => c.args[1] === "create")!;
		expect(tabCall.args).toContain("/otro/repo");
	});

	it("kind configurable (default pi)", async () => {
		const { run, calls } = fakeRun(routes);
		const { deps } = makeDeps({ run });
		await dispatch(deps, { task: "revisa", kind: "claude" }, { HERDR_ENV: "1" });
		const startCall = calls.find((c) => c.args[1] === "start")!;
		expect(startCall.args).toContain("--kind");
		expect(startCall.args[startCall.args.indexOf("--kind") + 1]).toBe("claude");
	});

	it("prompt inicial devuelve agent_blocked: dispatch sigue (llega como evento)", async () => {
		const { run } = fakeRun({ ...routes, "agent prompt": { code: 1, stdout: "", stderr: "agent_blocked" } });
		const registry = new Registry();
		const { deps, armedWith } = makeDeps({ run, registry });
		const r = await dispatch(deps, { task: "revisa el login" }, { HERDR_ENV: "1" });
		expect(r.agent).toBe("revisa-login");
		expect(armedWith).toHaveLength(1);
		expect(registry.get("revisa-login")!.status).toBe("live");
	});

	it("prompt falla inesperado: cierra el tab creado, no registra y propaga", async () => {
		const { run, calls } = fakeRun({ ...routes, "agent prompt": { code: 1, stdout: "", stderr: "boom" } });
		const registry = new Registry();
		const { deps } = makeDeps({ run, registry });
		await expect(dispatch(deps, { task: "revisa el login" }, { HERDR_ENV: "1" })).rejects.toThrow(/boom/);
		const closes = calls.filter((c) => c.args[1] === "close");
		expect(closes.map((c) => c.args)).toEqual([["tab", "close", "w4:t4K"]]);
		expect(registry.list()).toHaveLength(0);
	});
});
