import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeHerdrCommand, type CommandCtxLike } from "../src/command.ts";
import { loadDefaults, saveDefaults, type DispatchDefaults } from "../src/config.ts";

const tmpDirs: string[] = [];
afterEach(() => {
	for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(saved: DispatchDefaults = {}, options?: { skillNames?: string[]; extNames?: string[] }) {
	const base = mkdtempSync(join(tmpdir(), "pi-herdr-cmd-"));
	tmpDirs.push(base);
	const configPath = join(base, "pi-herdr.json");
	saveDefaults(configPath, saved);
	const deps = {
		configPath,
		load: () => loadDefaults(configPath),
		save: (d: DispatchDefaults) => saveDefaults(configPath, d),
		skillNames: () => options?.skillNames ?? ["writing-specs", "triage"],
		extNames: () => options?.extNames ?? ["pi-monitor"],
		kinds: ["pi", "claude", "codex"],
	};
	const cmd = makeHerdrCommand(deps);
	const notifies: { msg: string; level: string }[] = [];
	const selects: string[] = [];
	let queue: string[] = [];
	const ctx: CommandCtxLike = {
		hasUI: true,
		ui: {
			notify: (msg, level) => notifies.push({ msg, level }),
			select: async (_t, items) => {
				selects.push(items[0] ?? "");
				const next = queue.shift();
				return next !== undefined && items.includes(next) ? next : undefined;
			},
		},
	};
	return { cmd, ctx, notifies, configPath, setQueue: (q: string[]) => (queue = q), selects };
}

const read = (p: string): DispatchDefaults =>
	(JSON.parse(readFileSync(p, "utf8")) as { defaults: DispatchDefaults }).defaults;

describe("/herdr bare", () => {
	it("muestra los 6 defaults con origen y la ayuda", async () => {
		const { cmd, ctx, notifies } = setup({ skills: true });
		await cmd.handler("", ctx);
		const msg = notifies[0]!.msg;
		for (const k of ["skills", "extensions", "topology", "kind", "keepOpen", "worktree"]) {
			expect(msg).toContain(k);
		}
		expect(msg).toMatch(/skills.*config/); // origen
		expect(msg).toMatch(/extensions.*builtin|extensions.*default/);
		expect(msg).toContain("/herdr config");
	});
});

describe("/herdr config <key> <valor>", () => {
	it("bool y lista y enum", async () => {
		const { cmd, ctx, configPath } = setup();
		await cmd.handler("config skills true", ctx);
		expect(read(configPath)).toEqual({ skills: true });
		await cmd.handler("config skills writing-specs,triage", ctx);
		expect(read(configPath)).toEqual({ skills: ["writing-specs", "triage"] });
		await cmd.handler("config topology pane", ctx);
		expect(read(configPath)).toEqual({ skills: ["writing-specs", "triage"], topology: "pane" });
		await cmd.handler("config kind claude", ctx);
		expect(read(configPath).kind).toBe("claude");
		await cmd.handler("config worktree true", ctx);
		expect(read(configPath).worktree).toBe(true);
	});
	it("valor inválido → error y no cambia", async () => {
		const { cmd, ctx, configPath, notifies } = setup({ keepOpen: true });
		await cmd.handler("config topology x", ctx);
		expect(read(configPath)).toEqual({ keepOpen: true });
		expect(notifies.some((n) => n.level === "error")).toBe(true);
	});
	it("key inválida → error", async () => {
		const { cmd, ctx, notifies } = setup();
		await cmd.handler("config nope true", ctx);
		expect(notifies.some((n) => n.level === "error" && /nope/i.test(n.msg))).toBe(true);
	});
});

describe("/herdr reset", () => {
	it("reset total y por key", async () => {
		const { cmd, ctx, configPath } = setup({ skills: true, topology: "pane" });
		await cmd.handler("reset skills", ctx);
		expect(read(configPath)).toEqual({ topology: "pane" });
		await cmd.handler("reset", ctx);
		expect(read(configPath)).toEqual({});
	});
});

describe("wizard", () => {
	it("secuencia skills→true→Done persiste", async () => {
		const { cmd, ctx, configPath, setQueue } = setup();
		setQueue(["skills", "true", "Done"]);
		await cmd.handler("config", ctx);
		expect(read(configPath)).toEqual({ skills: true });
	});
	it("headless: usage sin select", async () => {
		const { cmd, ctx, notifies, selects } = setup();
		ctx.hasUI = false;
		await cmd.handler("config", ctx);
		expect(selects).toHaveLength(0);
		expect(notifies[0]!.msg).toMatch(/usage|config/i);
	});
});

describe("completions", () => {
	it("posición 0: config|reset", () => {
		const { cmd } = setup();
		const vals = (p: string) => (cmd.completions(p) ?? []).map((i) => i.value);
		expect(vals("")).toEqual(["config ", "reset "]);
		expect(vals("conf")).toEqual(["config "]);
	});
	it("posición 1: keys para config y reset", () => {
		const { cmd } = setup();
		const vals = (p: string) => (cmd.completions(p) ?? []).map((i) => i.value);
		expect(vals("config ")).toEqual(["skills ", "extensions ", "topology ", "kind ", "keepOpen ", "worktree "]);
		expect(vals("config sk")).toEqual(["skills "]);
		expect(vals("reset sk")).toEqual(["skills "]);
	});
	it("posición 2: valores por key (bool/enum/kinds/nombres)", () => {
		const { cmd } = setup();
		const vals = (p: string) => (cmd.completions(p) ?? []).map((i) => i.value);
		expect(vals("config keepOpen ")).toEqual(["true", "false"]);
		expect(vals("config topology ")).toEqual(["tab", "pane", "workspace"]);
		expect(vals("config kind ")).toEqual(["pi", "claude", "codex"]);
		expect(vals("config skills ")).toEqual(["true", "false", "writing-specs", "triage"]);
		expect(vals("config extensions ")).toEqual(["true", "false", "pi-monitor"]);
	});
});
