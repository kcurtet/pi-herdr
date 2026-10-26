import { readFileSync } from "node:fs";
import type { RunFn } from "../src/herdr.ts";

export interface RecordedCall {
	file: string;
	args: string[];
	opts?: { cwd?: string; timeoutMs?: number };
}

export function fx(name: string): string {
	return readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8");
}

/** Mock RunFn: enruta por los dos primeros args (subcomando) y registra todo. */
export function fakeRun(
	routes: Record<string, { code: number; stdout: string; stderr?: string }>,
): { run: RunFn; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const run: RunFn = async (file, args, opts) => {
		calls.push({ file, args, opts });
		const key = args.slice(0, 2).join(" ");
		const r = routes[key];
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
