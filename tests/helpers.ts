import { readFileSync } from "node:fs";
import type { RunFn } from "../src/herdr.ts";
import type { DagrHook } from "../src/dagr.ts";

export interface RecordedCall {
	file: string;
	args: string[];
	opts?: { cwd?: string; timeoutMs?: number };
}

export function fx(name: string): string {
	return readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8");
}

/** Mock RunFn: enruta por los dos primeros args (subcomando) y registra todo.
 * Fallback: "<file> <args...>" para binarios no-herdr (p.ej. "bash -c"). */
export function fakeRun(
	routes: Record<string, { code: number; stdout: string; stderr?: string }>,
): { run: RunFn; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const run: RunFn = async (file, args, opts) => {
		calls.push({ file, args, opts });
		const key = args.slice(0, 2).join(" ");
		const altKey = [file, args[0] ?? ""].join(" ");
		const r = routes[key] ?? routes[altKey];
		if (!r) return { code: 1, stdout: "", stderr: `unmocked: ${key}` };
		return { code: r.code, stdout: r.stdout, stderr: r.stderr ?? "" };
	};
	return { run, calls };
}

export const ok = (stdout: string): { code: number; stdout: string; stderr: string } => ({
	code: 0,
	stdout,
	stderr: "",
});

/** Espera hasta que cond() sea true (máx ms). */
export async function waitFor(cond: () => boolean, what: string, ms = 3_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error(`timeout esperando: ${what}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}

/** Gate manual para tests de concurrencia: `gate` queda pendiente hasta `release()`. */
export function deferred(): { gate: Promise<void>; release: () => void } {
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	return { gate, release };
}

/** JSON de `herdr agent get` con el estado dado (spec 006: esc y settle verificados). */
export const agentGetJson = (status: string): string =>
	`{"id":"cli:agent:get","result":{"agent":{"agent_status":"${status}","name":"impl-x","pane_id":"w4:p4M"}},"type":"agent_info"}`;

/** Fake del DagrHook que graba TODAS las llamadas — aserta solo las que importen. */
export function dagrFake(): { hook: DagrHook; calls: { what: string; arg?: unknown }[] } {
	const calls: { what: string; arg?: unknown }[] = [];
	const hook: DagrHook = {
		reserve: (agent: string) => {
			calls.push({ what: "reserve", arg: agent });
			return { env: { DAGR_RUN: "/st/nyx/s0.json", DAGR_TASK: `${agent}-1` }, task: `${agent}-1` };
		},
		release: (agent: string) => calls.push({ what: "release", arg: agent }),
		born: (o: { agent: string; paneId: string; title: string; blocked: boolean }) => calls.push({ what: "born", arg: o }),
		childrenExempt: true,
		prompt: (a: string, n: string) => calls.push({ what: "prompt", arg: [a, n] }),
		blocked: (a: string) => calls.push({ what: "blocked", arg: a }),
		settled: (a: string, s: string) => calls.push({ what: "settled", arg: [a, s] }),
		gone: (a: string, r?: string) => calls.push({ what: "gone", arg: [a, r] }),
		canceled: (a: string, r?: string) => calls.push({ what: "canceled", arg: [a, r] }),
		note: (a: string, d: string) => calls.push({ what: "note", arg: [a, d] }),
	};
	return { hook, calls };
}
