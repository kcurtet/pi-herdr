import { describe, expect, it } from "vitest";
import { Registry, shutdownCleanup, stopAgent, stopDispatch, type DispatchRecord } from "../src/registry.ts";
import extension from "../index.ts";
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

const closeRoutes = {
	"tab close": ok('{"result":{"type":"ok"}}'),
	"pane close": ok('{"result":{"type":"ok"}}'),
	"workspace close": ok('{"result":{"type":"ok"}}'),
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
		await stopAgent(
			{ run, registry, cleanupWorktree: async (_r, o) => { cleanups.push(o.dir); return { removed: true }; } },
			"impl-x",
		);
		expect(cleanups).toEqual(["/d"]);
		expect(calls[0].args).toEqual(["tab", "close", "w4:t4K"]);
		expect(registry.get("impl-x")!.status).toBe("closed");
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
	function fakeApi() {
		const tools: { name: string; parameters: Record<string, unknown> }[] = [];
		const handlers: { event: string; fn: (event: unknown, ctx: unknown) => Promise<void> | void }[] = [];
		const commands: { name: string; description: string; handler: unknown; getArgumentCompletions?: (p: string) => unknown }[] = [];
		return {
			api: {
				registerTool: (t: { name: string; parameters: Record<string, unknown> }) => tools.push(t),
				on: (event: string, fn: (event: unknown, ctx: unknown) => Promise<void> | void) => handlers.push({ event, fn }),
				registerCommand: (name: string, def: { description: string; handler: unknown; getArgumentCompletions?: (p: string) => unknown }) =>
					commands.push({ name, ...def }),
				sendMessage: () => {},
				appendEntry: () => {},
			},
			tools,
			handlers,
			commands,
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
