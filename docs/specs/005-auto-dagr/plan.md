# Plan de implementación: Spec 005 — Auto-dagr: el grafo del enjambre grabado por pi-herdr

> Ejecutar tarea a tarea, TDD (rojo → verde → commit). Suite completa verde + typecheck limpio en CADA commit.

**Objetivo:** Cada sesión pi con pi-herdr mantiene su `run.json` (contrato v3) actualizado por los eventos de sus tools; linaje por entorno (`DAGR_RUN`/`DAGR_TASK`); auto-exención de pi-herdr en hijos; `composed-<raíz>.json` integrando los tres niveles.

**Arquitectura:** Modelo puro del contrato (`dagrdoc.ts`) + Recorder dueño del fichero de sesión (`dagr.ts`, writes tmp→check→rename serializados, fire-and-forget jamás-throw) + compositor que escanea el state dir (`dagrcompose.ts`). Hooks opcionales (`DagrHook`) inyectados en dispatch/settle/registry/global — el grabado nunca puede romper ni retrasar una tool.

**Stack:** igual que el repo (TS nodenext, vitest, typebox). Binario dagr real para validación blanda y tests de humo (skip si ausente): `~/.config/herdr/plugins/github/herdr-dagr-*/bin/dagr` o PATH.

**Spec:** `docs/specs/005-auto-dagr/spec.md`. Contrato: `CONTRACT.md` del plugin herdr-dagr (v3).

## Rulings de pre-flight (verificados con `dagr check --strict` sobre probes reales)

- **R-A (E150):** tarea `done` + intento `settled_unverified` → ERROR E150. El settle se codifica: intento terminal `settled_unverified`/`evidence: asserted` + **tarea `settled_unverified`** (la frase "tarea done" de D0 = tarea terminal; el probe manda, A6 exige strict verde).
- **R-B (E112):** NO existen estados de intento `blocked` ni `canceled`. Codificación: blocked → tarea `blocked` (unblock `operator`) + intento queda `working`; stop/shutdown → tarea `canceled` + intento `lost` con `outcome {result: lost, evidence: verified, receipt: <motivo>}` (probe: strict ✓). gone/reconcile → intento `lost` + tarea `failed` (receipt con nota).
- **R-C (warnings fatales):** `--strict` convierte warnings en exit 1. El fichero publicado sale SIN warnings: locator en intentos working, liveness (prompt_acknowledged / queued_input **u64**, last_output_at), timestamps en terminales, cause en n>1, unblock owner, generated_at, eventos ascendentes.
- **R-D (linaje):** campos top-level no-contratados son tolerados (probe ✓). El linaje vive DENTRO del run.json como `lineage: {parent_run?, parent_task?, session, workspace, pane?}` — sin meta.json hermano (el compositor lee los run.json igualmente; cero ficheros extra, cero lecturas extra).
- **R-E (dispatch fallido):** no crea tarea. La reserva de task id se libera; el contador queda consumido (ids estables solo importan para tareas escritas). Grafo limpio, sin ruido de typos.
- **R-F (ámbito):** dagr activo solo con `HERDR_ENV=1` (sin herdr no hay dispatches que grabar; las tools ni se enteran). Flags de config leídos al session_start (vigencia: sesión).
- **R-G (validación blanda):** `dagr check --strict` sobre el tmp tras escribirlo, await con timeout 2s (check real ~ms), warning por consola si falla, rename SIEMPRE. Checker inyectable; binario resuelto una vez (glob del plugin > PATH) y cacheado; sin binario → silencio.

## Mapeo D0 final (autoritativo, task-level / attempt-level)

| Evento pi-herdr | Tarea | Intento |
|---|---|---|
| dispatch nace (submitted) | `working` | a1 `working` (locator, liveness ack) |
| dispatch nace (initialBlocked) | `blocked` + unblock `operator` | a1 `working` + liveness queued_input:1 |
| settle (idle/done) | `settled_unverified` | terminal `settled_unverified` + outcome `{result, evidence: asserted}` |
| blocked (evento watcher) | `blocked` + unblock `operator` | sigue `working` |
| herdr_prompt submitted | `working` | aN `working`, cause `followup(ref aN-1, reason: 1ª línea)` |
| herdr_prompt → agent_blocked | `blocked` (idempotente) | sin intento nuevo |
| gone / reconcile-muerto | `failed` + nota | terminal `lost` + outcome `{result: lost, evidence: verified, receipt}` |
| herdr_stop | `canceled` | terminal `lost` + receipt `herdr_stop` |
| shutdownCleanup | `canceled` | terminal `lost` + receipt `fin de sesión` |
| stranded | sin cambio | nota (event `note`) |

Eventos del log: `attempt_started` (dispatch/prompt), `attempt_settled` (terminal), `note` (blocked/stranded/initialBlocked). Siempre con task/attempt/actor/detail según probe t6.

## Restricciones globales

- Writes: SIEMPRE tmp→rename en el mismo directorio; tmp único (`.<pid>.<seq>.tmp`); serializados en cadena interna (orden de eventos preservado); fire-and-forget con catch → `console.warn`, jamás throw ni await en el path de la tool (salvo `flush()` en shutdown).
- Composed: artefacto derivado, último-gana, atómico; regenerado tras cada write del propio run SOLO si el linaje de la raíz tiene hijos (scan lo revela); ruta `<stateDir>/composed-<slug-raíz>.json` (slug = basename del dir del run raíz).
- Env linaje: `--env DAGR_RUN=<abs>` `--env DAGR_TASK=<id>` SOLO al crear topología; `DAGR_RUN` heredado no se re-inyecta (el hijo usa SU run).
- Sesión sin DAGR_RUN → raíz propia. Watch de agente ajeno → ni nodo ni update (v1).
- Ids: tarea `<agent>-<n>` (contador por nombre, estable, session-scoped); intento `<task>·aN`; prefijo de composed `<10 chars de session>-` para hijos.
- Config: `herdr_dagr` / `herdr_dagr_children` (top-level de pi-herdr.json, default true, snake_case literal de la spec; no-boolean → warning + default). No entra en wizard/CONFIG_KEYS; `/herdr` status las muestra (readonly).
- herdr_dispatch con dagr ON despacha hijos con auto-exención `-e <pi-herdr>` cuando extensions ≠ true (dedup, patrón herdr-agent-state); `herdr_dagr_children: false` la quita.
- Suite existente 279 verde sin tocarse (hooks opcionales).

## Foco de revisión (modo de fallo → test que lo fija)

1. Estructura inválida publicada (E150/E112/warnings) → T1 golden checks con binario real (skipIf) sobre ciclo de vida completo.
2. Tool rota o se retrasa por el grafo → T2: record* nunca throw (fs roto → warn), writes async fuera del path de la tool, orden preservado.
3. Env inyectado tarde (task id no reservado antes de topología) → T4: assert de ORDEN de llamadas (reserve antes de tab create) y `--env` en las 3 topologías.
4. Composed inválido (ids colisionando entre sesiones, refs de events dangling, wrapper huérfano) → T7: prefijos por sesión, reescritura de refs, skip+log de huérfanos, strict-check del composed.
5. Auto-exención duplicada o ausente → T3 (dedup con lista explícita, extensions:true intacto, dagr off sin exención).
6. Resume pierde estado (counters reset → ids inestables) → T2: reload de run existente adopta tasks/events y continúa contadores.

## Estructura de ficheros

- Crear: `src/dagrdoc.ts` (modelo puro v3 + reducers D0), `src/dagr.ts` (DagrRecorder + DagrHook + paths + validación blanda), `src/dagrcompose.ts` (compositor).
- Modificar: `src/config.ts` (flags dagr), `src/herdr.ts` (env en 3 wrappers de topología), `src/piargs.ts` (exenciones extra), `src/dispatch.ts` (hook: reserve/env/born/release + prompt), `src/settle.ts` (hook en ramas), `src/registry.ts` (stop/reconcile/shutdown), `src/global.ts` (Watches onOwnEvent), `src/command.ts` (status line), `index.ts` (init session_start + proxy + flush), `README.md`.
- Tests: `tests/dagrdoc.test.ts`, `tests/dagr.test.ts`, `tests/dagrcompose.test.ts` + bloques en dispatch/settle/registry/global/config/piargs/index.

---

### Tarea 1: `dagrdoc.ts` — modelo puro del contrato + reducers D0

**Ficheros:** crear `src/dagrdoc.ts`, `tests/dagrdoc.test.ts`.

**Interfaces (Produce, usan T2/T7):**
```ts
export interface DagrAttempt { id: string; n: number; cause?: {type: string; ref?: string; reason?: string}; actor: string; locator?: {pane: string; agent: string}; state: "working"|"settled_unverified"|"lost"; started_at: string; ended_at?: string; outcome?: {result: string; evidence: "asserted"|"verified"; receipt?: string; reason?: string}; liveness?: {prompt_acknowledged?: boolean; queued_input?: number; last_output_at?: string} }
export interface DagrTask { id: string; title: string; kind: "agent"; owner?: string; state: "working"|"blocked"|"settled_unverified"|"failed"|"canceled"; unblock?: string; note?: string; attempts: DagrAttempt[] }
export interface DagrEvent { at: string; type: "attempt_started"|"attempt_settled"|"note"; task?: string; attempt?: string; actor?: string; detail?: string }
export interface DagrLineage { parent_run?: string; parent_task?: string; session: string; workspace: string; pane?: string }
export interface DagrDoc { dagr: 3; run: {id: string; title: string; started_at: string}; generated_at: string; lineage?: DagrLineage; tasks: DagrTask[]; events: DagrEvent[] }
export function firstLine(text: string): string;                       // título, recortado a 80
export function newDoc(o: {sessionId: string; title: string; now: Date; lineage?: DagrLineage}): DagrDoc;
export function nextTaskId(doc: DagrDoc, agent: string): string;       // agent-<n>, n = max existente+1
// reducers (mutan doc; jamás throw; agente sin tarea = no-op):
export function taskBorn(doc, o: {agent; paneId; title; blocked: boolean; now: Date; taskId?: string}): string;
export function taskPrompt(doc, agent, note: string, now: Date): void;   // aN working + cause followup(ref aN-1) + task working
export function taskBlocked(doc, agent, now: Date): void;               // idempotente; unblock operator; liveness queued_input:1
export function taskSettled(doc, agent, state: string, now: Date): void;
export function taskGone(doc, agent, receipt: string, now: Date): void; // lost+failed
export function taskCanceled(doc, agent, receipt: string, now: Date): void; // lost+canceled
export function taskNote(doc, agent, detail: string, now: Date): void;
```

- **P1 (rojo):** ciclo de vida completo en un doc: newDoc → born(working) → blocked → prompt(a2, cause followup ref a1) → settled (a2 terminal settled_unverified/asserted, task settled_unverified, ended_at) → cancel posterior no-op sobre terminal; born(initialBlocked) → task blocked + a1 working + queued_input 1; gone → intento lost outcome verified receipt + task failed + nota; canceled → task canceled + intento lost; nextTaskId: builder, builder (tras cancel) → builder-2, builder-3; ids de intento `<task>·aN`; eventos append ascendentes attempt_started/attempt_settled/note; generated_at = now; locator presente en working, ausente en terminal.
- **P2 FAIL → P3 implementar → P4 PASS.**
- **P5 (golden, skipIf sin binario):** serializar el doc del ciclo de vida a tmp y `dagr check --strict` → exit 0. (Foco 1.)

### Tarea 2: `dagr.ts` — DagrRecorder: paths, linaje, writes atómicos, validación blanda, resume

**Ficheros:** crear `src/dagr.ts`, `tests/dagr.test.ts`.

**Interfaces (Produce, usan T4/T5/T7):**
```ts
export interface DagrHook {   // proxy no-op en index.ts cuando dagr off
  reserve(agent: string): { env: Record<string, string>; task: string } | undefined; // DAGR_RUN/DAGR_TASK
  born(o: {agent: string; paneId: string; title: string; blocked: boolean}): void;
  release(agent: string): void;          // R-E: reserva sin tarea
  childrenExempt: boolean;               // herdr_dagr_children && recorder activo
  prompt(agent: string, note: string): void;
  blocked(agent: string): void; settled(agent: string, state: string): void;
  gone(agent: string, receipt?: string): void; canceled(agent: string, receipt?: string): void; note(agent: string, detail: string): void;
}
export interface RecorderDeps { stateDir?: string; validate?: (path: string) => Promise<string | undefined>; warn?: (msg: string) => void; now?: () => Date }
export class DagrRecorder implements DagrHook {
  static async init(o: { sessionId: string; workspaceLabel: string; cwdTitle: string; env: Record<string, string|undefined>; deps?: RecorderDeps }): Promise<DagrRecorder>; // linaje desde env DAGR_RUN/DAGR_TASK; eager minimal doc si no existe
  readonly runPath: string;
  flush(): Promise<void>;               // drena la cola de writes (shutdown)
}
export function stateDirOf(home: string): string;        // ~/.local/state/herdr-dagr
export function wsSlug(label: string): string;           // [a-z0-9._-], fallback "default"
```

- **P1 (rojo):** con tmpdir real como stateDir:
  - init crea `<dir>/<slug>/<session>.json` eager (doc mínimo, strict-válido), con `lineage` cuando env trae DAGR_RUN/DAGR_TASK; adopta el existente en resume (tasks/counters/events conservados; segundo born mismo agente → id -2).
  - reserve → env `DAGR_RUN=<runPath>` + `DAGR_TASK`; born/prompt/blocked/settled/gone/canceled/note → fichero final refleja reducers T1; orden preservado bajo ráfaga (await flush).
  - Atomicidad: nunca quedan `*.tmp`; write con fs roto (dir imposible) → warn, NO throw, tool sigue (foco 2).
  - validate: llamado con el path tmp; falla → warn con salida, rename OCURRE igual (R-G); sin validate → silencio.
  - childrenExempt desde deps/flags (aquí solo el campo).
- **P2 FAIL → P3 implementar → P4 PASS → P5 commit** `feat(dagr): recorder con writes atómicos, linaje y validación blanda`.

### Tarea 3: D2b — auto-exención de pi-herdr en hijos + flags de config

**Ficheros:** modificar `src/config.ts` (`loadDefaults` → `dagr: {enabled, children}` desde `herdr_dagr`/`herdr_dagr_children`), `src/piargs.ts` (`opts.exemptExtensions?: string[]`), `src/command.ts` (status: 2 líneas readonly), tests ídem.

- **P1 (rojo):** config: default `{enabled: true, children: true}`; `"herdr_dagr": false` → off; valores no-boolean → warning + default; `/herdr` status muestra ambas con origen. piargs con árbol temporal que instala pi-herdr en extensions/: `exemptExtensions: ["pi-herdr"]` + extensions false → `--no-extensions -e state -e <pi-herdr>`; con lista explícita → dedup si el usuario ya lo pidió; extensions true → SIN flags (intacto); sin exempt → args idénticos a hoy (foco 5).
- **P2 FAIL → P3 → P4 PASS → P5 commit** `feat(dagr): flags herdr_dagr/herdr_dagr_children y auto-exención de pi-herdr en hijos`.

### Tarea 4: D3 — linaje en dispatch: reserva, `--env` en topología, born/release

**Ficheros:** modificar `src/herdr.ts` (tabCreate/paneSplitRight/workspaceCreate `env?: Record<string,string>` → `--env K=V` tras `--cwd/--label`, antes de `--no-focus`), `src/dispatch.ts` (`DispatchDeps.dagr?: DagrHook`), tests.

- **P1 (rojo):**
  - Wrappers: env `{A:"1"}` → args exactos con `--env A=1` en las 3 topologías; sin env → args idénticos a hoy (regresión).
  - dispatch con hook fake: ORDEN reserve → tabCreate (con `--env DAGR_RUN=… DAGR_TASK=…`); born tras registry.add con `{agent, paneId, title: 1ª línea, blocked: initialBlocked}`; kind≠pi (piArgs=[]) también inyecta env (el linaje no es de pi).
  - Fallos post-reserva (setup falla, agentStart falla): `release` llamado y CERO `born`.
  - Sin hook (dagr off): behavior byte-idéntico (foco 5 / A5).
- **P2 FAIL → P3 → P4 PASS → P5 commit** `feat(dagr): inyección de linaje DAGR_RUN/DAGR_TASK vía --env al crear topología`.

### Tarea 5: D0 completo — hooks en settle, prompt, stop, reconcile, shutdown

**Ficheros:** modificar `src/settle.ts` (`SettleDeps.dagr?`), `src/dispatch.ts` (promptAgent → `prompt` en submitted / `blocked` idempotente), `src/registry.ts` (`CleanupDeps.dagr?`: stopAgent→canceled "herdr_stop"; reconcile muerto→gone "reconciled: agent absent"; shutdownCleanup→canceled "fin de sesión"), tests.

- **P1 (rojo):** settle: blocked→hook.blocked; settled(keepOpen y final)→hook.settled; gone→hook.gone; stranded→hook.note; record cerrado/desconocido→nada. promptAgent: submitted→hook.prompt con 1ª línea; "blocked"→hook.blocked, SIN prompt. stopDispatch→canceled. reconcile: vivo→nada, muerto→gone con receipt. shutdown: cada live→canceled "fin de sesión". Sin hook: todo idéntico (279 intactos).
- **P2 FAIL → P3 → P4 PASS → P5 commit** `feat(dagr): ciclo de vida D0 grabado en settle/prompt/stop/reconcile/shutdown`.

### Tarea 6: D1-global — Watches sobre despachos propios

**Ficheros:** modificar `src/global.ts` (`GlobalWatchDeps.onOwnEvent?: (target: string, ev: WatchEvent) => void`, invocado tras el manejo propio, envuelto en try/catch), tests/global.

- **P1 (rojo):** watch de agente propio: settled → onOwnEvent(target, ev) llamado (index aplicará D0); watch de ajeno: onOwnEvent NO llamado (spec: no contamina); onOwnEvent que lanza → el mensaje de aviso normal se emite igual.
- **P2 FAIL → P3 → P4 PASS → P5 commit** `feat(dagr): herdr_watch sobre propios alimenta el grafo (hook onOwnEvent)`.

### Tarea 7: D4 — compositor + wiring en index + README + smokes

**Ficheros:** crear `src/dagrcompose.ts`, `tests/dagrcompose.test.ts`; modificar `index.ts` (init en session_start: config gate + HERDR_ENV + sessionId de `ctx.sessionManager.getSessionId()` (fallback `PI_SESSION_ID`) + workspace label vía `herdr workspace list` (fallback slug de HERDR_WORKSPACE_ID); proxy DagrHook siempre presente inyectado en deps/settle/ Watches (resuelve propios por nombre o paneId); `flush()` en session_shutdown), `README.md`.

**Compositor:**
```ts
export interface ComposeIO { listRunFiles(): Promise<string[]>; readDoc(path: string): Promise<DagrDoc | undefined>; writeAtomic(path: string, doc: DagrDoc): Promise<void> }
export function findRoot(io, runPath): Promise<{rootPath: string} | undefined>;   // walk-up por lineage.parent_run, visited+depth≤16
export function composeFrom(io, rootPath: string, warn?: (m: string) => void): Promise<string | undefined>; // escribe composed-<slug>.json; undefined si sin hijos
```
- Integración (D4): BFS desde raíz por `lineage.parent_run`; por cada hijo: wrapper project (id = task id EN EL CONTEXTO DEL PADRE — mapeado a prefijado si el padre es hijo; título = título de esa tarea), re-home de la tarea padre (`task.project = wrapper`), proyecto raíz del hijo `<pfx>-root` (title = run.title del hijo) con `parent = wrapper`, tasks del hijo con `project = <pfx>-root` e ids prefijados `<10 session>-`, attempts/events re-escritos con el mismo mapa. Events mergeados y sort asc. Huérfano (parent_task inexistente) → hijo skippeado + warn; ciclo → visited set. Raíz sin hijos → no escribe nada.

- **P1 (rojo):** fixtures de 3 niveles en tmpdir (raíz nyx + hijo + nieto): composed contiene wrapper con título de la tarea, hijo anidado, nieto bajo SU tarea (wrapper del hijo mapeado con prefijo); ids sin colisión; `dagr check --strict` del composed → exit 0 (skipIf). Raíz sola → sin composed. Huérfano/corrupto → skip + warn + composed válido sin ese hijo. Índex: session_start crea recorder (config on) y NO lo crea (config off / HERDR_ENV unset) — cero ficheros (A5); dagrHook proxy no-op cuando off; shutdown hace flush.
- **P2 FAIL → P3 implementar → P4 PASS + typecheck.**
- **P5 (smoke real, skipIf binario):** scenario completo desde tests → run raíz + hijo (fixtures) → `dagr check --strict` ambos + composed; `dagr view --snapshot --width 100 composed.json` renderiza sin error.
- **P6 (smoke vivo, dentro de herdr):** sesión headless `pi --extension . -p …` con HERDR_ENV → eager run creado y strict-válido; verificar que un dispatch real desde esa sesión inyecta `--env DAGR_*` (o documentar limitación). Registrar en progress.md.
- **P7 commit** `feat(dagr): compositor composed-<raíz>.json + wiring session_start — spec 005 completa`.

## Cobertura spec → tareas

A1 T1/T2/T4 · A2 T1/T5 · A3 T2/T4/T7 (hijo: eager+linaje+wrapper) · A4 T2/T7 (tmp+rename, último-gana) · A5 T3/T4/T7 · A6 T1/T2 (golden + blanda) · A7 T7 smokes (+ pendiente humano E2E Trinity-like). Casos límite: gone T1/T5 · nombre repetido T1/T2 · watch ajeno T6 · eager hijo T2/T7 · dispatch fallido T4 (R-E) · huérfana sin DAGR_RUN T2/T7 · ciclo/huérfano composed T7. D2b T3 · D5 T2/T3/T7.

## Auto-revisión

- Debounce: sin debounce v1 (writes diminutos, cadena serializa) — documentado como elección.
- Fidelidad conocida: agente bloqueado que reanuda solo (aprobación en pane) sigue viéndose `blocked` hasta el próximo evento del watcher — granularidad de eventos, documentado.
- Los issues #17/#18 no se tocan.
