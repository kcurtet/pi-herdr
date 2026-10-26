# Plan de implementación: pi-herdr — dispatch visible en herdr

> Ejecutar con la skill `executing-plans`, tarea a tarea. Pasos con checkbox `- [ ]`.

**Objetivo:** Extensión pi autocontenida que convierte la skill herdr-dispatch en 5 tools: una llamada `herdr_dispatch` = despacho completo con vigilancia integrada y auto-cierre.

**Arquitectura:** Seam de ejecución (`RunFn`) inyectable en todo lo que toca herdr/git → todo testeable sin herdr instalado. Watcher adaptado del motor de pi-monitor (spawn + entrega vía `sendMessage` con `triggerTurn`), pero dirigido por `herdr agent wait` (un evento por ciclo de settle, sin batching/ws/timeout). Registry en `appendEntry` reconstruido en `session_start` con reconcile activo contra `herdr agent list`.

**Stack:** TypeScript (nodenext, sin build — jiti carga .ts), vitest, Extension API pi 1.4.x, CLI herdr, git.

**Spec:** `docs/specs/001-dispatch-tool/spec.md` (este plan argumenta desde ella).

## Restricciones globales

- `agent prompt` SIEMPRE sin `--wait`/`--until` (spec D8).
- Creación de topología SIEMPRE con `--no-focus` (spec D8).
- Name: `^[a-z][a-z0-9_-]{0,31}$`, único entre agentes vivos (spec Restricciones).
- Jamás borrar worktree con WIP o rama sin merge (spec D5); `git branch -d` (nunca `-D`).
- IDs solo parseados del JSON devuelto (spec Anti-objetivos).
- `HERDR_ENV=1` requerido; error claro, cero side effects (spec D7).
- `@earendil-works/pi-coding-agent` SOLO peerDependency (lección del repo: devDep instalaría 23MB a cada usuario).
- Command timeouts: control 15s, `agent start` 120s, `agent wait` sin timeout (lo mata el watcher).

## Foco de revisión (modo de fallo → test que lo fija)

1. `--wait` accidental en prompt bloquea la tool → T4 test de secuencia de args.
2. Auto-close en `blocked` mata una aprobación pendiente → T5 test.
3. Worktree con WIP borrado → T8 tests de `decideCleanup`.
4. Resume/crash sin re-arm: eventos muertos para siempre → T9 test de `reconcile`.
5. IDs deducidos en vez de parseados → T1 tests de parse con fixtures reales.
6. Shutdown re-limpia (doble close) → T10 test de idempotencia.

## Estructura de ficheros

- `index.ts` — factory: 5 `registerTool` finas + `session_start`/`session_shutdown`. Sin lógica.
- `src/herdr.ts` — seam `RunFn` + wrappers tipados de subcomandos herdr + `assertHerdrEnv` + parses.
- `src/slug.ts` — `slugify` + `resolveName` (pure + seam).
- `src/watch.ts` — watcher (ciclo wait→get→clasificar→emitir/re-armar).
- `src/dispatch.ts` — orquestación del dispatch + handlers de `herdr_prompt`/`herdr_read`/`herdr_stop`.
- `src/settle.ts` — política D4 (close vs keepOpen vs blocked) + formato de eventos.
- `src/worktree.ts` — crear worktree + cleanup conservador.
- `src/registry.ts` — `DispatchRecord` + persistencia + reconcile.
- `tests/` — un fichero por módulo + `tests/fixtures/*.json` (salidas reales de herdr, abajo).

**Fixtures verificados en vivo** (parse paths exactos):
- `tab create --cwd X --label Y --no-focus` → `{"id":"cli:tab:create","result":{"root_pane":{"pane_id":"w4:p4M","tab_id":"w4:t4K","workspace_id":"w4"},"tab":{"tab_id":"w4:t4K","label":"Y",...}}}`
- `pane split --current --direction right --cwd X` → `{"result":{"pane":{"pane_id":"..."}}}`
- `workspace create --cwd X --label Y --no-focus` → `{"result":{"root_pane":{"pane_id":"...","workspace_id":"..."}}}`
- `agent list` → `{"result":{"agents":[{"name":"x","agent_status":"idle","pane_id":"w13:pY",...}]}}` (`name` ausente en agentes sin nombre)
- `agent get <n>` / `agent wait <n>` → `{"result":{"agent":{"agent_status":"blocked",...}}}` — estados: `idle|working|blocked|done|unknown`
- `tab|pane|workspace close <id>` → `{"result":{"type":"ok"}}`
- `agent prompt <n> <texto>` rechazado con agente bloqueado → exit ≠ 0 con `agent_blocked` en salida (T6 verifica forma exacta con probe vivo)

---

### Tarea 1: Scaffold + seam herdr

**Ficheros:**
- Crear: `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/herdr.ts`, `tests/herdr.test.ts`, `tests/fixtures/*.json`
- Test: `tests/herdr.test.ts`

**Interfaces (Produce, usan todas las tareas posteriores):**
```ts
export type RunFn = (file: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;
export const localRun: RunFn; // execFile real con timeout
export function assertHerdrEnv(env: Record<string, string | undefined>): void; // throw si HERDR_ENV !== "1"
export interface AgentInfo { name?: string; agent_status: string; pane_id: string }
export function tabCreate(run: RunFn, o: { cwd: string; label: string }): Promise<{ paneId: string; tabId: string; workspaceId: string }>;
export function paneSplitRight(run: RunFn, o: { cwd: string }): Promise<{ paneId: string }>;
export function workspaceCreate(run: RunFn, o: { cwd: string; label: string }): Promise<{ paneId: string; workspaceId: string }>;
export function agentStart(run: RunFn, o: { name: string; kind: string; paneId: string }): Promise<void>; // timeoutMs 120_000
export function agentPrompt(run: RunFn, o: { name: string; text: string }): Promise<"submitted" | "blocked">;
export function agentRead(run: RunFn, o: { name: string; lines?: number }): Promise<string>;
export function agentList(run: RunFn): Promise<AgentInfo[]>;
export function agentGet(run: RunFn, name: string): Promise<AgentInfo>;
export type CloseTarget = { kind: "tab" | "pane" | "workspace"; id: string };
export function closeTarget(run: RunFn, t: CloseTarget): Promise<void>;
```

- [ ] **P1: test que falla** — con `run` mock que devuelve fixture de `tab create`: `tabCreate` devuelve `{paneId:"w4:p4M", tabId:"w4:t4K", workspaceId:"w4"}`; ídem `paneSplitRight` (`.result.pane.pane_id`), `workspaceCreate` (`.result.root_pane.pane_id`+`workspace_id`), `agentList` (2 agentes, uno SIN `name`), `assertHerdrEnv({})` lanza / `assertHerdrEnv({HERDR_ENV:"1"})` no lanza. Y: cada wrapper pasa `--no-focus` en creación (foco de revisión 5, spec D8).
- [ ] **P2: run + verificar FAIL** — `npx vitest run` (antes: `npm i -D typescript vitest @types/node`; setup package.json con `"type":"module"`, tsconfig `nodenext`+`allowImportingTsExtensions`+`noEmit`; package.json SOLO peerDep del agente).
- [ ] **P3: implementar `src/herdr.ts`** — cada wrapper: `run("herdr", args)`, exit ≠ 0 → `throw Error(stdout+stderr)`; parse JSON por path del fixture; `agentPrompt` detecta `agent_blocked` en salida y devuelve `"blocked"` (sin throw).
- [ ] **P4: run + verificar PASS**
- [ ] **P5: commit** `feat: seam herdr con parses verificados contra fixtures reales`

### Tarea 2: slug + resolución de nombre

**Ficheros:**
- Crear: `src/slug.ts`, `tests/slug.test.ts`

**Interfaces (Produce):**
```ts
export function slugify(task: string): string; // NFD-strip diacríticos, [a-z0-9-], 3 primeras palabras ≥3 chars, max 32, fallback ""
export async function resolveName(run: RunFn, task: string, explicit?: string): Promise<string>;
// explicit: valida regex + unicidad vs agentList; colisión → throw con sugerencias `<name>-2`
// sin explicit: slugify + unicidad + sufijos -2..-9, fallback `dispatch-<n>` (n = agentes vivos+1)
```
- Consume: `agentList`, fixtures de T1.

- [ ] **P1: test que falla** — `slugify("Revisa el login del admin!!")` → `"revisa-login-admin"`; >32 chars → recortado sin `-` final; vacío/solo stopwords → `""`. `resolveName` con mock `agentList` que ya tiene `"revisa-login-admin"` → `"revisa-login-admin-2"`; explicit `"Bad_Name"` → throw; explicit colisionante → throw con sugerencia en el mensaje.
- [ ] **P2: run FAIL → P3: implementar → P4: PASS**
- [ ] **P5: commit** `feat: slugify y resolución de nombre único`

### Tarea 3: watcher (motor adaptado de pi-monitor)

**Ficheros:**
- Crear: `src/watch.ts`, `tests/watch.test.ts`, `tests/fake-herdr.sh` (shim PATH para spawn real)

**Interfaces (Produce):**
```ts
export type WatchEvent = { kind: "blocked" } | { kind: "settled"; state: "idle" | "done"; output: string } | { kind: "gone"; reason: string };
export interface WatchDeps {
  run: RunFn;                                   // agentGet, agentRead (con timeout)
  spawnWait: (name: string) => ChildProcess;    // herdr agent wait <name>, sin timeout
  emit: (content: string, details: Record<string, unknown>) => void; // → pi.sendMessage(..., {triggerTurn:true})
}
export function armWatcher(deps: WatchDeps, name: string, onEvent: (ev: WatchEvent) => Promise<void>): WatchHandle;
export interface WatchHandle { stop(): void }
```
- Consume: `RunFn` (T1).

- [ ] **P1: test que falla** — spawn REAL de `tests/fake-herdr.sh` en PATH: (a) `wait` sale 0 + `get` fixture `idle` + `read` devuelve texto → `onEvent` recibe `{kind:"settled", state:"idle", output}` exactamente una vez; (b) `get` → `blocked` → recibe `{kind:"blocked"}` Y re-arma (segundo ciclo: fake pasa a `idle` en 2ª llamada → luego `settled`); (c) `wait` sale ≠ 0 → `{kind:"gone", reason}`; (d) `handle.stop()` mata el proceso y no emite más.
- [ ] **P2: run FAIL → P3: implementar** — ciclo: `spawnWait` → close 0 → `agentGet` → clasificar → emitir (vía callback `onEvent`, el formato lo pone T5) → blocked/gone-continuables re-arma; close ≠ 0 → gone. Timers `unref()`, `stop()` = SIGTERM+SIGKILL 5s (copiado de pi-monitor `killWatch`).
- [ ] **P4: PASS → P5: commit** `feat: watcher wait-driven con re-arm en blocked`

### Tarea 4: dispatch happy path (topology tab)

**Ficheros:**
- Crear: `src/dispatch.ts`, `tests/dispatch.test.ts`
- Test: `tests/dispatch.test.ts`

**Interfaces (Produce):**
```ts
export interface DispatchInput { task: string; name?: string; cwd?: string; topology?: "tab" | "pane" | "workspace"; kind?: string; worktree?: boolean; keepOpen?: boolean }
export interface DispatchResult { agent: string; paneId: string; taskId: string; worktreePath?: string }
export interface DispatchDeps { run: RunFn; emit: WatchDeps["emit"]; registry: Registry; arm: typeof armWatcher }
export async function dispatch(deps: DispatchDeps, input: DispatchInput, env: Record<string,string|undefined>): Promise<DispatchResult>;
```
- Consume: T1 wrappers, `resolveName` (T2), `armWatcher` (T3), `Registry` minimal (in-memory `add`/`get`; T9 la hace persistente — usar la interfaz de T9 ya desde aquí).

- [ ] **P1: test que falla** — mock `run` que responde por subcomando; capturar secuencia de llamadas: (1) `assertHerdrEnv` gate — `dispatch(..., {})` throw ANTES de cualquier llamada herdr (foco 5); (2) happy path: `tab create` con `--label <name>` `--no-focus` y `--cwd` → `agent start <name> --kind pi --pane <paneId>` → `agent prompt <name> <task>` SIN `--wait` y SIN `--until` (foco de revisión 1) → `registry.add` con record correcto → `arm` llamado con el name → devuelve `{agent, paneId, taskId}`. (3) task vacía → throw de validación antes de tocar herdr. (4) name colisionante → error, cero llamadas a `tab create`.
- [ ] **P2: FAIL → P3: implementar `dispatch`** (solo rama tab; `cwd` default = `process.cwd()` del contexto pi).
- [ ] **P4: PASS → P5: commit** `feat: dispatch happy path tab`

### Tarea 5: política de settle (D4) + formato de eventos

**Ficheros:**
- Crear: `src/settle.ts`, `tests/settle.test.ts`

**Interfaces (Produce):**
```ts
export function makeSettleHandler(deps: { run: RunFn; registry: Registry; emit: WatchDeps["emit"]; cleanupWorktree: typeof cleanupWorktree }) :
  (name: string, ev: WatchEvent) => Promise<boolean>; // true = seguir vigilando, false = terminar
export function formatEvent(name: string, ev: WatchEvent): string; // sin side effects
```
- Consume: `WatchEvent` (T3), `Registry`, `closeTarget` (T1), `cleanupWorktree` (T8 — inyectada; hasta T8 llega un stub que no borra).

- [ ] **P1: test que falla** — (a) `{kind:"settled"}` con record `keepOpen:false` → `closeTarget(tab)` llamado UNA vez + `registry.markClosed` + false; (b) mismo con `keepOpen:true` → close NO llamado + true (foco de revisión 2); (c) `{kind:"blocked"}` → close NO llamado, true, evento emitido menciona "blocked" y "aprobación" (spec D4); (d) `{kind:"gone"}` → `markClosed`, false, sin close del pane (ya no existe); (e) `formatEvent` settled: primera línea `[<name>] settled (idle)`, cuerpo = output (recortado); (f) record ya `closed` + evento repetido → NO re-cierra ni re-limpia (idempotencia parcial, la completa en T10).
- [ ] **P2: FAIL → P3: implementar → P4: PASS**
- [ ] **P5: commit** `feat: política de settle — auto-close, blocked nunca cierra, keepOpen`

### Tarea 6: herdr_prompt + herdr_read

**Ficheros:**
- Modificar: `src/dispatch.ts` (añadir handlers)
- Test: `tests/dispatch.test.ts` (añadir bloques)

**Interfaces (Produce):**
```ts
export async function promptAgent(deps: DispatchDeps, name: string, text: string): Promise<string>; // descripción para content de la tool
export async function readAgent(deps: DispatchDeps, name: string, lines?: number): Promise<string>;
```

- [ ] **P1: test que falla** — `promptAgent`: record inexistente → error "despacho no encontrado, usa herdr_agents"; record `closed` → error sugiriendo nuevo dispatch (spec D1: agente vivo); `agentPrompt` → `"blocked"` → content explica que el agente espera aprobación en el pane; `"submitted"` → content OK y el watcher existente sigue (no re-arm manual: `arm` NO llamado de nuevo). `readAgent`: passthrough `agentRead` con `lines` default 200.
- [ ] **P2: FAIL → P3: implementar → P4: PASS**
- [ ] **P5: commit** `feat: herdr_prompt y herdr_read sobre agente vivo`

### Tarea 7: topologías pane y workspace

**Ficheros:**
- Modificar: `src/dispatch.ts`, `tests/dispatch.test.ts`

- [ ] **P1: test que falla** — (a) `topology:"pane"`: llama `paneSplitRight` con `--current --direction right --no-focus`... espera: `pane split` no tiene `--no-focus` (help: focus flag no existe en split) — test fija: args exactos `--current --direction right --cwd`; record `targetId = paneId`, close = `herdr pane close`. (b) `topology:"workspace"`: `workspaceCreate` con `--label <name> --no-focus`, record `targetId = workspaceId`, close = `herdr workspace close`. (c) settle de cada topología cierra el target correcto (vía `makeSettleHandler` con record pane/workspace).
- [ ] **P2: FAIL → P3: implementar (rama según topology; default tab) → P4: PASS**
- [ ] **P5: commit** `feat: topologías pane y workspace`

### Tarea 8: worktree opcional (D5)

**Ficheros:**
- Crear: `src/worktree.ts`, `tests/worktree.test.ts`

**Interfaces (Produce):**
```ts
export async function createWorktree(run: RunFn, o: { repo: string; name: string }): Promise<{ dir: string; branch: string }>;
// branch hd/<name> desde HEAD; dir = <parent>/.hd-worktrees/<name>; throw si no es repo git o dir existe
export type CleanupDecision = { action: "remove" } | { action: "keep"; reason: "dirty" | "unmerged" };
export function decideCleanup(statusPorcelain: string, mergedIntoHead: boolean): CleanupDecision; // PURE
export async function cleanupWorktree(run: RunFn, o: { repo: string; dir: string; branch: string }): Promise<{ removed: boolean; reason?: string }>;
```
- Modificar: `src/dispatch.ts` — `worktree:true` → validar git ANTES de crear nada (spec D7), crear worktree, `cwd` del agente = worktree dir, `worktreePath` en resultado.

- [ ] **P1: test que falla** — `decideCleanup("", true)` → remove; `decideCleanup(" M src/x.ts", true)` → keep/dirty; `decideCleanup("", false)` → keep/unmerged (foco de revisión 3). `createWorktree` con mock: args de git `worktree add -b hd/<name> <dir>`; dir existente → throw; no-git (rev-parse falla) → throw ANTES de crear tab (test de dispatch: secuencia aborta en la 1ª llamada). `cleanupWorktree` remove: `git worktree remove` + `git branch -d` (NUNCA `-D`); keep: NO toca git, reporta dir+branch.
- [ ] **P2: FAIL → P3: implementar → P4: PASS**
- [ ] **P5: commit** `feat: worktree opcional con cleanup conservador`

### Tarea 9: registry persistente + herdr_agents + re-arm (D6)

**Ficheros:**
- Crear: `src/registry.ts`, `tests/registry.test.ts`
- Modificar: `src/dispatch.ts` (añadir `listDispatches`), `tests/dispatch.test.ts`

**Interfaces (Produce):**
```ts
export interface DispatchRecord { agent: string; taskId: string; topology: "tab" | "pane" | "workspace"; targetId: string; paneId: string; cwd: string; worktree?: { dir: string; branch: string }; keepOpen: boolean; createdAt: number; status: "live" | "closed" }
export interface RegistryHost { appendEntry(entry: object): void; sessionManager: { getBranch(): { entries: unknown[] } } } // subconjunto de pi
export class Registry {
  constructor(); add(rec: DispatchRecord): void; get(agent: string): DispatchRecord | undefined;
  list(): DispatchRecord[]; markClosed(agent: string): void;
  persist(host: RegistryHost, rec: DispatchRecord): void;          // appendEntry {customType:"herdr-dispatch", record}
  static fromEntries(entries: unknown[]): Registry;                 // filtra customType + SOLO rama activa (entries de la rama ya vienen de getBranch)
}
export async function reconcile(deps: { run: RunFn; registry: Registry; arm: typeof armWatcher; cleanupWorktree: typeof cleanupWorktree; emit: WatchDeps["emit"] }): Promise<string[]>;
// vs agentList: record live + agente vivo → re-arm; record live + agente muerto → markClosed + cleanupWorktree si pendiente (una vez)
```

- [ ] **P1: test que falla** — `fromEntries`: mezcla entries herdr-dispatch + ajenas → solo propias; record `closed` de rama abandonada no revive (spec D6). `reconcile` con mock: (a) record live + name en agentList → `arm` llamado con ese name (foco de revisión 4); (b) record live + name ausente + worktree pendiente → `markClosed` + `cleanupWorktree` UNA vez; (c) segunda `reconcile` sobre ya-closed → no vuelve a limpiar. `listDispatches` → líneas legibles por agente.
- [ ] **P2: FAIL → P3: implementar → P4: PASS**
- [ ] **P5: commit** `feat: registry persistente con reconcile y re-arm`

### Tarea 10: index.ts wiring + shutdown idempotente + empaquetado

**Ficheros:**
- Crear: `index.ts`, `tests/index.test.ts`, `README.md`
- Modificar: `package.json` (campo `pi.extensions`), `tsconfig.json` si falta

**Interfaces:**
- Consume: todas las anteriores. Produce: extensión cargable.

- [ ] **P1: test que falla** — `shutdownCleanup(deps, registry)`: (a) 2 records live → closeTarget de cada uno + cleanup de worktrees pendientes; (b) segundo `shutdownCleanup` (records ya closed) → CERO llamadas (foco de revisión 6); (c) close que falla (mock error) → sigue con los demás y reporta. Schema de `herdr_dispatch` (TypeBox): `task` requerido, enum topology, defaults documentados en descriptions.
- [ ] **P2: FAIL → P3: implementar `index.ts`** — factory: registra 5 tools (execute fino → funciones de tareas previas), `session_start`: `Registry.fromEntries(branch)` + `reconcile`; `session_shutdown`: `shutdownCleanup` idempotente. README con install (`pi install github:kcurtet/pi-herdr`), tabla de tools, ejemplo.
- [ ] **P4: PASS + typecheck** — `npx tsc --noEmit` limpio.
- [ ] **P5: smoke de carga** — `pi --extension . -m gemma4:latest -p "responde solo: ok"` → sin errores de extensión (lección: PI_HOME real carga settings; errores de load saltan aquí).
- [ ] **P6: smoke vivo (manual, dentro de herdr)** — `herdr_dispatch` con task trivial → tab nueva, evento settle, tab cerrada. Registrar resultado en `progress.md`.
- [ ] **P7: commit** `feat: wiring completo, shutdown idempotente, empaquetado`

## Auto-revisión

- **Cobertura:** R1→T4, R2→T3/T5, R3→T5, R4→T6, R5→T8, R6→T8, R7→T1/T4, R8→T10, R9→T9, R10→T9, R11→T7. Todos los casos límite de la spec tienen test (name dup T2, no-git T8, gone T5, shutdown doble T10, task vacía T4, slug largo T2, agent_busy/blocked T6).
- **Consistencia:** `RunFn` idéntica T1↔todas; `WatchEvent` T3↔T5/T9; `DispatchRecord` T9 usado por T4/T5/T10; `cleanupWorktree` firma T8 = inyectada en T5/T9/T10.
- **Proporción:** el plan fija firmas, args exactos y aserciones; los cuerpos son del implementador.
