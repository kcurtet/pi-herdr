import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import extension from "../index.ts";
import { formatGlobalList, scopeFrom, Watches, type GlobalAgent } from "../src/global.ts";
import type { WaitPhase } from "../src/watch.ts";
import { fakeRun, ok, waitFor } from "./helpers.ts";

const AGENTS: GlobalAgent[] = [
	{ agent: "pi", agent_status: "working", pane_id: "w1D:p1", cwd: "/home/u/dev/screeps", terminal_title_stripped: "π - screeps" },
	{ agent: "claude", agent_status: "idle", pane_id: "w23:p1", cwd: "/home/u/dev/jerga", focused: true },
	{ name: "trinity", agent: "pi", agent_status: "working", pane_id: "w23:p6", cwd: "/home/u" },
];
const listJson = JSON.stringify({ id: "cli:agent:list", result: { agents: AGENTS } });

function waitJson(status: string): string {
	return JSON.stringify({ id: "cli:agent:wait", result: { agent: { agent_status: status, pane_id: "w1D:p1" } } });
}

/** spawnWait falso: en fases arm/rearm el agente "trabaja"; en settle emite la secuencia. */
function waitSeq(states: string[], spawns: { n: number; targets: string[] }) {
	let i = 0;
	return (name: string, phase?: WaitPhase): ChildProcess => {
		spawns.n++;
		spawns.targets.push(name);
		const s = phase === "arm" || phase === "rearm" ? "working" : states[Math.min(i++, states.length - 1)]!;
		return spawn("bash", ["-c", `sleep 0.05; echo '${waitJson(s)}'; exit 0`]);
	};
}

const routes = {
	"agent list": ok(listJson),
	"agent read": ok("línea 1\nlínea 2\nTests en verde."),
};

describe("scopeFrom (D1)", () => {
	it("solo 'global' activa el modo global", () => {
		expect(scopeFrom({})).toBe("session");
		expect(scopeFrom({ PI_HERDR_SCOPE: "GLOBAL " })).toBe("global");
		expect(scopeFrom({ PI_HERDR_SCOPE: "todo" })).toBe("session");
	});
});

describe("formatGlobalList (A2)", () => {
	it("usa nombre si lo hay, si no pane_id; acorta el home; marca el enfocado", () => {
		const out = formatGlobalList(AGENTS, "/home/u");
		expect(out).toContain('- w1D:p1 · pi · working · ~/dev/screeps · "π - screeps"');
		expect(out).toContain("- w23:p1 · claude · idle · ~/dev/jerga · (enfocado)");
		expect(out).toContain("- trinity · pi · working · ~");
	});
	it("lista vacía", () => {
		expect(formatGlobalList([])).toBe("No hay agentes en herdr.");
	});
});

describe("Watches", () => {
	function setup(states: string[]) {
		const { run, calls } = fakeRun(routes);
		const spawns = { n: 0, targets: [] as string[] };
		const events: { content: string; details: Record<string, unknown> }[] = [];
		const watches = new Watches({ run, spawnWait: waitSeq(states, spawns), emit: (content, details) => events.push({ content, details }) });
		return { watches, events, calls, spawns };
	}

	it("A4: settled → un aviso con la salida, sin ningún close, y fin de la vigilancia", async () => {
		const { watches, events, calls, spawns } = setup(["idle"]);
		const msg = await watches.watch("w1D:p1");
		expect(msg).toContain("pi de screeps");
		await waitFor(() => events.length === 1, "evento settled");
		expect(events[0]!.content).toContain("pi de screeps ha terminado (idle)");
		expect(events[0]!.content).toContain("Tests en verde.");
		expect(spawns.targets.every((t) => t === "w1D:p1")).toBe(true);
		expect(calls.some((c) => c.args[1] === "close")).toBe(false);
		expect(watches.has("w1D:p1")).toBe(false);
	});

	it("A5: blocked avisa y sigue; el settle posterior termina (sin keep)", async () => {
		const { watches, events } = setup(["blocked", "done"]);
		await watches.watch("w1D:p1", { label: "el agente de screeps" });
		await waitFor(() => events.length === 2, "blocked + settled");
		expect(events[0]!.content).toBe("herdr: el agente de screeps está bloqueado esperando una decisión en su panel (w1D:p1).");
		expect(events[1]!.details.kind).toBe("settled");
		expect(watches.has("w1D:p1")).toBe(false);
	});

	it("keep:true sigue vigilando tras el settle", async () => {
		const { watches, events } = setup(["idle"]);
		await watches.watch("trinity", { keep: true });
		await waitFor(() => events.length >= 1, "primer settle");
		expect(watches.has("trinity")).toBe(true);
		watches.stopAll();
	});

	it("A7: objetivo inexistente → error claro, sin wait armado", async () => {
		const { watches, spawns } = setup(["idle"]);
		await expect(watches.watch("nadie")).rejects.toThrow(/no hay ningún agente "nadie"/);
		expect(spawns.n).toBe(0);
	});

	it("D7: vigilar dos veces el mismo objetivo es un no-op", async () => {
		const { run } = fakeRun(routes);
		let armed = 0;
		const watches = new Watches({
			run,
			spawnWait: () => spawn("bash", ["-c", "sleep 30"]),
			emit: () => {},
			arm: () => {
				armed++;
				return { stop() {} };
			},
		});
		await watches.watch("w23:p1");
		expect(await watches.watch("w23:p1")).toBe("Ya estaba vigilando w23:p1.");
		expect(armed).toBe(1);
	});

	it("A6: unwatch detiene; stopAll detiene todo", async () => {
		const { run } = fakeRun(routes);
		const stopped: string[] = [];
		const watches = new Watches({
			run,
			spawnWait: () => spawn("bash", ["-c", "sleep 30"]),
			emit: () => {},
			arm: (_d, name) => ({ stop: () => stopped.push(name) }),
		});
		await watches.watch("w1D:p1");
		await watches.watch("trinity");
		expect(watches.unwatch("w1D:p1")).toBe("Dejo de vigilar w1D:p1.");
		expect(watches.unwatch("w1D:p1")).toBe("No estaba vigilando w1D:p1.");
		watches.stopAll();
		expect(stopped).toEqual(["w1D:p1", "trinity"]);
		expect(watches.list()).toEqual([]);
	});

	it("D6: un agente sin nombre vivo por pane_id → stranded (no gone) si el wait falla", async () => {
		const { run } = fakeRun(routes);
		const events: { content: string; details: Record<string, unknown> }[] = [];
		const watches = new Watches({
			run,
			spawnWait: () => spawn("bash", ["-c", "echo boom >&2; exit 3"]),
			emit: (content, details) => events.push({ content, details }),
		});
		await watches.watch("w1D:p1");
		await waitFor(() => events.length === 1, "stranded");
		expect(events[0]!.details.kind).toBe("stranded");
		expect(events[0]!.content).toContain("ya no se puede vigilar");
	});
});

describe("index en modo global (A1/A2)", () => {
	type Tool = { name: string; description: string; execute?: (id: string, p: Record<string, unknown>) => Promise<{ content: { text: string }[] }> };
	function load(env: string | undefined) {
		const prev = process.env.PI_HERDR_SCOPE;
		if (env === undefined) delete process.env.PI_HERDR_SCOPE;
		else process.env.PI_HERDR_SCOPE = env;
		const tools: Tool[] = [];
		const api = {
			registerTool: (t: Tool) => tools.push(t),
			on: () => {},
			registerCommand: () => {},
			sendMessage: () => {},
			appendEntry: () => {},
		};
		try {
			const { run } = fakeRun({ ...routes });
			extension(api as never, { run });
		} finally {
			if (prev === undefined) delete process.env.PI_HERDR_SCOPE;
			else process.env.PI_HERDR_SCOPE = prev;
		}
		return tools;
	}

	it("A1: sin PI_HERDR_SCOPE no hay herdr_watch y herdr_agents describe solo despachos", () => {
		const tools = load(undefined);
		expect(tools.map((t) => t.name)).not.toContain("herdr_watch");
		expect(tools.find((t) => t.name === "herdr_agents")!.description).toContain("despachos de esta sesión");
	});

	it("A2: global registra watch/unwatch y herdr_agents incluye todos los agentes", async () => {
		const tools = load("global");
		expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["herdr_watch", "herdr_unwatch"]));
		const out = await tools.find((t) => t.name === "herdr_agents")!.execute!("1", {});
		expect(out.content[0]!.text).toContain("Todos los agentes de herdr:");
		expect(out.content[0]!.text).toContain("w1D:p1 · pi · working");
	});
});
