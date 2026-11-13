# Plan de implementación: Agent board (spec 007)

> Ejecutar con la skill `executing-plans`, tarea a tarea. Pasos con checkbox `- [ ]`.

**Objetivo:** Board persistente en la UI de pi (widget sobre el editor) con el estado de los subagentes despachados por la sesión, actualizado por eventos + tick 30s, con toast en `blocked`.

**Arquitectura:** Módulo nuevo `src/board.ts` (estado display + composición pura + componente) colgado como consumidor pasivo de los embudos existentes: `dispatch.ts` tras `registry.add`, el `emit` de `index.ts`, y `session_start`/`session_shutdown`. El registry gana `task`/`kind` opcionales persistidos. El guard de modo es `ctx.mode === "tui"` en el call-site, nunca `hasUI`.

**Stack:** TypeScript ESM, vitest, APIs de pi 1.5.2 (`setWidget` con componente custom, `notify`), helpers de pi-tui (`visibleWidth`, `truncateToWidth`).

**Spec:** `docs/specs/007-agent-board/spec.md` — el plan argumenta desde ella (D1–D11, R1–R15).

## Restricciones globales

- Board es cosmético y no-throw: ningún método público de `Board` puede lanzar (R14); fallos internos se tragan.
- Guard de modo: `ctx.mode === "tui"` decidido en `index.ts`; `Board` recibe `ui: BoardUi | undefined` (D7/R11). Jamás `hasUI`.
- Sin timer con board vacío o desactivado; `unref()` del interval; limpieza total en `session_shutdown` (D4/R12).
- Anchos SIEMPRE con `visibleWidth`/`truncateToWidth` de pi-tui, jamás `string.length` (D3).
- Tabla de transiciones del tick = D10, literal (ver T2); eventos del watcher pisan al tick.
- Elapsed = tiempo en el estado actual; `since` resetea en cada transición (D11).
- Cap 5 líneas + `+k más`, orden por `createdAt` (D8).
- `ctx.mode`/UI nunca se tocan en el cuerpo de la factory de la extensión — solo desde handlers (hecho 3 de la spec).

## Foco de revisión

1. **RPC/headless encendido por accidente** (`hasUI` en vez de `ctx.mode`) → T4 test: `start(undefined)` no llama `setWidget`/`notify` ni arranca timer.
2. **Tick pisa STRANDED/INTERRUPTED** → T2/T5 tests de `applyTickStatus` y del tick con status reject.
3. **Timer zombie** (board vacío) → T4 test: refresh con 0 live limpia widget y para el interval.
4. **Fuga de excepción del board hacia emit/dispatch** → T4 test: `status()` que rejectea no rompe `tick`; `onEvent` con ui que lanza no propaga.
5. **Desborde de width / ANSI mal medido** → T3 tests de degradado incluyendo floor y name truncado.

---

### Tarea 1: `task`/`kind` persisten en el DispatchRecord (D9, R15)

**Ficheros:**
- Modificar: `src/registry.ts` (interface `DispatchRecord`, ~línea 25)
- Modificar: `src/dispatch.ts` (~350, construcción del `rec`)
- Test: `tests/registry.test.ts`, `tests/dispatch.test.ts`

**Interfaces:**
- Produce: `DispatchRecord` gana `task?: string` y `kind?: string`. T4 consume `rec.task`/`rec.kind`/`rec.worktree?.branch` para pintar.

- [ ] **Paso 1: test que falla** — en `tests/dispatch.test.ts`: dispatch exitoso → el record en un Registry real (patrón `makeDeps` del repo, sin fake) contiene `task` (texto completo) y `kind` (el effective). En `tests/registry.test.ts`: `fromEntries` con entry `herdr-dispatch-record` QUE CONTIENE `task`/`kind` los reconstruye; entry SIN ellos (pre-007) reconstruye igualmente sin error.
- [ ] **Paso 2: ejecutar y verificar fallo**
Run: `npx vitest run tests/registry.test.ts tests/dispatch.test.ts`
Expected: FAIL — propiedades ausentes.
- [ ] **Paso 3: implementar** — campos opcionales en `DispatchRecord`; en `dispatch.ts` setear `task` (el `task` ya trimado del input) y `kind: effective.kind` en el objeto `rec`. `appendEntry` ya persiste por spread; `fromEntries` ya castea tolerante — sin cambios ahí.
- [ ] **Paso 4: ejecutar y verificar pase** (mismo Run, PASS; suite completa `npm test` verde)
- [ ] **Paso 5: commit** `feat(registry): task/kind persisten en el DispatchRecord — spec 007 D9`

### Tarea 2: máquina de estados pura del board (D2, D10, D11)

**Ficheros:**
- Crear: `src/board.ts`
- Test: `tests/board.test.ts`

**Interfaces:**
- Produce (firmas exactas, usadas por T3–T6):

```ts
export type BoardDisplay = "working" | "blocked" | "idle" | "interrupted" | "stranded";
export type EventKind = "blocked" | "settled" | "interrupted" | "stranded" | "gone";

/** undefined = el evento no fija display (settled sin keepOpen / gone: el close inminente despuebla). */
export function displayFromEvent(kind: EventKind, keepOpen?: boolean): BoardDisplay | undefined;

/** Tabla D10: stranded intocable; interrupted solo se levanta a working; watcher-alive reconcilia libre. */
export function applyTickStatus(current: BoardDisplay, agentStatus: string): BoardDisplay;

/** D11: "0m", "12m", "1h04m". */
export function formatElapsed(ms: number): string;
```

- [ ] **Paso 1: test que falla** — tabla completa: `displayFromEvent` (5 kinds × keepOpen); `applyTickStatus`: `("stranded", "working") → "stranded"`, `("interrupted","working") → "working"`, `("interrupted","idle") → "interrupted"`, `("working","blocked") → "blocked"`, `("idle","working") → "working"`, `("working","done") → "idle"`, `("working","unknown") → "working"`; `formatElapsed`: 0→"0m", 59_999→"0m", 12m→"12m", 64m→"1h04m".
- [ ] **Paso 2: ejecutar y verificar fallo**
Run: `npx vitest run tests/board.test.ts`
Expected: FAIL — módulo sin funciones.
- [ ] **Paso 3: implementar** las tres funciones puras en `src/board.ts`.
- [ ] **Paso 4: ejecutar y verificar pase**
- [ ] **Paso 5: commit** `feat(board): displayFromEvent + applyTickStatus (tabla D10) + formatElapsed`

### Tarea 3: composición de líneas (D3, D8, R8, R9)

**Ficheros:**
- Modificar: `src/board.ts`
- Test: `tests/board.test.ts`

**Interfaces:**
- Consume: `BoardDisplay`, `formatElapsed` (T2).
- Produce:

```ts
export interface BoardLine {
	name: string;
	display: BoardDisplay;
	since: number;      // epoch ms de la última transición (D11)
	kind?: string;      // del record (D9)
	branch?: string;    // worktree.branch, solo si hay worktree
	task?: string;      // texto completo, se trunca al pintar
}

/** Línea degradante: task → branch → kind → elapsed; suelo `name · STATUS` (name truncado al final). */
export function composeLine(line: BoardLine, width: number, now: number, paint?: (status: BoardDisplay, text: string) => string): string;

/** Cap: maxLines líneas + `+k más`; espera lines ya ordenadas por createdAt. */
export function composeBoard(lines: BoardLine[], width: number, now: number, maxLines: number, paint?): string[];
```

- [ ] **Paso 1: test que falla** — degradado con width decreciente (línea completa `name · WORKING 12m · pi · hd/fix · task...` → sin task → sin branch → sin kind → sin elapsed → suelo `name · WORKING`); width menor que el suelo trunca el name y JAMÁS excede `width` (aserción con `visibleWidth`); 7 lines con maxLines 5 → 5 + `+2 más`; `paint` (default identidad) recibe el segmento STATUS.
- [ ] **Paso 2: ejecutar y verificar fallo**
Run: `npx vitest run tests/board.test.ts`
Expected: FAIL — funciones ausentes.
- [ ] **Paso 3: implementar** con `visibleWidth`/`truncateToWidth` de `@earendil-works/pi-tui`. El segmento STATUS es `display.toUpperCase()`; `line.branch` se muestra TAL CUAL — ya viene como `hd/<name>` (worktree.ts:50): NO anteponer `hd/` (sería doble prefijo). Declarar `@earendil-works/pi-tui` en devDependencies con la versión ya instalada (`npm ls @earendil-works/pi-tui`); hoy es solo dependencia transitiva.
- [ ] **Paso 4: ejecutar y verificar pase**
- [ ] **Paso 5: commit** `feat(board): composeLine degradante por width + composeBoard con cap`

### Tarea 4: clase Board + componente + wiring (D1, D3, D4, D5, D7; R1–R6, R11–R14)

**Ficheros:**
- Modificar: `src/board.ts` (clase `Board`, `BoardComponent`)
- Modificar: `src/dispatch.ts` (`DispatchDeps` gana seam opcional)
- Modificar: `index.ts` (session_start reconcile, `emit`, herdr_stop, session_shutdown)
- Test: `tests/board.test.ts`, `tests/index.test.ts`

**Interfaces:**
- Consume: T1–T3.
- Produce (firmas exactas):

```ts
export const WIDGET_ID = "herdr-board";

export interface BoardUi {
	setWidget(id: string, content: unknown, opts?: { placement?: string }): void;
	notify(msg: string, level: "info" | "warning" | "error"): void;
}

/** Subset que dispatch.ts necesita — Board lo implementa. */
export interface BoardEvents {
	onDispatched(rec: DispatchRecord): void;
	onEvent(agent: string, kind: EventKind, keepOpen?: boolean): void;
	refresh(): void;
}

export interface BoardDeps {
	registry: Registry;
	status: (agent: string) => Promise<string | undefined>; // DERIVADO de safeAgentStatus (ver wiring)
	now?: () => number;        // default Date.now (seam de tests)
	intervalMs?: number;       // default 30_000
	maxLines?: number;         // default 5
}

export class Board implements BoardEvents {
	constructor(deps: BoardDeps);
	start(ui: BoardUi | undefined): void;  // ui===undefined => desactivado (modo guard en el call-site)
	setEnabled(on: boolean): void;
	onDispatched(rec: DispatchRecord): void;  // entry WORKING + refresh
	onEvent(agent: string, kind: EventKind, keepOpen?: boolean): void; // displayFromEvent + toast si blocked + refresh
	refresh(): void;   // membresía = records live; render o clear; timer on/off
	tick(): Promise<void>;
	dispose(): void;   // timer off + clear widget
}

export class BoardComponent {
	constructor(lines: () => BoardLine[], now: () => number, paint?: (status: BoardDisplay, text: string) => string);
	render(width: number): string[];  // cache por (width, versión); composeBoard
	invalidate(): void;
}
```

- Wiring exacto en `index.ts`: al FINAL del handler `session_start` de reconcile, tras el try/catch, INCONDICIONAL (sesiones frescas sin entries restaurados también arrancan el board; un fallo de reconcile no lo salta): `board.start(ctx?.mode === "tui" ? (ctx?.ui as BoardUi | undefined) : undefined)` seguido de `void board.tick()`. En `emit`, `board.onEvent(details.agent as EventKind-arg..., details.kind, details.keepOpen)` con guard `typeof details.agent === "string"`; en el handler de `herdr_stop` tras éxito, `board.refresh()`; en `session_shutdown`, `board.dispose()`. `dispatch.ts`: `DispatchDeps` gana `board?: BoardEvents` y llama `deps.board?.onDispatched(rec)` justo tras `deps.registry.add(rec)`. El `status` del Board en index.ts es un adaptador EXPLÍCITO: `status: async (a) => (await safeAgentStatus(run, a)).status` — `safeAgentStatus` devuelve `{ status?, error? }` (herdr.ts:212); pasarla parcializada cruda rompe el reconcile en silencio.
- **No-throw (R14):** todo método público de `Board` envuelve su cuerpo en try/catch silencioso. `emit` y `dispatch` no añaden sus propios try/catch — la garantía vive en `Board`. `tick()` es no-op cuando el board está desactivado o sin `ui` (R11: un resume headless jamás lanza `herdr agent get`).
- Toast (D5): `ui.notify(\`herdr: ${agent} BLOCKED — decisión pendiente en su pane\`, "warning")` — solo con `ui` activo.
- Componente (D3): el registro del widget lo decide `refresh()` cuando hay ≥1 línea (`start()` con 0 líneas NO registra un widget vacío sobre el editor) — UNA vez por período no-vacío: tras un clear (board vaciado o `setEnabled(false)`) y reaparición de líneas (o re-enable), re-registrar; entre renders del mismo período solo `tui.requestRender()` vía seam capturada en la factory. `ui.setWidget(WIDGET_ID, (tui, theme) => new BoardComponent(...))` con `paint` productivo que colorea STATUS con `theme.fg` (accent=working, warning=blocked, dim=idle, error=interrupted/stranded), re-aplicado por línea.

- [ ] **Paso 1: test que falla** — con fake ui (recorder), fake registry, `now` inyectado, `intervalMs` corto: (a) `onDispatched` → `setWidget` llamado + la línea `WORKING 0m` aparece en `render(80)` del componente; (b) `onEvent("a","blocked")` → display BLOCKED + UN `notify` warning; (c) record closed + `refresh()` → línea fuera; último live → `setWidget(WIDGET_ID, undefined)` y timer parado; (d) `start(undefined)` → nada de setWidget/notify/timer (R11); (e) `dispose()` → clear + timer off; (f) `onEvent` con ui que lanza → no propaga (R14); (g) tras vaciar el board (todos closed) y re-despachar, el widget se RE-registra y vuelve a pintar. En `tests/index.test.ts`: wiring del `emit` y del seam `board` de dispatch (fakes grabados, patrón helpers del repo).
- [ ] **Paso 2: ejecutar y verificar fallo**
Run: `npx vitest run tests/board.test.ts tests/index.test.ts`
Expected: FAIL — clase ausente.
- [ ] **Paso 3: implementar** `Board` + `BoardComponent` + wiring según Interfaces.
- [ ] **Paso 4: ejecutar y verificar pase** + `npm test` completo verde + `npm run typecheck`.
- [ ] **Paso 5: commit** `feat(board): clase Board + componente + wiring en dispatch/emit/shutdown`

### Tarea 5: tick reconciler de verdad (D4 segunda mitad, D10; R6, R7, R13)

**Ficheros:**
- Modificar: `src/board.ts` (`tick`, `start`)
- Test: `tests/board.test.ts`

**Interfaces:**
- Consume: `applyTickStatus` (T2), `BoardDeps.status`, `Promise.allSettled`.
- Produce: `tick()` final (firmado en T4): por cada record live, `deps.status(agent)` (best-effort); resultado aplicado SOLO vía `applyTickStatus`; cambio de display resetea `since`; luego `refresh()`.

- [ ] **Paso 1: test que falla** — (a) entry `idle` + `status` devuelve `"working"` → tras `tick()` display `working` y `since` reseteado (R7, prompt manual sin evento); (b) entry `stranded` + `status` devuelve `"working"` → sigue `stranded` (R6/D10); (c) `status` rejectea → mantiene último display, `tick()` no lanza (R14); (d) timer con `intervalMs` corto dispara `tick()` automáticamente con ≥1 live y NO con 0.
- [ ] **Paso 2: ejecutar y verificar fallo**
Run: `npx vitest run tests/board.test.ts`
Expected: FAIL — tick sin reconcile.
- [ ] **Paso 3: implementar**. El tick inmediato de arranque lo dispara el wiring de T4 (`void board.tick()` tras `start()`): UN solo tick de arranque — NO duplicarlo también dentro de `start()`.
- [ ] **Paso 4: ejecutar y verificar pase** + suite completa.
- [ ] **Paso 5: commit** `feat(board): tick 30s reconcilia estado real via safeAgentStatus (tabla D10)`

### Tarea 6: config `board` + apagado en caliente (D6; R10)

**Ficheros:**
- Modificar: `src/config.ts` (`DispatchDefaults`, `ResolvedDefaults`, `BUILTIN`, validador)
- Modificar: `src/command.ts` (`CONFIG_KEYS`, `VALUE_SPECS`, `CommandDeps`)
- Modificar: `index.ts` (leer config en session_start, pasar `onBoardChange`)
- Test: `tests/config.test.ts`, `tests/command.test.ts`

**Interfaces:**
- Produce: `DispatchDefaults.board?: "on" | "off"`; `ResolvedDefaults.board: "on" | "off"`; `BUILTIN.board = "on"`; `VALUE_SPECS.board = { parse: raw => raw === "on" || raw === "off" ? raw : undefined, options: () => ["on", "off"] }`; `CommandDeps` gana `onBoardChange?: (v: "on" | "off") => void` — llamado tras `saveValue("board", ...)` y tras reset (TANTO `/herdr reset board` como el reset total disparan `onBoardChange("on")`). `index.ts`: enabled inicial = `(loadDefaults(configPath).defaults.board ?? "on") === "on"` — ojo: `defaults` es el partial crudo (sin clave en disco es `undefined`); los cambios viajan por `onBoardChange → board.setEnabled`.
- Nota para el implementador: `board` viaja por el pipeline de defaults (aparecerá en `ResolvedDefaults` aunque dispatch no lo consuma) — es la letra de la spec D6; NO lo "arregles" apartando la clave.
- Pins existentes que esta tarea ROMPE y hay que actualizar como parte del Paso 3: `tests/config.test.ts` mergeInput-builtin (el objeto esperado gana `board: "on"`) y `tests/command.test.ts` completions de `config ` (la lista gana `board`).

- [ ] **Paso 1: test que falla** — `loadDefaults`: valor inválido (`board: "si"`) → warning y descarte; builtin `"on"`. `/herdr config board off` → persiste y llama `onBoardChange("off")`; `reset` → `onBoardChange("on")`; wizard lista `board` con opciones `on | off`. `setEnabled(false)` sobre un Board vivo → clear widget + timer off (en board.test.ts).
- [ ] **Paso 2: ejecutar y verificar fallo**
Run: `npx vitest run tests/config.test.ts tests/command.test.ts tests/board.test.ts`
Expected: FAIL — key ausente.
- [ ] **Paso 3: implementar** siguiendo el patrón exacto de `worktree` (parseBool → parseOnOff).
- [ ] **Paso 4: ejecutar y verificar pase** + suite completa.
- [ ] **Paso 5: commit** `feat(config): clave board on|off con efecto inmediato — spec 007 D6`

### Tarea 7: README + verificación final

**Ficheros:**
- Modificar: `README.md` (sección "Agent board": qué muestra, estados, toast, config, solo-TUI)

- [ ] **Paso 1: actualizar README** — línea de ejemplo con degradado, tabla de estados display (origen evento vs tick), `board on|off` en defaults configurables, nota solo-TUI (`ctx.mode === "tui"`).
- [ ] **Paso 2: suite completa + tipos**
Run: `npm test && npm run typecheck`
Expected: todo verde; tests existentes intactos salvo los dos pins actualizados en T6 (mergeInput/completions).
- [ ] **Paso 3: commit** `docs(readme): agent board — estados, degradado por width, config board (spec 007)`

---

## Auto-revisión

- Cobertura: R1(T4) R2(T2/T4) R3–R4(T2/T4) R5(T2/T4) R6(T2/T5) R7(T5) R8(T3) R9(T3) R10(T6) R11(T4) R12(T4) R13(T1/T5) R14(T4/T5) R15(T1). D1(T4) D2(T2) D3(T3/T4) D4(T4/T5) D5(T4) D6(T6) D7(T4) D8(T3) D9(T1) D10(T2/T5) D11(T2/T3).
- Tareas verticales: cada una deja suite verde y algo demoable (T1 persistencia, T2/T3 puras, T4 board vivo en sesión, T5 reconcile, T6 config, T7 docs).
- Firmas congeladas en Interfaces; `BoardEvents`/`BoardUi` son subsets estructurales — index.ts pasa `ctx.ui` sin castear campos extra.
