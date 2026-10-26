import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { armWatcher, type WatchEvent } from "../src/watch.ts";
import type { RunFn } from "../src/herdr.ts";

function waitJson(status: string): string {
	return JSON.stringify({ id: "cli:agent:wait", result: { agent: { name: "t", agent_status: status, pane_id: "w1:p1" } } });
}

/** spawnWait que emite la secuencia de estados indicada (un estado por ciclo de wait). */
function waitSeq(states: string[], spawnCount: { n: number }) {
	let i = 0;
	return (_name: string): ChildProcess => {
		spawnCount.n++;
		const s = states[Math.min(i, states.length - 1)];
		i++;
		return spawn("bash", ["-c", `sleep 0.05; echo '${waitJson(s)}'; exit 0`]);
	};
}

const readRun: RunFn = async (_file, args) => {
	if (args.slice(0, 2).join(" ") === "agent read") {
		return { code: 0, stdout: "salida final del agente", stderr: "" };
	}
	return { code: 1, stdout: "", stderr: "unmocked" };
};

/** Espera hasta que cond() sea true (máx 3s). */
async function waitFor(cond: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error(`timeout esperando: ${what}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}

function collector(flags: boolean[] | ((i: number) => boolean)) {
	const events: WatchEvent[] = [];
	const decisions: boolean[] = [];
	const onEvent = async (ev: WatchEvent): Promise<boolean> => {
		events.push(ev);
		const d = typeof flags === "function" ? flags(events.length - 1) : (flags[events.length - 1] ?? false);
		decisions.push(d);
		return d;
	};
	return { events, decisions, onEvent };
}

describe("armWatcher", () => {
	it("settle idle: un evento settled con output leído, sin re-arm si onEvent=false", async () => {
		const spawnCount = { n: 0 };
		const { events, onEvent } = collector([false]);
		armWatcher({ run: readRun, spawnWait: waitSeq(["idle"], spawnCount) }, "t", onEvent);
		await waitFor(() => events.length > 0, "primer evento");
		await new Promise((r) => setTimeout(r, 150));
		expect(events).toEqual([{ kind: "settled", state: "idle", output: "salida final del agente" }]);
		expect(spawnCount.n).toBe(1);
	});

	it("blocked re-arma: [blocked, settled] con dos ciclos de wait", async () => {
		const spawnCount = { n: 0 };
		const { events, onEvent } = collector([true, false]);
		armWatcher({ run: readRun, spawnWait: waitSeq(["blocked", "idle"], spawnCount) }, "t", onEvent);
		await waitFor(() => events.length >= 2, "blocked + settled");
		expect(events[0]).toEqual({ kind: "blocked" });
		expect(events[1]).toMatchObject({ kind: "settled", state: "idle" });
		expect(spawnCount.n).toBe(2);
	});

	it("done también es settle válido", async () => {
		const { events, onEvent } = collector([false]);
		armWatcher({ run: readRun, spawnWait: waitSeq(["done"], { n: 0 }) }, "t", onEvent);
		await waitFor(() => events.length > 0, "settled done");
		expect(events[0]).toMatchObject({ kind: "settled", state: "done" });
	});

	it("wait exit != 0 → gone con reason; nunca re-arma aunque onEvent=true", async () => {
		const spawnCount = { n: 0 };
		const { events, onEvent } = collector([true]);
		const spawnWait = (_n: string): ChildProcess => {
			spawnCount.n++;
			return spawn("bash", ["-c", "sleep 0.05; echo 'pane gone' >&2; exit 3"]);
		};
		armWatcher({ run: readRun, spawnWait }, "t", onEvent);
		await waitFor(() => events.length > 0, "gone");
		await new Promise((r) => setTimeout(r, 150));
		expect(events[0].kind).toBe("gone");
		expect((events[0] as { reason: string }).reason).toMatch(/3|pane gone/);
		expect(spawnCount.n).toBe(1);
	});

	it("estado desconocido en el JSON → gone", async () => {
		const { events, onEvent } = collector([true]);
		const spawnWait = (_n: string): ChildProcess =>
			spawn("bash", ["-c", `sleep 0.05; echo '${waitJson("working")}'; exit 0`]);
		armWatcher({ run: readRun, spawnWait }, "t", onEvent);
		await waitFor(() => events.length > 0, "gone working");
		expect(events[0].kind).toBe("gone");
	});

	it("stop() mata el wait en curso y no emite nada", async () => {
		const { events, onEvent } = collector([true]);
		const spawnWait = (_n: string): ChildProcess => spawn("bash", ["-c", "sleep 30"]);
		const handle = armWatcher({ run: readRun, spawnWait }, "t", onEvent);
		await new Promise((r) => setTimeout(r, 100));
		handle.stop();
		await new Promise((r) => setTimeout(r, 200));
		expect(events).toEqual([]);
	});

	it("settle con keepOpen (onEvent=true) re-arma via fase working", async () => {
		const spawnCount = { n: 0 };
		const settleStates = ["idle", "idle"];
		let settleIdx = 0;
		const spawnWait = (_n: string, phase?: "settle" | "working"): ChildProcess => {
			spawnCount.n++;
			const s = phase === "working" ? "working" : settleStates[Math.min(settleIdx++, settleStates.length - 1)]!;
			return spawn("bash", ["-c", `sleep 0.05; echo '${waitJson(s)}'; exit 0`]);
		};
		const { events, onEvent } = collector([true, false]);
		armWatcher({ run: readRun, spawnWait }, "t", onEvent);
		await waitFor(() => events.length >= 2, "dos settles");
		expect(spawnCount.n).toBe(3);
		expect(events.filter((e) => e.kind === "settled")).toHaveLength(2);
	});

	it("keepOpen tras settle: siguiente spawn es fase working (no bucle caliente) — issue #5", async () => {
		const phases: ("settle" | "working" | undefined)[] = [];
		let settleIdx = 0;
		const settleStates = ["idle", "idle"]; // settle 1 → working → settle 2
		const spawnWait = (_n: string, phase?: "settle" | "working"): ChildProcess => {
			phases.push(phase);
			if (phase === "working") {
				// wait --until working: bloquea hasta que el agente trabaja
				return spawn("bash", ["-c", `sleep 0.05; echo '${waitJson("working")}'; exit 0`]);
			}
			const s = settleStates[Math.min(settleIdx, settleStates.length - 1)]!;
			settleIdx++;
			return spawn("bash", ["-c", `sleep 0.05; echo '${waitJson(s)}'; exit 0`]);
		};
		const { events, onEvent } = collector([true, false]);
		armWatcher({ run: readRun, spawnWait }, "t", onEvent);
		await waitFor(() => events.length >= 2, "settle → working → settle");
		expect(events.map((e) => e.kind)).toEqual(["settled", "settled"]);
		expect(phases).toEqual(["settle", "working", "settle"]);
	});

	it("keepOpen con agente que NO vuelve a trabajar: cero eventos extra (anti hot-loop)", async () => {
		let spawns = 0;
		const spawnWait = (_n: string, phase?: "settle" | "working"): ChildProcess => {
			spawns++;
			if (phase === "working") return spawn("bash", ["-c", "sleep 30"]); // bloquea para siempre
			return spawn("bash", ["-c", `sleep 0.05; echo '${waitJson("done")}'; exit 0`]);
		};
		const { events, onEvent } = collector([true]);
		const handle = armWatcher({ run: readRun, spawnWait }, "t", onEvent);
		await waitFor(() => events.length > 0, "primer settle");
		await new Promise((r) => setTimeout(r, 250));
		expect(events).toHaveLength(1); // sin spam
		expect(spawns).toBe(2); // settle + working-wait bloqueado
		handle.stop();
	});
});
