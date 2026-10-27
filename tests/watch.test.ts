import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { armWatcher, verifyAgentAlive, type WatchEvent, type WaitPhase } from "../src/watch.ts";
import { waitArgs } from "../src/dispatch.ts";
import type { RunFn } from "../src/herdr.ts";
import { fakeRun, fx, ok } from "./helpers.ts";

function waitJson(status: string): string {
	return JSON.stringify({ id: "cli:agent:wait", result: { agent: { name: "t", agent_status: status, pane_id: "w1:p1" } } });
}

/** spawnWait que emite la secuencia de estados indicada; en fases arm/rearm el turno "arranca" (issue #7). */
function waitSeq(states: string[], spawnCount: { n: number }) {
	let i = 0;
	return (_name: string, phase?: WaitPhase): ChildProcess => {
		spawnCount.n++;
		let s: string;
		if (phase === "arm" || phase === "rearm") {
			s = "working";
		} else {
			s = states[Math.min(i, states.length - 1)]!;
			i++;
		}
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

/** until-set que instant-matchea cada fase, derivado del propio waitArgs (fuente única de verdad).
 * settle/undefined → default herdr (idle|done|blocked). */
function untilSetOf(phase: WaitPhase | undefined): Set<string> {
	if (phase === undefined || phase === "settle") return new Set(["idle", "done", "blocked"]); // default herdr
	const args = waitArgs("t", phase);
	const set = new Set<string>();
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--until") set.add(args[i + 1]!);
	}
	// fidelidad con herdr: fase sin --until = default idle|done|blocked (rev #8 F1:
	// un until-set vacío haría pasar el spam como "bloqueo eterno" del fake)
	return set.size > 0 ? set : new Set(["idle", "done", "blocked"]);
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
		expect(spawnCount.n).toBe(2); // working (arranque) + settle
	});

	it("blocked re-arma: [blocked, settled] con dos ciclos de wait", async () => {
		const spawnCount = { n: 0 };
		const { events, onEvent } = collector([true, false]);
		armWatcher({ run: readRun, spawnWait: waitSeq(["blocked", "idle"], spawnCount) }, "t", onEvent);
		await waitFor(() => events.length >= 2, "blocked + settled");
		expect(events[0]).toEqual({ kind: "blocked" });
		expect(events[1]).toMatchObject({ kind: "settled", state: "idle" });
		expect(spawnCount.n).toBe(3); // working + settle(blocked) + rearmBlocked(idle)
	});

	it("done también es settle válido", async () => {
		const { events, onEvent } = collector([false]);
		armWatcher({ run: readRun, spawnWait: waitSeq(["done"], { n: 0 }) }, "t", onEvent);
		await waitFor(() => events.length > 0, "settled done");
		expect(events[0]).toMatchObject({ kind: "settled", state: "done" });
	});

	it("wait exit != 0 con agente AUSENTE (verifyAgent=false) → gone genuino: reason, sin re-arm aunque onEvent=true — pinning issue #14", async () => {
		const spawnCount = { n: 0 };
		const { events, onEvent } = collector([true]);
		const spawnWait = (_n: string): ChildProcess => {
			spawnCount.n++;
			return spawn("bash", ["-c", "sleep 0.05; echo 'pane gone' >&2; exit 3"]);
		};
		armWatcher({ run: readRun, spawnWait, verifyAgent: async () => false }, "t", onEvent);
		await waitFor(() => events.length > 0, "gone");
		await new Promise((r) => setTimeout(r, 150));
		expect(events[0].kind).toBe("gone");
		expect((events[0] as { reason: string }).reason).toMatch(/3|pane gone/);
		expect(spawnCount.n).toBe(1);
	});

	it("estado desconocido en el JSON → gone", async () => {
		const { events, onEvent } = collector([true]);
		const spawnWait = (_n: string): ChildProcess =>
			spawn("bash", ["-c", `sleep 0.05; echo '${waitJson("bogus")}'; exit 0`]);
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

	it("settle con keepOpen (onEvent=true) re-arma via fase rearm", async () => {
		const spawnCount = { n: 0 };
		const settleStates = ["idle", "idle"];
		let settleIdx = 0;
		const spawnWait = (_n: string, phase?: WaitPhase): ChildProcess => {
			spawnCount.n++;
			const s = phase === "arm" || phase === "rearm" ? "working" : settleStates[Math.min(settleIdx++, settleStates.length - 1)]!;
			return spawn("bash", ["-c", `sleep 0.05; echo '${waitJson(s)}'; exit 0`]);
		};
		const { events, onEvent } = collector([true, false]);
		armWatcher({ run: readRun, spawnWait }, "t", onEvent);
		await waitFor(() => events.length >= 2, "dos settles");
		expect(spawnCount.n).toBe(4); // working + settle + working + settle
		expect(events.filter((e) => e.kind === "settled")).toHaveLength(2);
	});

	it("keepOpen tras settle: siguiente spawn es fase rearm (no bucle caliente) — issue #5", async () => {
		const phases: (WaitPhase | undefined)[] = [];
		let settleIdx = 0;
		const settleStates = ["idle", "idle"]; // settle 1 → rearm → settle 2
		const spawnWait = (_n: string, phase?: WaitPhase): ChildProcess => {
			phases.push(phase);
			if (phase === "arm" || phase === "rearm") {
				// wait --until working/blocked: bloquea hasta que el agente trabaja (o bloquea)
				return spawn("bash", ["-c", `sleep 0.05; echo '${waitJson("working")}'; exit 0`]);
			}
			const s = settleStates[Math.min(settleIdx, settleStates.length - 1)]!;
			settleIdx++;
			return spawn("bash", ["-c", `sleep 0.05; echo '${waitJson(s)}'; exit 0`]);
		};
		const { events, onEvent } = collector([true, false]);
		armWatcher({ run: readRun, spawnWait }, "t", onEvent);
		await waitFor(() => events.length >= 2, "settle → rearm → settle");
		expect(events.map((e) => e.kind)).toEqual(["settled", "settled"]);
		expect(phases).toEqual(["arm", "settle", "rearm", "settle"]);
	});

	it("keepOpen con agente que NO vuelve a trabajar: cero eventos extra (anti hot-loop)", async () => {
		let spawns = 0;
		let nonSettleWaits = 0;
		const spawnWait = (_n: string, phase?: WaitPhase): ChildProcess => {
			spawns++;
			if (phase !== undefined && phase !== "settle") {
				nonSettleWaits++;
				if (nonSettleWaits === 1) {
					// arm inicial: el turno sí empieza
					return spawn("bash", ["-c", `sleep 0.05; echo '${waitJson("working")}'; exit 0`]);
				}
				return spawn("bash", ["-c", "sleep 30"]); // rearm: bloquea para siempre
			}
			return spawn("bash", ["-c", `sleep 0.05; echo '${waitJson("done")}'; exit 0`]);
		};
		const { events, onEvent } = collector([true]);
		const handle = armWatcher({ run: readRun, spawnWait }, "t", onEvent);
		await waitFor(() => events.length > 0, "primer settle");
		await new Promise((r) => setTimeout(r, 250));
		expect(events).toHaveLength(1); // sin spam
		expect(spawns).toBe(3); // arm + settle + rearm-wait bloqueado
		handle.stop();
	});

	it("arm inicial en fase arm: settle solo tras confirmar que el turno arrancó — issue #7", async () => {
		const phases: (WaitPhase | undefined)[] = [];
		const spawnWait = (_n: string, phase?: WaitPhase): ChildProcess => {
			phases.push(phase);
			const s = phase === "arm" || phase === "rearm" ? "working" : "idle";
			return spawn("bash", ["-c", `sleep 0.05; echo '${waitJson(s)}'; exit 0`]);
		};
		const { events, onEvent } = collector([false]);
		armWatcher({ run: readRun, spawnWait }, "t", onEvent);
		await waitFor(() => events.length > 0, "settled tras working");
		expect(phases[0]).toBe("arm");
		expect(events[0]).toMatchObject({ kind: "settled", state: "idle" });
	});

	it("fase arm con done inmediato → settled(done) sin colgarse — issue #7", async () => {
		const spawnWait = (_n: string, phase?: WaitPhase): ChildProcess =>
			spawn("bash", ["-c", `sleep 0.05; echo '${waitJson(phase === "arm" ? "done" : "idle")}'; exit 0`]);
		const { events, onEvent } = collector([false]);
		armWatcher({ run: readRun, spawnWait }, "t", onEvent);
		await waitFor(() => events.length > 0, "settled done");
		expect(events[0]).toMatchObject({ kind: "settled", state: "done" });
	});

	it("fase arm con blocked → evento blocked (aprobación temprana) — issue #7", async () => {
		const spawnWait = (_n: string, phase?: WaitPhase): ChildProcess =>
			spawn("bash", ["-c", `sleep 0.05; echo '${waitJson(phase === "arm" ? "blocked" : "idle")}'; exit 0`]);
		const { events, onEvent } = collector([false]);
		armWatcher({ run: readRun, spawnWait }, "t", onEvent);
		await waitFor(() => events.length > 0, "blocked");
		expect(events[0]).toEqual({ kind: "blocked" });
	});

	it("keepOpen con settled(done): el re-arm NO re-matchea done — sin flood (issue #7, finding 1)", async () => {
		// Fake con semántica level-triggered REAL: los estados que instant-matchea
		// cada fase se derivan del propio waitArgs (fuente única de verdad).
		const status = "done"; // agente terminado; done persistente en herdr
		let spawns = 0;
		const spawnWait = (_n: string, phase?: WaitPhase): ChildProcess => {
			spawns++;
			return untilSetOf(phase).has(status)
				? spawn("bash", ["-c", `sleep 0.05; echo '${waitJson(status)}'; exit 0`])
				: spawn("bash", ["-c", "sleep 30"]); // estado actual fuera del until-set: bloquea
		};
		const { events, onEvent } = collector([true]); // keepOpen en cada settle
		const handle = armWatcher({ run: readRun, spawnWait }, "t", onEvent);
		await waitFor(() => events.length > 0, "settled done inicial");
		await new Promise((r) => setTimeout(r, 250));
		expect(events).toHaveLength(1); // sin flood de eventos
		expect(spawns).toBe(2); // arm (done matchea) + rearm bloqueado (done FUERA del set)
		handle.stop();
	});

	it("blocked persistente con re-arm: UN solo evento blocked, sin spam — issue #8", async () => {
		// Fake level-triggered (hasta-sets derivados de waitArgs): el agente sigue
		// blocked mientras el humano decide. Hoy el re-arm tras blocked va a settle
		// (default idle|done|blocked) → instant-matchea blocked → spam infinito.
		const status = "blocked";
		let spawns = 0;
		const spawnWait = (_n: string, phase?: WaitPhase): ChildProcess => {
			spawns++;
			return untilSetOf(phase).has(status)
				? spawn("bash", ["-c", `sleep 0.05; echo '${waitJson(status)}'; exit 0`])
				: spawn("bash", ["-c", "sleep 30"]); // estado actual fuera del until-set: bloquea
		};
		const { events, onEvent } = collector([true]); // re-arm tras blocked
		const handle = armWatcher({ run: readRun, spawnWait }, "t", onEvent);
		await waitFor(() => events.length > 0, "blocked inicial");
		await new Promise((r) => setTimeout(r, 250));
		expect(events).toEqual([{ kind: "blocked" }]); // exactamente 1, sin spam
		expect(spawns).toBe(2); // arm (blocked ∈ set de arm) + espera de cambio bloqueada
		handle.stop();
	});

	it("blocked → humano aprueba (working) → watcher sigue al settle normal → settled — issue #8", async () => {
		const phases: (WaitPhase | undefined)[] = [];
		let status = "blocked"; // bloqueado desde antes del arm (aprobación temprana)
		let spawns = 0;
		const spawnWait = (_n: string, phase?: WaitPhase): ChildProcess => {
			phases.push(phase);
			spawns++;
			if (!untilSetOf(phase).has(status)) return spawn("bash", ["-c", "sleep 30"]); // bloquea
			const s = status;
			if (spawns === 2 && s === "working") status = "idle"; // aprobado: el agente corre y termina
			return spawn("bash", ["-c", `sleep 0.05; echo '${waitJson(s)}'; exit 0`]);
		};
		const events: WatchEvent[] = [];
		const onEvent = async (ev: WatchEvent): Promise<boolean> => {
			events.push(ev);
			if (ev.kind === "blocked") {
				status = "working"; // el humano aprueba en el pane
				return true; // re-arm
			}
			return false;
		};
		armWatcher({ run: readRun, spawnWait }, "t", onEvent);
		await waitFor(() => events.length >= 2, "blocked + settled");
		expect(events[0]).toEqual({ kind: "blocked" });
		expect(events[1]).toMatchObject({ kind: "settled", state: "idle", output: "salida final del agente" });
		expect(phases).toEqual(["arm", "rearmBlocked", "settle"]);
		expect(spawns).toBe(3);
	});
});

describe("armWatcher — fallo del wait: verificación de vida antes de declarar gone (issue #14)", () => {
	it("wait exit ≠ 0 con agente VIVO (verifyAgent=true): stranded con guía herdr_stop, verificado UNA vez, sin re-arm", async () => {
		const spawnCount = { n: 0 };
		const verifications: string[] = [];
		const spawnWait = (_n: string): ChildProcess => {
			spawnCount.n++;
			return spawn("bash", ["-c", "sleep 0.05; echo 'herdr: server unreachable' >&2; exit 3"]);
		};
		const { events, onEvent } = collector([true]); // true: stranded tampoco re-armaría aunque onEvent lo pidiera
		armWatcher(
			{ run: readRun, spawnWait, verifyAgent: async (n) => { verifications.push(n); return true; } },
			"t",
			onEvent,
		);
		await waitFor(() => events.length > 0, "stranded");
		await new Promise((r) => setTimeout(r, 150));
		expect(events).toHaveLength(1);
		expect(events[0].kind).toBe("stranded");
		const reason = (events[0] as { reason: string }).reason;
		expect(reason).toMatch(/SIGUE vivo/);
		expect(reason).toMatch(/herdr_stop/);
		expect(reason).toMatch(/server unreachable/);
		expect(verifications).toEqual(["t"]); // una sola verificación, con el nombre del agente
		expect(spawnCount.n).toBe(1); // watcher detenido: sin re-arm
	});

	it("spawn error del wait con agente VIVO: UN stranded (el close posterior no duplica) — issue #14", async () => {
		const spawnCount = { n: 0 };
		const spawnWait = (_n: string): ChildProcess => {
			spawnCount.n++;
			// binario inexistente: 'error' (ENOENT) y luego 'close' con code null
			return spawn("pi-herdr-binario-que-no-existe", []);
		};
		const { events, onEvent } = collector([true]);
		armWatcher({ run: readRun, spawnWait, verifyAgent: async () => true }, "t", onEvent);
		await waitFor(() => events.length > 0, "stranded tras spawn error");
		await new Promise((r) => setTimeout(r, 150));
		expect(events).toHaveLength(1); // el close (null) tras el error NO genera un segundo evento
		const ev = events[0] as { kind: string; reason: string };
		expect(ev.kind).toBe("stranded");
		expect(ev.reason).toMatch(/spawn error/);
		expect(ev.reason).toMatch(/SIGUE vivo/);
		expect(ev.reason).toMatch(/herdr_stop/);
		expect(spawnCount.n).toBe(1);
	});

	it("verificación imposible (agentList TAMBIÉN caído): stranded conservador, NO gone — issue #14", async () => {
		const spawnWait = (_n: string): ChildProcess => spawn("bash", ["-c", "sleep 0.05; exit 3"]);
		const { events, onEvent } = collector([false]);
		armWatcher(
			{ run: readRun, spawnWait, verifyAgent: async () => { throw new Error("herdr agent list falló (exit 1): server unreachable"); } },
			"t",
			onEvent,
		);
		await waitFor(() => events.length > 0, "stranded sin verificación");
		expect(events[0].kind).toBe("stranded");
		const reason = (events[0] as { reason: string }).reason;
		expect(reason).toMatch(/no se pudo verificar|server unreachable/);
		expect(reason).toMatch(/herdr_stop/);
	});
});

describe("verifyAgentAlive — default real vía agentList (issue #14)", () => {
	it("busca por nombre en la lista: presente → true, ausente → false", async () => {
		const { run } = fakeRun({ "agent list": ok(fx("agent-list")) });
		await expect(verifyAgentAlive(run, "dash-patch")).resolves.toBe(true);
		await expect(verifyAgentAlive(run, "no-esta")).resolves.toBe(false);
	});

	it("herdr caído → rechaza (el watcher lo trata como no verificable)", async () => {
		const { run } = fakeRun({ "agent list": { code: 1, stdout: "", stderr: "server unreachable" } });
		await expect(verifyAgentAlive(run, "x")).rejects.toThrow(/server unreachable/);
	});
});
