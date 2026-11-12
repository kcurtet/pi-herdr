/**
 * Modelo puro del contrato dagr v3 + mapeo D0 (spec 005).
 *
 * Sin fs ni side effects: reducers sobre un doc en memoria. La validez del
 * contrato la garantiza la construcción (estados/fields de los probes con
 * `dagr check --strict`; rulings R-A..R-C del plan):
 * - settle → intento terminal settled_unverified/asserted + TAREA
 *   settled_unverified (E150 prohíbe tarea done).
 * - blocked/canceled NO existen como estado de intento (E112): blocked deja el
 *   intento working con tarea blocked+unblock; canceled cierra el intento como
 *   lost con outcome verified/receipt.
 * - cierre con MÁS de un intento vivo (issue #20): cada intento restante se
 *   reconcilia lost con receipt de la causa (sin stale attempts → W209).
 * - Sin warnings bajo --strict: locator+liveness en working, timestamps en
 *   terminales, cause followup en n>1, eventos ascendentes, generated_at.
 */

export interface DagrOutcome {
	result: string;
	evidence: "asserted" | "verified";
	receipt?: string;
	reason?: string;
}

export interface DagrAttempt {
	id: string;
	n: number;
	cause?: { type: string; ref?: string; reason?: string };
	actor: string;
	/** Volátil, solo mientras vive (se retira al cerrar el intento). */
	locator?: { pane: string; agent: string };
	state: "working" | "settled_unverified" | "lost";
	started_at: string;
	ended_at?: string;
	/** Requerido en estado terminal (E140); result === state (E141). */
	outcome?: DagrOutcome;
	liveness?: { prompt_acknowledged?: boolean; queued_input?: number; last_output_at?: string };
}

export type DagrTaskState = "working" | "blocked" | "settled_unverified" | "failed" | "canceled";

export interface DagrTask {
	id: string;
	title: string;
	kind: "agent";
	owner?: string;
	/** Campo no-contratado (tolerado): pane del agente — sobrevive al cierre
	 * del intento para locator de intentos posteriores (rev 005 F6). */
	pane?: string;
	project?: string;
	state: DagrTaskState;
	unblock?: string;
	note?: string;
	attempts: DagrAttempt[];
}

export interface DagrEvent {
	at: string;
	type: "attempt_started" | "attempt_settled" | "note";
	task?: string;
	attempt?: string;
	actor?: string;
	detail?: string;
}

/** Linaje de la sesión (campo top-level no-contratado, tolerado por dagr). */
export interface DagrLineage {
	parent_run?: string;
	parent_task?: string;
	session: string;
	workspace: string;
	pane?: string;
}

export interface DagrProject {
	id: string;
	title: string;
	parent?: string;
	owner?: string;
	note?: string;
}

export interface DagrDoc {
	dagr: 3;
	run: { id: string; title: string; started_at: string };
	generated_at: string;
	lineage?: DagrLineage;
	/** Solo el composed los materializa; el run de una sesión no los necesita. */
	projects?: DagrProject[];
	tasks: DagrTask[];
	events: DagrEvent[];
}

const TITLE_MAX = 80;

/** Primera línea no vacía del texto, recortada (título de tarea / nota). */
export function firstLine(text: string): string {
	const line = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
	return line.length > TITLE_MAX ? line.slice(0, TITLE_MAX - 1) + "…" : line;
}

export function newDoc(o: { sessionId: string; title: string; now: Date; lineage?: DagrLineage }): DagrDoc {
	return {
		dagr: 3,
		run: { id: o.sessionId, title: o.title, started_at: o.now.toISOString() },
		generated_at: o.now.toISOString(),
		lineage: o.lineage,
		tasks: [],
		events: [],
	};
}

function taskOf(doc: DagrDoc, agent: string): DagrTask | undefined {
	return doc.tasks.find((t) => t.owner === agent);
}

/** Intento vivo (working) del task — el que cierran las transiciones terminales. */
function liveAttempt(task: DagrTask): DagrAttempt | undefined {
	return task.attempts.find((a) => a.state === "working");
}

function pushEvent(doc: DagrDoc, ev: DagrEvent): void {
	// W207: append ascendente — los eventos llegan ya en orden por construcción
	doc.events.push(ev);
	doc.generated_at = ev.at;
}

/** Id de tarea para el agente: `<agent>-<n>`, n = max existente + 1 (estable). */
export function nextTaskId(doc: DagrDoc, agent: string): string {
	let max = 0;
	const prefix = `${agent}-`;
	for (const t of doc.tasks) {
		if (!t.id.startsWith(prefix)) continue;
		const n = Number(t.id.slice(prefix.length));
		if (Number.isFinite(n)) max = Math.max(max, n);
	}
	return `${agent}-${max + 1}`;
}

/** Cierra el intento vivo: estado terminal + outcome + ended_at; sin locator/liveness. */
function closeAttempt(
	a: DagrAttempt,
	o: { state: "settled_unverified" | "lost"; outcome: DagrOutcome; now: Date },
): void {
	a.state = o.state;
	a.ended_at = o.now.toISOString();
	a.outcome = o.outcome;
	a.locator = undefined;
	a.liveness = undefined;
}

/** Issue #20 (W209): reconciliación de intentos huérfanos al cierre del pane.
 * Los reducers terminales cierran UN intento vivo (el principal), pero un
 * pane puede dejar más intentos working (p.ej. herdr_prompt sobre un agente
 * con el turno colgado). Sin esto quedan stale para siempre y dagr load
 * reporta W209. Cada intento que SIGA working tras el cierre principal se
 * reconcilia como lost con receipt de la causa del cierre — mismo formato que
 * la reconciliación manual y que gone/canceled (lost: <receipt>). */
function reconcileLiveAttempts(doc: DagrDoc, task: DagrTask, actor: string, receipt: string, now: Date): void {
	for (const a of task.attempts) {
		if (a.state !== "working") continue;
		closeAttempt(a, { state: "lost", outcome: { result: "lost", evidence: "verified", receipt }, now });
		pushEvent(doc, { at: now.toISOString(), type: "attempt_settled", task: task.id, attempt: a.id, actor, detail: `lost: ${receipt}` });
	}
}

/** herdr_dispatch nace: task (working|blocked) + intento a1 working. Devuelve el task id. */
export function taskBorn(
	doc: DagrDoc,
	o: { agent: string; paneId: string; title: string; blocked: boolean; now: Date; taskId?: string },
): string {
	const id = o.taskId ?? nextTaskId(doc, o.agent);
	const attemptId = `${id}·a1`;
	doc.tasks.push({
		id,
		title: o.title,
		kind: "agent",
		owner: o.agent,
		pane: o.paneId,
		state: o.blocked ? "blocked" : "working",
		unblock: o.blocked ? "operator" : undefined,
		attempts: [
			{
				id: attemptId,
				n: 1,
				cause: { type: "initial" },
				actor: o.agent,
				locator: { pane: o.paneId, agent: o.agent },
				state: "working",
				started_at: o.now.toISOString(),
				liveness: o.blocked
					? { prompt_acknowledged: true, queued_input: 1 }
					: { prompt_acknowledged: true },
			},
		],
	});
	pushEvent(doc, { at: o.now.toISOString(), type: "attempt_started", task: id, attempt: attemptId, actor: o.agent });
	if (o.blocked) {
		pushEvent(doc, { at: o.now.toISOString(), type: "note", task: id, actor: o.agent, detail: "blocked: el prompt inicial fue rechazado — espera aprobación" });
	}
	return id;
}

/** herdr_prompt submitted: nuevo intento working con cause followup; task vuelve a working. */
export function taskPrompt(doc: DagrDoc, agent: string, note: string, now: Date): void {
	const task = taskOf(doc, agent);
	if (!task) return;
	const prev = task.attempts.at(-1);
	const n = task.attempts.length + 1;
	const attemptId = `${task.id}·a${n}`;
	task.attempts.push({
		id: attemptId,
		n,
		cause: { type: "followup", ref: prev?.id, reason: `herdr_prompt: ${firstLine(note)}` },
		actor: agent,
		locator: { pane: task.pane ?? task.attempts[0]?.locator?.pane ?? "", agent },
		state: "working",
		started_at: now.toISOString(),
		liveness: { prompt_acknowledged: true },
	});
	// el agente reanuda: la task sale de blocked si estaba
	task.state = "working";
	task.unblock = undefined;
	pushEvent(doc, { at: now.toISOString(), type: "attempt_started", task: task.id, attempt: attemptId, actor: agent });
}

/** blocked (evento watcher o prompt rechazado): task blocked + unblock operator. Idempotente. */
export function taskBlocked(doc: DagrDoc, agent: string, now: Date): void {
	const task = taskOf(doc, agent);
	if (!task || task.state === "blocked") return;
	if (task.state !== "working") return; // terminal: nada que bloquear
	task.state = "blocked";
	task.unblock = "operator";
	const live = liveAttempt(task);
	if (live) live.liveness = { ...live.liveness, queued_input: 1, last_output_at: now.toISOString() };
	pushEvent(doc, { at: now.toISOString(), type: "note", task: task.id, actor: agent, detail: "blocked: espera decisión del operador en su pane" });
}

/** settle (idle/done): intento terminal settled_unverified/asserted + task settled_unverified.
 * Issue #20: el principal es el ÚLTIMO intento vivo (E150: el más reciente debe
 * coincidir con el estado terminal de la tarea) — el nudge en vuelo es el que
 * settlea. Los ANTERIORES que sigan working (turnos colgados/superseded) se
 * reconcilian lost con la causa del cierre — sin stale attempts (W209). */
export function taskSettled(doc: DagrDoc, agent: string, state: string, now: Date): void {
	const task = taskOf(doc, agent);
	if (!task) return;
	const live = task.attempts.findLast((a) => a.state === "working");
	if (!live) return; // ya terminal (duplicado tardío): no reabrir
	closeAttempt(live, { state: "settled_unverified", outcome: { result: "settled_unverified", evidence: "asserted" }, now });
	task.state = "settled_unverified";
	task.unblock = undefined;
	pushEvent(doc, { at: now.toISOString(), type: "attempt_settled", task: task.id, attempt: live.id, actor: agent, detail: "settled (idle/done) — afirmado, no verificado" });
	reconcileLiveAttempts(doc, task, agent, `pane settled (${state}) — intento vivo al cierre`, now);
}

/** gone / reconcile-muerto: intento lost + task failed, receipt con la causa.
 * Issue #20: el resto de intentos vivos se reconcilia con la misma causa. */
export function taskGone(doc: DagrDoc, agent: string, receipt: string, now: Date): void {
	const task = taskOf(doc, agent);
	if (!task) return;
	const live = liveAttempt(task);
	if (!live) return;
	closeAttempt(live, { state: "lost", outcome: { result: "lost", evidence: "verified", receipt }, now });
	task.state = "failed";
	task.unblock = undefined;
	pushEvent(doc, { at: now.toISOString(), type: "attempt_settled", task: task.id, attempt: live.id, actor: agent, detail: `lost: ${receipt}` });
	reconcileLiveAttempts(doc, task, agent, receipt, now);
}

/** herdr_stop / fin de sesión: task canceled + intento lost con receipt.
 * Issue #20: el resto de intentos vivos se reconcilia con la misma causa. */
export function taskCanceled(doc: DagrDoc, agent: string, receipt: string, now: Date): void {
	const task = taskOf(doc, agent);
	if (!task) return;
	const live = liveAttempt(task);
	if (!live) return;
	closeAttempt(live, { state: "lost", outcome: { result: "lost", evidence: "verified", receipt }, now });
	task.state = "canceled";
	task.unblock = undefined;
	pushEvent(doc, { at: now.toISOString(), type: "attempt_settled", task: task.id, attempt: live.id, actor: agent, detail: `canceled: ${receipt}` });
	reconcileLiveAttempts(doc, task, agent, receipt, now);
}

/** Nota sin cambio de estado (stranded, avisos): solo event log. */
export function taskNote(doc: DagrDoc, agent: string, detail: string, now: Date): void {
	const task = taskOf(doc, agent);
	if (!task) return;
	pushEvent(doc, { at: now.toISOString(), type: "note", task: task.id, actor: agent, detail });
}
