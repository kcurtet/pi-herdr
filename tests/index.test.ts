import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { Registry, shutdownCleanup, stopAgent, stopDispatch, type DispatchRecord } from "../src/registry.ts";
import type { WatchHandle } from "../src/watch.ts";
import extension from "../index.ts";
import { fakeRun, fx, ok, waitFor } from "./helpers.ts";

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
		const watchers = new Map<string, WatchHandle>();
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

	it("borra el handle del map: el watcher parado no queda huérfano (issue #17)", async () => {
		let stopped = 0;
		const watchers = new Map<string, WatchHandle>();
		watchers.set("impl-x", { stop() { stopped++; } });
		const registry = new Registry();
		registry.add(rec());
		const { run } = fakeRun(closeRoutes);
		const msg = await stopDispatch({ run, registry, cleanupWorktree: noCleanup, watchers }, "impl-x");
		expect(stopped).toBe(1);
		expect(watchers.has("impl-x")).toBe(false);
		expect(msg).toMatch(/detenido y tab cerrado/);
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

	it("schema de herdr_prompt: interrupt opcional boolean (spec 006 D2)", () => {
		const { api, tools } = fakeApi();
		extension(api as never);
		const t = tools.find((x) => x.name === "herdr_prompt")!;
		const props = (t.parameters as { properties: Record<string, { type?: string }>; required?: string[] }).properties;
		expect(props.interrupt?.type).toBe("boolean");
		expect(props.agent?.type).toBe("string");
		expect(props.text?.type).toBe("string");
		expect((t.parameters as { required?: string[] }).required).toEqual(["agent", "text"]);
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

	describe("herdr_dispatch — wiring del settle vía watcher real (M5, issue #13)", () => {
		/** ChildProcess falso con EventEmitters reales: el test dispara stdout/close
		 * para llevar al watcher REAL (armWatcher) hasta el evento settled. */
		function controllableChild(): ChildProcess {
			const c = new EventEmitter() as unknown as Record<string, unknown>;
			c.kill = () => {};
			c.stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
			c.stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });
			return c as unknown as ChildProcess;
		}

		it("dispatch → settle definitivo: el evento settled llega con output, close del target y record closed", async () => {
			await withHerdrEnv(async () => {
				await withIsolatedPiHome(JSON.stringify({ defaults: { topology: "pane" } }), async () => {
					const { api, tools, handlers, messages } = fakeApi();
					const { run, calls } = fakeRun({
						...dispatchRoutes,
						"agent read": ok("salida final del agente"),
						...closeRoutes,
						});
					const children: ChildProcess[] = [];
					extension(api as never, {
						run,
						spawnWait: () => {
							const c = controllableChild();
							children.push(c);
							return c;
						},
						getConfig: () => ({}),
					});
					// sin entries en la rama: el session_start de reconcile no mete ruido
					for (const h of handlers.filter((x) => x.event === "session_start")) {
						await h.fn(undefined, { sessionManager: { getBranch: () => [] } });
						}
					const t = tools.find((x) => x.name === "herdr_dispatch")!;
					await t.execute!("c1", { task: "revisa el login" });
					expect(children).toHaveLength(1); // armado en fase arm
					const child = children[0] as unknown as { stdout: EventEmitter; emit(e: string, ...a: unknown[]): void };
					// agente ultra-rápido: done ya en fase arm
					child.stdout.emit("data", JSON.stringify({ result: { agent: { agent_status: "done" } } }));
					child.emit("close", 0);
					await waitFor(() => messages.some((m) => m.msg.customType === "herdr-dispatch-event"), "evento settled");
					const ev = messages.find((m) => m.msg.customType === "herdr-dispatch-event")!;
					expect(String(ev.msg.content)).toMatch(/settled \(done\)/);
					expect(String(ev.msg.content)).toMatch(/salida final del agente/);
					expect(calls.some((c) => c.args[1] === "close" && c.args[0] === "tab")).toBe(true);
					// la limpieza del map de watchers (handle fuera al settle definitivo)
					// se cubre en settle.test.ts (trackedSettle): aquí no es observable
					// desde fuera de la factory.
				});
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

describe("session_start — recorder dagr (spec 005)", () => {
	async function withDagrEnv(fn: () => Promise<void> | void, o: { env?: Record<string, string | undefined>; config?: string | null; ws?: string | null } = {}) {
		const prev = { HERDR_ENV: process.env.HERDR_ENV, PI_HERDR_DAGR_STATE_DIR: process.env.PI_HERDR_DAGR_STATE_DIR, PI_SESSION_ID: process.env.PI_SESSION_ID, HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID };
		const state = mkdtempSync(join(tmpdir(), "pi-herdr-dagr-idx-"));
		process.env.PI_HERDR_DAGR_STATE_DIR = join(state, "st");
		if (o.env && "HERDR_ENV" in o.env) {
			if (o.env.HERDR_ENV === undefined) delete process.env.HERDR_ENV;
			else process.env.HERDR_ENV = o.env.HERDR_ENV;
		} else {
			process.env.HERDR_ENV = "1";
		}
		process.env.PI_SESSION_ID = "sess-test-1";
		if (o.ws === null) delete process.env.HERDR_WORKSPACE_ID;
		else process.env.HERDR_WORKSPACE_ID = o.ws ?? "w1";
		try {
			// PI_HOME aislado (con config opcional) — el helper del otro describe está
			// scopeado; versión mínima inline.
			const prevHome = process.env.PI_HOME;
			const home = mkdtempSync(join(tmpdir(), "pi-herdr-dagr-home-"));
			mkdirSync(join(home, "extensions-config"), { recursive: true });
			writeFileSync(join(home, "extensions-config", "pi-herdr.json"), o.config ?? JSON.stringify({ defaults: {} }));
			process.env.PI_HOME = home;
			try {
				await fn();
			} finally {
				if (prevHome === undefined) delete process.env.PI_HOME;
				else process.env.PI_HOME = prevHome;
				rmSync(home, { recursive: true, force: true });
			}
		} finally {
			for (const [k, v] of Object.entries(prev)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
			rmSync(state, { recursive: true, force: true });
		}
	}

	it("HERDR_ENV + dagr on: crea el run eager de la sesión", async () => {
		await withDagrEnv(async () => {
			const { api, handlers } = fakeApi();
			extension(api as never);
			const ctx = {
				sessionManager: {
					getBranch: () => [],
					getSessionId: () => "ctx-sess-1",
				},
			};
			for (const h of handlers.filter((x) => x.event === "session_start")) {
				await h.fn(undefined, ctx);
			}
			const st = process.env.PI_HERDR_DAGR_STATE_DIR!;
			const runPath = join(st, "default", "ctx-sess-1.json");
			expect(existsSync(runPath)).toBe(true);
			const doc = JSON.parse(readFileSync(runPath, "utf8"));
			expect(doc.run.id).toBe("ctx-sess-1");
			expect(doc.tasks).toEqual([]);
		}, { ws: null });
	});

	it("workspace label de herdr workspace list resuelve el dir del run", async () => {
		await withDagrEnv(async () => {
			const { api, handlers } = fakeApi();
			extension(api as never);
			// la ruta 'workspace list' no está mockeada → fallback al slug del id
			const ctx = { sessionManager: { getBranch: () => [], getSessionId: () => "s2" } };
			for (const h of handlers.filter((x) => x.event === "session_start")) {
				await h.fn(undefined, ctx);
			}
			expect(existsSync(join(process.env.PI_HERDR_DAGR_STATE_DIR!, "w1", "s2.json"))).toBe(true);
		});
	});

	it("herdr_dagr:false → ni ficheros ni recorder (A5)", async () => {
		await withDagrEnv(async () => {
			const { api, handlers } = fakeApi();
			extension(api as never);
			const ctx = { sessionManager: { getBranch: () => [], getSessionId: () => "s3" } };
			for (const h of handlers.filter((x) => x.event === "session_start")) {
				await h.fn(undefined, ctx);
			}
			expect(existsSync(process.env.PI_HERDR_DAGR_STATE_DIR!)).toBe(false);
		}, { config: JSON.stringify({ herdr_dagr: false }) });
	});

	it("HERDR_ENV unset → sin recorder (ruling R-F)", async () => {
		await withDagrEnv(async () => {
			const { api, handlers } = fakeApi();
			extension(api as never);
			const ctx = { sessionManager: { getBranch: () => [], getSessionId: () => "s4" } };
			for (const h of handlers.filter((x) => x.event === "session_start")) {
				await h.fn(undefined, ctx);
			}
			expect(existsSync(process.env.PI_HERDR_DAGR_STATE_DIR!)).toBe(false);
		}, { env: { HERDR_ENV: undefined } });
	});

	it("session_start que lanza (getSessionId roto) no rompe la sesión: el grafo jamás tumba nada", async () => {
		await withDagrEnv(async () => {
			const { api, handlers } = fakeApi();
			extension(api as never);
			const ctx = { sessionManager: { getBranch: () => [], getSessionId: () => { throw new Error("boom"); } } };
			for (const h of handlers.filter((x) => x.event === "session_start")) {
				await expect(Promise.resolve(h.fn(undefined, ctx))).resolves.toBeUndefined();
			}
		});
	});
});

describe("agent board wiring (spec 007 T4)", () => {
	/** ChildProcess falso con EventEmitters reales (copia local del helper del
	 * describe M5: el test dispara stdout/close para llevar al watcher REAL
	 * hasta el evento blocked). */
	function controllableChild(): ChildProcess {
		const c = new EventEmitter() as unknown as Record<string, unknown>;
		c.kill = () => {};
		c.stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
		c.stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });
		return c as unknown as ChildProcess;
	}

	/** Corre todos los session_start con el ctx dado (patrón runStarts local). */
	async function startAll(handlers: ReturnType<typeof fakeApi>["handlers"], ctx: unknown): Promise<void> {
		for (const h of handlers.filter((x) => x.event === "session_start")) {
			await h.fn(undefined, ctx);
		}
	}

	it("dispatch exitoso con ctx.mode tui → el board registra el widget (seam board de DispatchDeps, R1)", async () => {
		await withHerdrEnv(async () => {
			await withIsolatedPiHome(JSON.stringify({ defaults: {} }), async () => {
				const { api, tools, handlers } = fakeApi();
				const { run } = fakeRun(dispatchRoutes);
				extension(api as never, { run, spawnWait: idleChild, getConfig: () => ({}) });
				const widgets: { id: string; content: unknown }[] = [];
				const notifies: { msg: string; level: string }[] = [];
				await startAll(handlers, {
					mode: "tui", // guard de modo en el call-site (D7): jamás hasUI
					sessionManager: { getBranch: () => [] },
					ui: { setWidget: (id: string, content: unknown) => widgets.push({ id, content }), notify: (msg: string, level: string) => notifies.push({ msg, level }) },
				});
				expect(widgets).toHaveLength(0); // sin líneas: nada registrado
				const t = tools.find((x) => x.name === "herdr_dispatch")!;
				await t.execute!("c1", { task: "revisa el login" });
				expect(widgets.some((w) => w.id === "herdr-board" && typeof w.content === "function")).toBe(true);
				expect(notifies).toHaveLength(0);
			});
		});
	});

	it("session_start SIN mode (suite pre-007 / headless) → dispatch no toca la UI (R11)", async () => {
		await withHerdrEnv(async () => {
			await withIsolatedPiHome(JSON.stringify({ defaults: {} }), async () => {
				const { api, tools, handlers } = fakeApi();
				const { run } = fakeRun(dispatchRoutes);
				extension(api as never, { run, spawnWait: idleChild, getConfig: () => ({}) });
				const widgets: unknown[] = [];
				await startAll(handlers, { sessionManager: { getBranch: () => [] } }); // sin mode ni ui
				const t = tools.find((x) => x.name === "herdr_dispatch")!;
				await t.execute!("c1", { task: "revisa el login" });
				expect(widgets).toHaveLength(0);
			});
		});
	});

	it("evento blocked del watcher → toast warning del board vía emit + widget BLOCKED (R2, D5)", async () => {
		await withHerdrEnv(async () => {
			await withIsolatedPiHome(JSON.stringify({ defaults: {} }), async () => {
				const { api, tools, handlers } = fakeApi();
				const { run } = fakeRun(dispatchRoutes);
				const children: ChildProcess[] = [];
				extension(api as never, {
					run,
					spawnWait: () => {
						const c = controllableChild();
						children.push(c);
						return c;
					},
					getConfig: () => ({}),
				});
				const widgets: { id: string; content: unknown }[] = [];
				const notifies: { msg: string; level: string }[] = [];
				await startAll(handlers, {
					mode: "tui",
					sessionManager: { getBranch: () => [] },
					ui: { setWidget: (id: string, content: unknown) => widgets.push({ id, content }), notify: (msg: string, level: string) => notifies.push({ msg, level }) },
				});
				const t = tools.find((x) => x.name === "herdr_dispatch")!;
				await t.execute!("c1", { task: "revisa el login" });
				const child = children[0] as unknown as { stdout: EventEmitter; emit(e: string, ...a: unknown[]): void };
				child.stdout.emit("data", JSON.stringify({ result: { agent: { agent_status: "blocked" } } }));
				child.emit("close", 0);
				await waitFor(() => notifies.length > 0, "toast blocked");
				expect(notifies).toHaveLength(1); // UN toast por evento (anti-flood del watcher)
				expect(notifies[0]!.level).toBe("warning");
				expect(notifies[0]!.msg).toBe("herdr: revisa-login BLOCKED — decisión pendiente en su pane");
				// el widget refleja BLOCKED en su línea
				const factory = widgets.find((w) => w.id === "herdr-board" && typeof w.content === "function")!.content as
					(tui: unknown, theme: { fg(_c: string, t: string): string }) => { render(width: number): string[] };
				const comp = factory({}, { fg: (_c, t) => t });
				expect(comp.render(80)[0]).toContain("revisa-login · BLOCKED");
			});
		});
	});

	it("config board off en fichero → enabled inicial off: dispatch sin widget; on en caliente lo re-enciende (R10, D6)", async () => {
		await withHerdrEnv(async () => {
			// PI_HOME con board:off YA en disco — el enabled inicial sale del partial crudo
			await withIsolatedPiHome(JSON.stringify({ defaults: { board: "off" } }), async () => {
				const { api, tools, handlers, commands } = fakeApi();
				const { run } = fakeRun(dispatchRoutes);
				extension(api as never, { run, spawnWait: idleChild, getConfig: () => ({}) });
				const widgets: { id: string; content: unknown }[] = [];
				await startAll(handlers, {
					mode: "tui",
					sessionManager: { getBranch: () => [] },
					ui: { setWidget: (id: string, content: unknown) => widgets.push({ id, content }), notify: () => {} },
				});
				const t = tools.find((x) => x.name === "herdr_dispatch")!;
				await t.execute!("c1", { task: "revisa el login" });
				expect(widgets).toHaveLength(0); // board off: sin widget
				// /herdr config board on en caliente (comando real de la factory)
				const cmd = commands.find((c) => c.name === "herdr")!;
				await (cmd.handler as (args: string, ctx: unknown) => Promise<void>)("config board on", {
					hasUI: false,
					ui: { notify: () => {}, select: async () => undefined },
				});
				await t.execute!("c2", { task: "arregla el pago" });
				expect(widgets.some((w) => w.id === "herdr-board" && typeof w.content === "function")).toBe(true);
			});
		});
	});

	it("/herdr config board off con sesión TUI viva → clear inmediato del widget (R10)", async () => {
		await withHerdrEnv(async () => {
			await withIsolatedPiHome(JSON.stringify({ defaults: {} }), async () => {
				const { api, tools, handlers, commands } = fakeApi();
				const { run } = fakeRun(dispatchRoutes);
				extension(api as never, { run, spawnWait: idleChild, getConfig: () => ({}) });
				const widgets: { id: string; content: unknown }[] = [];
				await startAll(handlers, {
					mode: "tui",
					sessionManager: { getBranch: () => [] },
					ui: { setWidget: (id: string, content: unknown) => widgets.push({ id, content }), notify: () => {} },
				});
				const t = tools.find((x) => x.name === "herdr_dispatch")!;
				await t.execute!("c1", { task: "revisa el login" });
				expect(widgets.some((w) => w.id === "herdr-board" && typeof w.content === "function")).toBe(true);
				const cmd = commands.find((c) => c.name === "herdr")!;
				await (cmd.handler as (args: string, ctx: unknown) => Promise<void>)("config board off", {
					hasUI: false,
					ui: { notify: () => {}, select: async () => undefined },
				});
				expect(widgets.some((w) => w.id === "herdr-board" && w.content === undefined)).toBe(true);
			});
		});
	});
});
});
