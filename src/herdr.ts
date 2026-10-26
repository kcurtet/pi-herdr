/**
 * Seam de ejecución sobre el CLI de herdr.
 *
 * Todo wrapper recibe una RunFn inyectable para que los tests (y el resto de
 * módulos) nunca dependan de un herdr real. Los parse paths provienen de
 * fixtures capturados en vivo (tests/fixtures).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Timeout por defecto para comandos de control herdr. */
const CONTROL_TIMEOUT_MS = 15_000;
/** `agent start` espera readiness interactiva (default CLI 30s, margen superior). */
const START_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 10 * 1024 * 1024;

export type RunFn = (
	file: string,
	args: string[],
	opts?: { cwd?: string; timeoutMs?: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** RunFn real: execFile con timeout y captura de salida. */
export const localRun: RunFn = async (file, args, opts) => {
	try {
		const { stdout, stderr } = await execFileAsync(file, args, {
			cwd: opts?.cwd,
			timeout: opts?.timeoutMs ?? CONTROL_TIMEOUT_MS,
			maxBuffer: MAX_BUFFER,
			encoding: "utf8",
		});
		return { code: 0, stdout: stdout ?? "", stderr: stderr ?? "" };
	} catch (err) {
		const e = err as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
		if (e.killed) {
			throw new Error(`herdr: timeout ejecutando \`${file} ${args.join(" ")}\``);
		}
		// ENOENT (herdr no instalado) o exit != 0: superficie uniforme para arriba
		return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? String(err) };
	}
};

/** Falla si la sesión pi no corre dentro de herdr. Debe llamarse ANTES de cualquier side effect. */
export function assertHerdrEnv(env: Record<string, string | undefined>): void {
	if (env.HERDR_ENV !== "1") {
		throw new Error(
			"pi-herdr: esta sesión no corre dentro de herdr (HERDR_ENV unset). Los dispatches visibles requieren herdr.",
		);
	}
}

export interface AgentInfo {
	name?: string;
	agent_status: string;
	pane_id: string;
}

interface HerdrEnvelope<T> {
	id: string;
	result: T;
}

async function runOk(
	run: RunFn,
	args: string[],
	opts?: { cwd?: string; timeoutMs?: number },
): Promise<string> {
	const r = await run("herdr", args, { timeoutMs: CONTROL_TIMEOUT_MS, ...opts });
	if (r.code !== 0) {
		const detail = [r.stdout, r.stderr].filter(Boolean).join("\n").trim();
		throw new Error(`herdr ${args.slice(0, 2).join(" ")} falló (exit ${r.code}): ${detail}`);
	}
	return r.stdout;
}

function parse<T>(stdout: string, what: string): HerdrEnvelope<T> {
	let env: HerdrEnvelope<T>;
	try {
		env = JSON.parse(stdout) as HerdrEnvelope<T>;
	} catch {
		throw new Error(`herdr ${what}: salida no es JSON: ${stdout.slice(0, 300)}`);
	}
	if (!env || typeof env !== "object" || !("result" in env)) {
		throw new Error(`herdr ${what}: JSON sin campo result: ${stdout.slice(0, 300)}`);
	}
	return env;
}

export async function tabCreate(
	run: RunFn,
	o: { cwd: string; label: string },
): Promise<{ paneId: string; tabId: string; workspaceId: string }> {
	const stdout = await runOk(run, ["tab", "create", "--cwd", o.cwd, "--label", o.label, "--no-focus"]);
	const r = parse<{ root_pane: { pane_id: string; workspace_id: string }; tab: { tab_id: string } }>(stdout, "tab create").result;
	return { paneId: r.root_pane.pane_id, tabId: r.tab.tab_id, workspaceId: r.root_pane.workspace_id };
}

export async function paneSplitRight(run: RunFn, o: { cwd: string }): Promise<{ paneId: string }> {
	// pane split no tiene --no-focus: el split no roba foco por diseño del flag set real
	const stdout = await runOk(run, ["pane", "split", "--current", "--direction", "right", "--cwd", o.cwd]);
	const r = parse<{ pane: { pane_id: string } }>(stdout, "pane split").result;
	return { paneId: r.pane.pane_id };
}

export async function workspaceCreate(
	run: RunFn,
	o: { cwd: string; label: string },
): Promise<{ paneId: string; workspaceId: string }> {
	const stdout = await runOk(run, ["workspace", "create", "--cwd", o.cwd, "--label", o.label, "--no-focus"]);
	const r = parse<{ root_pane: { pane_id: string; workspace_id: string } }>(stdout, "workspace create").result;
	return { paneId: r.root_pane.pane_id, workspaceId: r.root_pane.workspace_id };
}

export async function agentStart(
	run: RunFn,
	o: { name: string; kind: string; paneId: string; piArgs?: string[] },
): Promise<void> {
	const args = ["agent", "start", o.name, "--kind", o.kind, "--pane", o.paneId];
	if (o.piArgs && o.piArgs.length > 0) args.push("--", ...o.piArgs);
	await runOk(run, args, { timeoutMs: START_TIMEOUT_MS });
}

/**
 * Envía un prompt SIN --wait (submission ≠ turno iniciado).
 * Devuelve "blocked" si herdr rechaza con agent_blocked (agente esperando input).
 */
export async function agentPrompt(run: RunFn, o: { name: string; text: string }): Promise<"submitted" | "blocked"> {
	const r = await run("herdr", ["agent", "prompt", o.name, o.text]);
	if (r.code === 0) return "submitted";
	if (`${r.stdout}\n${r.stderr}`.includes("agent_blocked")) return "blocked";
	const detail = [r.stdout, r.stderr].filter(Boolean).join("\n").trim();
	throw new Error(`herdr agent prompt falló (exit ${r.code}): ${detail}`);
}

export async function agentRead(run: RunFn, o: { name: string; lines?: number }): Promise<string> {
	return runOk(run, [
		"agent",
		"read",
		o.name,
		"--source",
		"recent-unwrapped",
		"--lines",
		String(o.lines ?? 200),
	]);
}

export async function agentList(run: RunFn): Promise<AgentInfo[]> {
	const stdout = await runOk(run, ["agent", "list"]);
	return parse<{ agents: AgentInfo[] }>(stdout, "agent list").result.agents;
}

export async function agentGet(run: RunFn, name: string): Promise<AgentInfo> {
	const stdout = await runOk(run, ["agent", "get", name]);
	return parse<{ agent: AgentInfo }>(stdout, "agent get").result.agent;
}

export type CloseTarget = { kind: "tab" | "pane" | "workspace"; id: string };

export async function closeTarget(run: RunFn, t: CloseTarget): Promise<void> {
	await runOk(run, [t.kind, "close", t.id]);
}
