import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	agentGet,
	agentList,
	agentPrompt,
	agentRead,
	agentStart,
	assertHerdrEnv,
	closeTarget,
	type RunFn,
	tabCreate,
	paneSplitRight,
	workspaceCreate,
} from "../src/herdr.ts";

function fx(name: string): string {
	return readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8");
}

interface RecordedCall {
	file: string;
	args: string[];
	opts?: { cwd?: string; timeoutMs?: number };
}

/** Mock RunFn: routes by first two args (subcommand), records every call. */
function fakeRun(routes: Record<string, { code: number; stdout: string; stderr?: string }>) {
	const calls: RecordedCall[] = [];
	const run: RunFn = async (file, args, opts) => {
		calls.push({ file, args, opts });
		const key = args.slice(0, 2).join(" ");
		const r = routes[key];
		if (!r) return { code: 1, stdout: "", stderr: `unmocked: ${key}` };
		return { code: r.code, stdout: r.stdout, stderr: r.stderr ?? "" };
	};
	return { run, calls };
}

const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });

describe("assertHerdrEnv", () => {
	it("lanza sin HERDR_ENV", () => {
		expect(() => assertHerdrEnv({})).toThrow(/herdr/i);
	});
	it("pasa con HERDR_ENV=1", () => {
		expect(() => assertHerdrEnv({ HERDR_ENV: "1" })).not.toThrow();
	});
});

describe("tabCreate", () => {
	it("parsea root_pane.pane_id + tab.tab_id del JSON y manda --no-focus --label --cwd", async () => {
		const { run, calls } = fakeRun({ "tab create": ok(fx("tab-create")) });
		const r = await tabCreate(run, { cwd: "/repo", label: "impl-x" });
		expect(r).toEqual({ paneId: "w4:p4M", tabId: "w4:t4K", workspaceId: "w4" });
		expect(calls[0]).toEqual({
			file: "herdr",
			args: ["tab", "create", "--cwd", "/repo", "--label", "impl-x", "--no-focus"],
			opts: { timeoutMs: 15_000 },
		});
	});
});

describe("paneSplitRight", () => {
	it("parsea result.pane.pane_id; args exactos sin --no-focus (pane split no lo tiene)", async () => {
		const { run, calls } = fakeRun({ "pane split": ok(fx("pane-split")) });
		const r = await paneSplitRight(run, { cwd: "/repo" });
		expect(r).toEqual({ paneId: "w4:p5A" });
		expect(calls[0].args).toEqual(["pane", "split", "--current", "--direction", "right", "--cwd", "/repo"]);
	});
});

describe("workspaceCreate", () => {
	it("parsea root_pane.pane_id + workspace_id; --no-focus --label", async () => {
		const { run, calls } = fakeRun({ "workspace create": ok(fx("workspace-create")) });
		const r = await workspaceCreate(run, { cwd: "/repo", label: "ws-x" });
		expect(r).toEqual({ paneId: "w5:p1", workspaceId: "w5" });
		expect(calls[0].args).toEqual(["workspace", "create", "--cwd", "/repo", "--label", "ws-x", "--no-focus"]);
	});
});

describe("agentList / agentGet", () => {
	it("lista agentes; name ausente en agentes sin nombre", async () => {
		const { run } = fakeRun({ "agent list": ok(fx("agent-list")) });
		const agents = await agentList(run);
		expect(agents).toHaveLength(2);
		expect(agents[0]).toMatchObject({ name: "dash-patch", agent_status: "idle", pane_id: "w13:pY" });
		expect(agents[1].name).toBeUndefined();
	});
	it("get devuelve el agente con su estado", async () => {
		const { run, calls } = fakeRun({ "agent get": ok(fx("agent-get")) });
		const a = await agentGet(run, "dash-patch");
		expect(a).toMatchObject({ name: "dash-patch", agent_status: "idle" });
		expect(calls[0].args).toEqual(["agent", "get", "dash-patch"]);
	});
});

describe("agentStart", () => {
	it("args: agent start <name> --kind <kind> --pane <paneId>, timeout 120s", async () => {
		const { run, calls } = fakeRun({ "agent start": ok('{"result":{"type":"ok"}}') });
		await agentStart(run, { name: "impl-x", kind: "pi", paneId: "w4:p4M" });
		expect(calls[0]).toEqual({
			file: "herdr",
			args: ["agent", "start", "impl-x", "--kind", "pi", "--pane", "w4:p4M"],
			opts: { timeoutMs: 120_000 },
		});
	});
});

describe("agentPrompt", () => {
	it("sin --wait y sin --until; devuelve submitted", async () => {
		const { run, calls } = fakeRun({ "agent prompt": ok('{"result":{"type":"ok"}}') });
		const r = await agentPrompt(run, { name: "impl-x", text: "haz algo" });
		expect(r).toBe("submitted");
		const args = calls[0].args;
		expect(args).toContain("impl-x");
		expect(args).toContain("haz algo");
		expect(args).not.toContain("--wait");
		expect(args).not.toContain("--until");
	});
	it("devuelve blocked ante agent_blocked sin lanzar", async () => {
		const { run } = fakeRun({ "agent prompt": { code: 1, stdout: "", stderr: 'error: agent_blocked' } });
		const r = await agentPrompt(run, { name: "impl-x", text: "haz algo" });
		expect(r).toBe("blocked");
	});
});

describe("agentRead", () => {
	it("source recent-unwrapped y lines 200 por defecto", async () => {
		const { run, calls } = fakeRun({ "agent read": ok("salida del agente") });
		const out = await agentRead(run, { name: "impl-x" });
		expect(out).toBe("salida del agente");
		expect(calls[0].args).toEqual(["agent", "read", "impl-x", "--source", "recent-unwrapped", "--lines", "200"]);
	});
	it("lines configurable", async () => {
		const { run, calls } = fakeRun({ "agent read": ok("x") });
		await agentRead(run, { name: "impl-x", lines: 50 });
		expect(calls[0].args).toContain("50");
	});
});

describe("closeTarget", () => {
	it("tab/pane/workspace cierran con su subcomando", async () => {
		const { run, calls } = fakeRun({
			"tab close": ok('{"result":{"type":"ok"}}'),
			"pane close": ok('{"result":{"type":"ok"}}'),
			"workspace close": ok('{"result":{"type":"ok"}}'),
		});
		await closeTarget(run, { kind: "tab", id: "w4:t4K" });
		await closeTarget(run, { kind: "pane", id: "w4:p5A" });
		await closeTarget(run, { kind: "workspace", id: "w5" });
		expect(calls.map((c) => c.args)).toEqual([
			["tab", "close", "w4:t4K"],
			["pane", "close", "w4:p5A"],
			["workspace", "close", "w5"],
		]);
	});
});

describe("errores", () => {
	it("exit != 0 lanza Error con la salida del comando", async () => {
		const { run } = fakeRun({ "tab create": { code: 1, stdout: "boom", stderr: "invalid_label" } });
		await expect(tabCreate(run, { cwd: "/r", label: "x" })).rejects.toThrow(/boom|invalid_label/);
	});
});
