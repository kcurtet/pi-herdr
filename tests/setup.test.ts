import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { localRun, type RunFn } from "../src/herdr.ts";
import { deferred, fakeRun, ok, waitFor } from "./helpers.ts";
import {
	detectSetupCommand,
	LOCKFILE_COMMANDS,
	parseSetupMode,
	runSetup,
	serializeSetup,
	SETUP_TIMEOUT_MS,
} from "../src/setup.ts";

const tmpDirs: string[] = [];
afterEach(() => {
	for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpRepo(files: string[]): string {
	const repo = mkdtempSync(join(tmpdir(), "pi-herdr-setup-"));
	tmpDirs.push(repo);
	for (const f of files) {
		mkdirSync(join(repo, f, ".."), { recursive: true });
		writeFileSync(join(repo, f), "");
	}
	return repo;
}

describe("parseSetupMode (pura)", () => {
	it("worktree true: omitido y \"auto\" → auto", () => {
		expect(parseSetupMode(undefined, true)).toEqual({ kind: "auto" });
		expect(parseSetupMode("auto", true)).toEqual({ kind: "auto" });
	});

	it("worktree true: \"none\" → none; literal pasa intacto (incluye &&)", () => {
		expect(parseSetupMode("none", true)).toEqual({ kind: "none" });
		expect(parseSetupMode("npm install && npm run build", true)).toEqual({
			kind: "literal",
			command: "npm install && npm run build",
		});
	});

	it("worktree true: \"\" → error de validación", () => {
		expect(() => parseSetupMode("", true)).toThrow(/no válido/);
	});

	it("worktree true: \"NONE\" mayúsculas → literal case-sensitive", () => {
		expect(parseSetupMode("NONE", true)).toEqual({ kind: "literal", command: "NONE" });
	});

	it("worktree false: \"auto\" o literal → error temprano (setup sin worktree)", () => {
		expect(() => parseSetupMode("auto", false)).toThrow(/worktree/);
		expect(() => parseSetupMode("npm ci", false)).toThrow(/worktree/);
	});

	it("worktree false: omitido o \"none\" → no-op sin error", () => {
		expect(parseSetupMode(undefined, false)).toEqual({ kind: "none" });
		expect(parseSetupMode("none", false)).toEqual({ kind: "none" });
	});
});

describe("detectSetupCommand (pura, prioridad lockfiles)", () => {
	it("pnpm-lock.yaml gana sobre package-lock.json (prioridad fija)", () => {
		const repo = tmpRepo(["pnpm-lock.yaml", "package-lock.json"]);
		expect(detectSetupCommand(repo)).toBe("pnpm install --frozen-lockfile");
	});

	it("mapa completo por gestor", () => {
		expect(detectSetupCommand(tmpRepo(["bun.lock"]))).toBe("bun install");
		expect(detectSetupCommand(tmpRepo(["bun.lockb"]))).toBe("bun install");
		expect(detectSetupCommand(tmpRepo(["yarn.lock"]))).toBe("yarn install --immutable");
		expect(detectSetupCommand(tmpRepo(["package-lock.json"]))).toBe("npm ci");
	});

	it("sin lockfile conocido → undefined", () => {
		expect(detectSetupCommand(tmpRepo(["Cargo.lock"]))).toBeUndefined();
		expect(detectSetupCommand(tmpRepo([]))).toBeUndefined();
	});

	describe("LOCKFILE_COMMANDS", () => {
	it("el orden del array ES la prioridad spec (pnpm>bun>yarn>npm)", () => {
		expect(LOCKFILE_COMMANDS.map((c) => c.file)).toEqual([
			"pnpm-lock.yaml",
			"bun.lock",
			"bun.lockb",
			"yarn.lock",
			"package-lock.json",
		]);
	});
	});
});

describe("runSetup", () => {
	it("éxito: bash -c <cmd> en cwd con timeout inyectado; devuelve elapsed", async () => {
		const { run, calls } = fakeRun({ "bash -c": ok("") });
		const r = await runSetup(run, { command: "pnpm install --frozen-lockfile", cwd: "/w", timeoutMs: 100 });
		expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
		expect(calls[0]).toEqual({
			file: "bash",
			args: ["-c", "pnpm install --frozen-lockfile"],
			opts: { cwd: "/w", timeoutMs: 100 },
		});
	});

	it("cola del mutex: elapsedMs ES wall-clock desde entrada (incluye espera) y queuedMs la desglosa (minor 4, issue #18)", async () => {
		const { gate, release } = deferred();
		let held = false;
		const run: RunFn = async () => {
			if (!held) {
				held = true; // la primera llamada retiene el mutex hasta release
				await gate;
			}
			return { code: 0, stdout: "", stderr: "" };
		};
		const first = runSetup(run, { command: "npm ci", cwd: "/w" });
		await new Promise((r) => setTimeout(r, 120)); // segunda entra mientras la primera retiene
		const second = runSetup(run, { command: "pnpm i", cwd: "/w2" });
		await new Promise((r) => setTimeout(r, 40));
		release();
		const [r1, r2] = await Promise.all([first, second]);
		expect(r1.queuedMs).toBeLessThan(120); // la primera no esperó
		expect(r2.queuedMs).toBeGreaterThanOrEqual(40); // la segunda esperó hasta el release (≥ su post-entrada)
		expect(r2.elapsedMs).toBeGreaterThanOrEqual(r2.queuedMs); // percibido = ejecución + cola
	});

	it("SETUP_TIMEOUT_MS default = 10 min (spec R8)", () => {
		expect(SETUP_TIMEOUT_MS).toBe(600_000);
	});

	it("fallo exit 1: error con comando, exit code y SOLO el tail de stderr (~2000 chars)", async () => {
		const lines = Array.from({ length: 300 }, (_, i) => `line-${i}`);
		const stderr = `${lines.join("\n")}\nFINAL-LINE`;
		const { run } = fakeRun({ "bash -c": { code: 1, stdout: "", stderr } });
		const err = await runSetup(run, { command: "npm ci", cwd: "/w", timeoutMs: 100 }).catch((e) => e);
		expect(err.message).toContain('setup "npm ci" falló (exit 1)');
		expect(err.message).toContain("FINAL-LINE");
		expect(err.message).not.toContain("line-0");
	});

	it("fallo con stderr vacía: tail desde stdout", async () => {
		const { run } = fakeRun({ "bash -c": { code: 2, stdout: "OUT-TAIL", stderr: "" } });
		const err = await runSetup(run, { command: "npm ci", cwd: "/w", timeoutMs: 100 }).catch((e) => e);
		expect(err.message).toContain("exit 2");
		expect(err.message).toContain("OUT-TAIL");
	});

	it("timeout real (localRun): motivo timeout y tail con la salida parcial (spec D3/D4)", async () => {
		const err = await runSetup(localRun, {
			command: "node -e \"console.log('lento-pre-kill'); setTimeout(() => {}, 5000)\"",
			cwd: process.cwd(),
			timeoutMs: 200,
		}).catch((e) => e);
		expect(err.message).toContain("(timeout)");
		expect(err.message).toContain("lento-pre-kill");
	}, 10_000);

	it("RunFn out-of-contract que lanza: NO se etiqueta timeout, surfacea la excepción (minor 3, issue #18)", async () => {
		const boom: RunFn = async () => {
			throw new Error("ENOTENOKEOF");
		};
		const err = await runSetup(boom, { command: "npm ci", cwd: "/w" }).catch((e) => e);
		expect(err.message).not.toContain("(timeout)");
		expect(err.message).toContain("excepción");
		expect(err.message).toContain("ENOTENOKEOF");
		expect(err.message).toContain('setup "npm ci"');
	});
});

describe("serializeSetup", () => {
	it("la segunda NO arranca hasta que acaba la primera (mutex en-proceso, spec D6)", async () => {
		const started: string[] = [];
		const mk = (id: string) => {
			const { gate, release } = deferred();
			return {
				fn: () =>
					new Promise<void>((res) => {
						started.push(id);
						gate.then(res);
					}),
				release,
			};
		};
		const a = mk("a");
		const b = mk("b");
		const pa = serializeSetup(a.fn);
		const pb = serializeSetup(b.fn);
		await waitFor(() => started.length === 1, "a arranca en la primera microtask");
		expect(started).toEqual(["a"]); // b aún no arrancó
		a.release();
		await pa;
		await waitFor(() => started.includes("b"), "b arranca tras a");
		b.release();
		await pb;
	});

	it("el fallo de la primera no rompe a la segunda (serializa ejecución, no fallos)", async () => {
		const started: string[] = [];
		const mk = (id: string, fail: boolean) => {
			const { gate, release } = deferred();
			return {
				fn: () =>
					new Promise<void>((res, rej) => {
						started.push(id);
						gate.then(() => (fail ? rej(new Error(`${id} boom`)) : res()));
					}),
				release,
			};
		};
		const bad = mk("bad", true);
		const good = mk("good", false);
		const pBad = serializeSetup(bad.fn).catch((e) => e);
		const pGood = serializeSetup(good.fn);
		bad.release();
		expect(await pBad).toBeInstanceOf(Error);
		await waitFor(() => started.includes("good"), "good arranca tras bad fallido");
		good.release();
		await pGood; // resuelve aunque bad rechazó
	});
});
