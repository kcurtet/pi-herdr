import { describe, expect, it } from "vitest";
import { Registry, shutdownCleanup, stopAgent, type DispatchRecord } from "../src/registry.ts";
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
		registry.add(rec({ agent: "dos", topology: "pane", targetId: "w4:p5A", worktree: { dir: "/d", branch: "hd/dos" } }));
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
		registry.add(rec({ worktree: { dir: "/d", branch: "hd/impl-x" } }));
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

describe("factory de la extensión", () => {
	function fakeApi() {
		const tools: { name: string; parameters: Record<string, unknown> }[] = [];
		const handlers: { event: string; fn: (event: unknown, ctx: unknown) => Promise<void> | void }[] = [];
		return {
			api: {
				registerTool: (t: { name: string; parameters: Record<string, unknown> }) => tools.push(t),
				on: (event: string, fn: (event: unknown, ctx: unknown) => Promise<void> | void) => handlers.push({ event, fn }),
				sendMessage: () => {},
				appendEntry: () => {},
			},
			tools,
			handlers,
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

	it("schema de herdr_dispatch: task requerida, topology enum tab|pane|workspace", () => {
		const { api, tools } = fakeApi();
		extension(api as never);
		const t = tools.find((x) => x.name === "herdr_dispatch")!;
		const props = (t.parameters as { properties: Record<string, { type?: string; anyOf?: { const: string }[]; optional?: boolean }> }).properties;
		expect(props.task?.type).toBe("string");
		expect(props.topology?.anyOf?.map((a) => a.const)).toEqual(["tab", "pane", "workspace"]);
		expect(props.worktree?.type).toBe("boolean");
		expect(props.keepOpen?.type).toBe("boolean");
		const required = (t.parameters as { required?: string[] }).required;
		expect(required).toContain("task");
	});
});
