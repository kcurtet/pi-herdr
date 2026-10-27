import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { Registry, shutdownCleanup, stopAgent, stopDispatch, type DispatchRecord } from "../src/registry.ts";
import extension from "../index.ts";
import { fakeRun, fx, ok } from "./helpers.ts";

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

const closeRoutes = {
	"tab close": ok('{"result":{"type":"ok"}}'),
	"pane close": ok('{"result":{"type":"ok"}}'),
	"workspace close": ok('{"result":{"type":"ok"}}'),
};

const dispatchRoutes = {
	"agent list": ok('{"id":"x","result":{"agents":[]},"type":"agent_list"}'),
	"tab create": ok(fx("tab-create")),
	"agent start": ok('{"result":{"type":"ok"}}'),
	"agent prompt": ok('{"result":{"type":"ok"}}'),
};

const noCleanup = async () => ({ removed: true }) as const;

describe("shutdownCleanup", () => {
	it("cierra todos los live (con worktree cleanup) y los marca closed", async () => {
		const { run, calls } = fakeRun(closeRoutes);
		const registry = new Registry();
		registry.add(rec());
		registry.add(rec({ agent: "dos", topology: "pane", targetId: "w4:p5A", worktree: { repo: "/r", dir: "/d", branch: "hd/dos" } }));
		const cleanups: string[] = [];
		await shutdownCleanup({
			run,
			registry,
			cleanupWorktree: async (_r, o) => {
				cleanups.push(o.branch);
				return { removed: true };
			},
		});
		expect(calls.map((c) => c.args)).toEqual([
			["tab", "close", "w4:t4K"],
			["pane", "close", "w4:p5A"],
		]);
		expect(cleanups).toEqual(["hd/dos"]);
		expect(registry.list().every((r) => r.status === "closed")).toBe(true);
	});

	it("segunda pasada: CERO llamadas (idempotente)", async () => {
		const { run, calls } = fakeRun(closeRoutes);
		const registry = new Registry();
		registry.add(rec());
		const cleanup = async () => ({ removed: true }) as const;
		await shutdownCleanup({ run, registry, cleanupWorktree: cleanup });
		const after = calls.length;
		await shutdownCleanup({ run, registry, cleanupWorktree: cleanup });
		expect(calls.length).toBe(after);
	});

	it("close que falla: sigue con los demás sin lanzar", async () => {
		const { run, calls } = fakeRun({ ...closeRoutes, "tab close": { code: 1, stdout: "", stderr: "gone" } });
		const registry = new Registry();
		registry.add(rec());
		registry.add(rec({ agent: "dos", topology: "workspace", targetId: "w5" }));
		await shutdownCleanup({ run, registry, cleanupWorktree: noCleanup });
		expect(calls.map((c) => c.args)).toEqual([
			["tab", "close", "w4:t4K"], // intentado, falla, no lanza
			["workspace", "close", "w5"],
		]);
		expect(registry.list().every((r) => r.status === "closed")).toBe(true);
	});
});

describe("stopAgent (herdr_stop)", () => {
	it("live: cleanup worktree + close + markClosed", async () => {
		const { run, calls } = fakeRun(closeRoutes);
		const registry = new Registry();
		registry.add(rec({ worktree: { repo: "/r", dir: "/d", branch: "hd/impl-x" } }));
		const cleanups: string[] = [];
		const msg = await stopAgent(
			{ run, registry, cleanupWorktree: async (_r, o) => { cleanups.push(o.dir); return { removed: true }; } },
			"impl-x",
		);
		expect(cleanups).toEqual(["/d"]);
		expect(calls[0].args).toEqual(["tab", "close", "w4:t4K"]);
		expect(registry.get("impl-x")!.status).toBe("closed");
		expect(msg).toMatch(/detenido y tab cerrado/);
	});

	it("close fallido: el mensaje NO afirma 'cerrado' y reporta el error del close (issue #9)", async () => {
		const { run, calls } = fakeRun({ ...closeRoutes, "tab close": { code: 1, stdout: "", stderr: "close-boom" } });
		const registry = new Registry();
		registry.add(rec());
		const msg = await stopAgent({ run, registry, cleanupWorktree: noCleanup }, "impl-x");
		expect(calls.map((c) => c.args)).toEqual([["tab", "close", "w4:t4K"]]); // close intentado igual
		expect(registry.get("impl-x")!.status).toBe("closed"); // record cerrado (idempotencia)
		expect(msg).toMatch(/impl-x/);
		expect(msg).toMatch(/detenido/);
		expect(msg).not.toMatch(/cerrado/);
		expect(msg).toMatch(/close-boom/);
	});

	it("desconocido o ya cerrado: error claro", async () => {
		const { run } = fakeRun(closeRoutes);
		const registry = new Registry();
		await expect(stopAgent({ run, registry, cleanupWorktree: noCleanup }, "nada")).rejects.toThrow(/no encontrado/);
		registry.add(rec());
		registry.markClosed("impl-x");
		await expect(stopAgent({ run, registry, cleanupWorktree: noCleanup }, "impl-x")).rejects.toThrow(/cerrado/);
	});
});

describe("stopDispatch (herdr_stop wiring)", () => {
	it("para el watcher ANTES de cerrar, con el mismo registro de despacho", async () => {
		const order: string[] = [];
		const watchers = new Map<string, { stop(): void }>();
		watchers.set("impl-x", { stop() { order.push("watcher"); } });
		const registry = new Registry();
		registry.add(rec());
		const run: import("../src/herdr.ts").RunFn = async (_f, args) => {
			if (args[1] === "close") { order.push("close"); return { code: 0, stdout: "{\"result\":{\"type\":\"ok\"}}", stderr: "" }; }
			return { code: 1, stdout: "", stderr: "unmocked" };
		};
		const msg = await stopDispatch({ run, registry, cleanupWorktree: noCleanup, watchers }, "impl-x");
		expect(order).toEqual(["watcher", "close"]);
		expect(registry.get("impl-x")!.status).toBe("closed");
		expect(msg).toMatch(/impl-x/);
	});
});

describe("factory de la extensión", () => {
	/** ChildProcess inerte para spawnWait: sin stdout/stderr, nunca emite —
	 * el watcher queda armado sin tocar herdr real. */
	const idleChild = (): ChildProcess => ({ on() {}, kill() {} }) as unknown as ChildProcess;

	/** execute de herdr_dispatch pasa process.env: HERDR_ENV=1 solo durante el test. */
	async function withHerdrEnv(fn: () => Promise<void> | void): Promise<void> {
		const prev = process.env.HERDR_ENV;
		process.env.HERDR_ENV = "1";
		try {
			await fn();
		} finally {
			if (prev === undefined) delete process.env.HERDR_ENV;
			else process.env.HERDR_ENV = prev;
		}
	}

	type ToolReg = {
		name: string;
		parameters: Record<string, unknown>;
		execute?: (id: string, params: Record<string, unknown>) => Promise<{
			content: { type: string; text: string }[];
			details?: Record<string, unknown>;
		}>;
	};

	function fakeApi(opts: { sendMessageThrows?: boolean } = {}) {
		const tools: ToolReg[] = [];
		const handlers: { event: string; fn: (event: unknown, ctx: unknown) => Promise<void> | void }[] = [];
		const commands: { name: string; description: string; handler: unknown; getArgumentCompletions?: (p: string) => unknown }[] = [];
		const messages: { msg: Record<string, unknown>; opts?: unknown }[] = [];
		return {
			api: {
				registerTool: (t: ToolReg) => tools.push(t),
				on: (event: string, fn: (event: unknown, ctx: unknown) => Promise<void> | void) => handlers.push({ event, fn }),
				registerCommand: (name: string, def: { description: string; handler: unknown; getArgumentCompletions?: (p: string) => unknown }) =>
					commands.push({ name, ...def }),
				sendMessage: opts.sendMessageThrows
					? () => {
							throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
						}
					: (msg: Record<string, unknown>, o?: unknown) => {
							messages.push({ msg, opts: o });
						},
				appendEntry: () => {},
			},
			tools,
			handlers,
			commands,
			messages,
		};
	}

	it("registra las 5 tools y los handlers de sesión", () => {
		const { api, tools, handlers } = fakeApi();
		extension(api as never);
		expect(tools.map((t) => t.name).sort()).toEqual([
			"herdr_agents",
			"herdr_dispatch",
			"herdr_prompt",
			"herdr_read",
			"herdr_stop",
		]);
		expect(handlers.map((h) => h.event)).toContain("session_start");
		expect(handlers.map((h) => h.event)).toContain("session_shutdown");
	});

	/** PI_HOME aislado con config opcional de pi-herdr; restaura todo al salir. */
	async function withIsolatedPiHome(config: string | null, fn: () => Promise<void> | void): Promise<void> {
		const prev = process.env.PI_HOME;
		const home = mkdtempSync(join(tmpdir(), "pi-herdr-test-"));
		if (config !== null) {
			mkdirSync(join(home, "extensions-config"), { recursive: true });
			writeFileSync(join(home, "extensions-config", "pi-herdr.json"), config);
		}
		process.env.PI_HOME = home;
		try {
			await fn();
		} finally {
			if (prev === undefined) delete process.env.PI_HOME;
			else process.env.PI_HOME = prev;
			rmSync(home, { recursive: true, force: true });
		}
	}

	it("config con warnings NO tumba la carga: sendMessage jamás durante load (rev issue #4, F1)", async () => {
		await withIsolatedPiHome("{ json roto", () => {
			const { api } = fakeApi({ sendMessageThrows: true });
			expect(() => extension(api as never)).not.toThrow();
		});
	});

	it("session_start: config con warnings → UN herdr-config-warning tras cargar, cero durante la carga", async () => {
		await withIsolatedPiHome(JSON.stringify({ defaults: { topology: "matrix" } }), async () => {
			const { api, handlers, messages } = fakeApi();
			extension(api as never);
			expect(messages).toEqual([]); // nada durante la carga
			const starts = handlers.filter((h) => h.event === "session_start");
			expect(starts.length).toBeGreaterThan(0);
			for (const h of starts) await h.fn(undefined, { sessionManager: { getBranch: () => [] } });
			const warnings = messages.filter((m) => m.msg.customType === "herdr-config-warning");
			expect(warnings).toHaveLength(1);
			expect(warnings[0]!.msg.display).toBe(true);
			expect(warnings[0]!.opts).toBeUndefined(); // sin triggerTurn
		});
	});

	it("session_start: config sano → cero warnings", async () => {
		await withIsolatedPiHome(JSON.stringify({ defaults: { topology: "pane" } }), async () => {
			const { api, handlers, messages } = fakeApi();
			extension(api as never);
			for (const h of handlers.filter((x) => x.event === "session_start")) {
				await h.fn(undefined, { sessionManager: { getBranch: () => [] } });
			}
			expect(messages.filter((m) => m.msg.customType === "herdr-config-warning")).toHaveLength(0);
		});
	});

	it("schema de herdr_dispatch: task requerida, topology enum tab|pane|workspace, skills/extensions unión bool|array", () => {
		const { api, tools } = fakeApi();
		extension(api as never);
		const t = tools.find((x) => x.name === "herdr_dispatch")!;
		const props = (t.parameters as { properties: Record<string, { type?: string; anyOf?: { const?: string; type?: string }[]; optional?: boolean }> }).properties;
		expect(props.task?.type).toBe("string");
		expect(props.topology?.anyOf?.map((a) => a.const)).toEqual(["tab", "pane", "workspace"]);
		const boolOrArray = (p: unknown): boolean => {
			const anyOf = (p as { anyOf?: { type?: string }[] }).anyOf;
			const types = (anyOf ?? []).map((x) => x.type).sort();
			return types.join(",") === "array,boolean";
		};
		expect(boolOrArray(props.skills)).toBe(true);
		expect(boolOrArray(props.extensions)).toBe(true);
		const required = (t.parameters as { required?: string[] }).required;
		expect(required).toContain("task");
	});

	describe("session_start — reconcile tras resume (I4, issue #13)", () => {
		const liveEntry = {
			type: "custom",
			customType: "herdr-dispatch-record",
			data: {
				agent: "impl-x",
				taskId: "hd-1",
				topology: "tab",
				targetId: "w4:t4K",
				paneId: "w4:p4M",
				cwd: "/repo",
				keepOpen: false,
				createdAt: 1,
				status: "live",
			},
		};

		async function runStarts(handlers: ReturnType<typeof fakeApi>["handlers"], branch: unknown, ctx?: unknown): Promise<void> {
			for (const h of handlers.filter((x) => x.event === "session_start")) {
				await h.fn(undefined, ctx ?? { sessionManager: { getBranch: () => branch } });
			}
		}

		it("entries live restaurados + herdr caído (agent list falla) → warning visible herdr-reconcile-warning, records live SIN watcher", async () => {
			await withIsolatedPiHome(JSON.stringify({ defaults: { topology: "pane" } }), async () => {
				const { api, tools, handlers, messages } = fakeApi();
				const { run } = fakeRun({ "agent list": { code: 1, stdout: "", stderr: "herdr caído" } });
				let spawns = 0;
				extension(api as never, {
					run,
					spawnWait: () => {
					spawns++;
					return idleChild();
				},
					getConfig: () => ({}),
				});
				await runStarts(handlers, [liveEntry]);
				const warnings = messages.filter((m) => m.msg.customType === "herdr-reconcile-warning");
				expect(warnings).toHaveLength(1);
				expect(warnings[0]!.msg.display).toBe(true);
				expect(warnings[0]!.opts).toBeUndefined(); // sin triggerTurn
				expect(String(warnings[0]!.msg.content)).toMatch(/no se pudo re-armar/);
				expect(String(warnings[0]!.msg.content)).toMatch(/impl-x/);
				expect(String(warnings[0]!.msg.content)).toMatch(/herdr caído/);
				// nada re-armado, ningún evento de settle
				expect(messages.filter((m) => m.msg.customType === "herdr-dispatch-event")).toHaveLength(0);
				expect(spawns).toBe(0);
				// los records siguen live y visibles
				const t = tools.find((x) => x.name === "herdr_agents")!;
				const out = await t.execute!("a", {});
				expect(out.content[0]!.text).toContain("impl-x");
				expect(out.content[0]!.text).toContain("live");
			});
		});

		it("sin entries (getBranch lanza / rama vacía) + herdr caído: silencio total — pinning", async () => {
			await withIsolatedPiHome(JSON.stringify({ defaults: { topology: "pane" } }), async () => {
				const { api, handlers, messages } = fakeApi();
				const { run } = fakeRun({ "agent list": { code: 1, stdout: "", stderr: "x" } });
				extension(api as never, { run, spawnWait: idleChild, getConfig: () => ({}) });
				await runStarts(handlers, [], { sessionManager: undefined }); // getBranch lanza TypeError
				await runStarts(handlers, []); // rama sin entries: reconcile ni se llama
				expect(messages).toHaveLength(0);
			});
		});

		it("entries live + herdr vivo → evento de re-arm con triggerTurn y SIN warning — pinning happy path", async () => {
			await withIsolatedPiHome(JSON.stringify({ defaults: { topology: "pane" } }), async () => {
				const { api, handlers, messages } = fakeApi();
				const { run } = fakeRun({
					"agent list": ok('{"result":{"agents":[{"name":"impl-x","agent_status":"working","pane_id":"w4:p4M"}]}}'),
				});
				extension(api as never, { run, spawnWait: idleChild, getConfig: () => ({}) });
				await runStarts(handlers, [liveEntry]);
				const evs = messages.filter((m) => m.msg.customType === "herdr-dispatch-event");
				expect(evs).toHaveLength(1);
				expect(String(evs[0]!.msg.content)).toMatch(/re-armada/);
				expect(evs[0]!.opts).toEqual({ triggerTurn: true });
				expect(messages.filter((m) => m.msg.customType === "herdr-reconcile-warning")).toHaveLength(0);
			});
		});
	});

	describe("herdr_dispatch — wiring del content (issue #9)", () => {
		it("prompt inicial agent_blocked: el CONTENT de la tool menciona blocked", async () => {
			await withHerdrEnv(async () => {
				const { api, tools } = fakeApi();
				const { run } = fakeRun({
					...dispatchRoutes,
					"agent prompt": { code: 1, stdout: "", stderr: "agent_blocked" },
				});
				extension(api as never, { run, spawnWait: idleChild, getConfig: () => ({}) });
				const t = tools.find((x) => x.name === "herdr_dispatch")!;
				const out = await t.execute!("c1", { task: "revisa el login" });
				const text = out.content[0]!.text;
				expect(text).toMatch(/Despachado revisa-login/);
				expect(text).toMatch(/blocked/);
				expect(out.details).toMatchObject({ agent: "revisa-login", initialBlocked: true });
			});
		});

		it("prompt inicial submitted: content normal, SIN mención a blocked/aprobación", async () => {
			await withHerdrEnv(async () => {
				const { api, tools } = fakeApi();
				const { run } = fakeRun(dispatchRoutes);
				extension(api as never, { run, spawnWait: idleChild, getConfig: () => ({}) });
				const t = tools.find((x) => x.name === "herdr_dispatch")!;
				const out = await t.execute!("c1", { task: "revisa el login" });
				const text = out.content[0]!.text;
				expect(text).toMatch(/Despachado revisa-login/);
				expect(text).not.toMatch(/blocked|aprobaci/i);
			});
		});
	});

	it("registra el comando /herdr con autocompletado", () => {
		const { api, commands } = fakeApi();
		extension(api as never);
		const cmd = commands.find((c) => c.name === "herdr");
		expect(cmd).toBeDefined();
		const completions = cmd!.getArgumentCompletions;
		expect(typeof completions).toBe("function");
		const items = (completions!("conf") ?? []) as { value: string }[];
		expect(items.map((i) => i.value)).toEqual(["config "]);
	});
});
