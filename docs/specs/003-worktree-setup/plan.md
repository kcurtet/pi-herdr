# Plan de implementación: Spec 003 — comando de preparación del worktree (setup)

> Ejecutar con la skill `executing-plans`, tarea a tarea. Pasos con checkbox `- [ ]`.

**Objetivo:** `herdr_dispatch` con `worktree: true` ejecuta un comando de setup (auto-detectado por lockfile o explícito) en el worktree recién creado, antes de crear tab; fallo = abort + rollback conservador.

**Arquitectura:** módulo nuevo `src/setup.ts` (parse de modos + detección puras, ejecución con mutex en-proceso) consumido por `dispatch.ts` entre `createWorktree` y la topología. Seam `RunFn` existente; `localRun` gana output adjunto en timeout. Sin cambios de config (`/herdr` queda en 6 keys).

**Stack:** TypeScript ESM, typebox (schema), vitest. Run: `npx vitest run` / `npm run typecheck`.

**Spec:** `docs/specs/003-worktree-setup/spec.md`

## Restricciones globales

- Detección en la RAÍZ del repo (`git rev-parse --show-toplevel`), no en el cwd literal del dispatch.
- Prioridad lockfiles: `pnpm-lock.yaml` > `bun.lock`/`bun.lockb` > `yarn.lock` > `package-lock.json`.
- Mapa fijo: pnpm → `pnpm install --frozen-lockfile`, bun → `bun install`, yarn → `yarn install --immutable`, npm → `npm ci`.
- Modos case-sensitive: omitido/`"auto"` = detección, `"none"` = sin setup, `""` = error, cualquier otro string = literal vía `bash -c`.
- `setupCommand` explícito (`"auto"` o literal) + `worktree` efectivo `false` → error temprano; `"none"`/omitido + false → no-op.
- Ejecución: `bash -c <cmd>` con cwd = worktree dir, `timeoutMs` 600 000, oculta, tras `createWorktree` y ANTES de topología.
- Fallo (exit != 0 o timeout) → abort: rollback con `cleanupWorktree` conservador (sin `closeTarget`, aún no hay topología), error con comando + motivo + tail (stderr || stdout, últimos ~2000 chars).
- Mutex en-proceso serializa `runSetup` entre dispatches; el fallo del primero no afecta al segundo.
- Cero regresión: dispatch worktree sin lockfiles conocidos solo es posible pasando `"none"` (error con hint si no).

## Foco de revisión

1. Detección contra cwd literal (monorepo con lockfile en raíz y dispatch desde subdir) → T2/T4 tests.
2. Rollback de setup pierde la política conservadora (borra dirty) → T5 test dirty→keep.
3. Timeout descarta la salida (tail vacío) → T1/T3 tests.
4. Mutex no liberado en fallo (segundo dispatch muere esperando) → T3 test fallo-no-propaga.
5. Setup después de crear tab (tab huérfana si falla) → T4 test de orden de llamadas.

## Tarea 1: `localRun` preserva salida en timeout

**Ficheros:**
- Modificar: `src/herdr.ts` (bloque `if (e.killed)` de `localRun`)
- Test: `tests/herdr.test.ts`

**Interfaces:**
- Produce: el `Error` que `localRun` lanza por timeout lleva `stdout`/`stderr` (parcial, strings posiblemente vacíos) como propiedades propias. Tarea 3 las lee.

- [ ] **Paso 1: test que falla** — en `tests/herdr.test.ts`, describe `localRun`:

```ts
describe("localRun timeout", () => {
	it("adjunta stdout parcial al Error de timeout", async () => {
		const err = await localRun(
			"node", ["-e", "console.log('pre-kill'); setTimeout(() => {}, 5000)"],
			{ timeoutMs: 150 },
		).catch((e) => e);
		expect(err).toBeInstanceOf(Error);
		expect(err.message).toMatch(/timeout/);
		expect(err.stdout).toContain("pre-kill");
	});
});
```

- [ ] **Paso 2: Run** `npx vitest run tests/herdr.test.ts`
      Expected: FAIL — `err.stdout` es undefined.
- [ ] **Paso 3: implementar** — en el catch de `localRun`, rama `e.killed`: crear el Error actual y asignarle `(err as Error & { stdout?: string; stderr?: string }).stdout = e.stdout ?? ""` (ídem stderr) antes de throw. Mensaje inalterado.
- [ ] **Paso 4: Run** `npx vitest run tests/herdr.test.ts` → verde (los existentes incluidos).
- [ ] **Paso 5: commit** `refactor(herdr): localRun adjunta stdout/stderr parciales al Error de timeout`

## Tarea 2: `src/setup.ts` — modos y detección (puras)

**Ficheros:**
- Crear: `src/setup.ts`
- Modificar: `src/worktree.ts` (extraer `resolveRepoRoot`; `createWorktree` la usa)
- Test: `tests/setup.test.ts` (nuevo), `tests/worktree.test.ts` (sin cambios: verde)

**Interfaces:**
- Produce (usa Tarea 3 y 4):

```ts
export type SetupMode = { kind: "none" } | { kind: "auto" } | { kind: "literal"; command: string };
export type ExistsFn = (path: string) => boolean;
export function parseSetupMode(setupCommand: string | undefined, worktree: boolean): SetupMode;
export function detectSetupCommand(repoRoot: string, exists?: ExistsFn): string | undefined;
export const LOCKFILE_COMMANDS: readonly { readonly file: string; readonly command: string }[]; // orden = prioridad
```

`worktree.ts`: `export async function resolveRepoRoot(run: RunFn, repo: string): Promise<string>` (extrae el `rev-parse --show-toplevel` de `createWorktree`, mismo error `"no es un repo git (worktree:true lo requiere)"`).

- [ ] **Paso 1: tests que fallan** (`tests/setup.test.ts`) — con tmpdirs reales + `existsSync` por defecto:

```ts
// parseSetupMode
parseSetupMode(undefined, true)          // → { kind: "auto" }
parseSetupMode("auto", true)             // → { kind: "auto" }
parseSetupMode("none", true)             // → { kind: "none" }
parseSetupMode("npm install && build", true) // → { kind: "literal", command: "npm install && build" }
parseSetupMode("", true)                 // → throw /no válido/
parseSetupMode("npm ci", false)          // → throw /worktree/
parseSetupMode("auto", false)            // → throw /worktree/
parseSetupMode("none", false)            // → { kind: "none" }
parseSetupMode(undefined, false)         // → { kind: "none" }
parseSetupMode("NONE", true)             // → literal "NONE" (case-sensitive)
// detectSetupCommand: repo con pnpm-lock.yaml + package-lock.json → "pnpm install --frozen-lockfile"
// solo package-lock.json → "npm ci"; bun.lock y bun.lockb → "bun install"; yarn.lock → "yarn install --immutable"
// vacío → undefined
```

- [ ] **Paso 2: Run** `npx vitest run tests/setup.test.ts` → FAIL (módulo no existe).
- [ ] **Paso 3: implementar** `LOCKFILE_COMMANDS` (array en orden de prioridad, `bun.lock` y `bun.lockb` ambos → `bun install`), `parseSetupMode` y `detectSetupCommand` (primer match por orden de array; `existsSync` default). Extraer `resolveRepoRoot` en `worktree.ts`.
- [ ] **Paso 4: Run** `npx vitest run tests/setup.test.ts tests/worktree.test.ts` → verde.
- [ ] **Paso 5: commit** `feat(setup): modos de setupCommand y detección por lockfile (puras)`

## Tarea 3: `src/setup.ts` — ejecución serializada con tail

**Ficheros:**
- Modificar: `src/setup.ts`
- Test: `tests/setup.test.ts`

**Interfaces:**
- Consume: `RunFn` (`src/herdr.ts`), output adjunto de Tarea 1.
- Produce (usa Tarea 4):

```ts
export const SETUP_TIMEOUT_MS = 600_000;
export function serializeSetup<T>(fn: () => Promise<T>): Promise<T>;
export async function runSetup(
	run: RunFn,
	o: { command: string; cwd: string; timeoutMs?: number }, // default SETUP_TIMEOUT_MS (test usa 100)
): Promise<{ elapsedMs: number }>;
```

- [ ] **Paso 1: tests que fallan:**
  - `runSetup` éxito: fakeRun ruta `"bash -c"` → code 0; assert call exacta `{ file: "bash", args: ["-c", "pnpm install --frozen-lockfile"], opts: { cwd: "/w", timeoutMs: 100 } }` (con `timeoutMs: 100` inyectado); `elapsedMs >= 0`.
  - Fallo exit 1 con `stderr: "EFAIL"` largo (> 2000 chars con relleno) → throw cuyo message contiene `"pnpm install"`, `exit 1` y SOLO el tail (últimos ~2000 chars, assert que el relleno inicial NO está y el final sí).
  - Fallo exit 1 con stderr vacía y stdout con texto → tail desde stdout.
  - Timeout real: `run = localRun`, command `"node -e \"console.log('lento'); setTimeout(()=>{},5000)\""` con `timeoutMs: 150` → throw con `lento` en el tail (vía output adjunto de T1).
  - `serializeSetup`: dos fns con deferreds manuales; la segunda NO arranca hasta resolver la primera; si la primera RECHAZA, la segunda ejecuta igual y resuelve.
- [ ] **Paso 2: Run** `npx vitest run tests/setup.test.ts` → FAIL.
- [ ] **Paso 3: implementar** — `serializeSetup` con promise chain módulo-level (`queue = next.catch(() => undefined)`); `runSetup` la envuelve: `run("bash", ["-c", o.command], { cwd: o.cwd, timeoutMs: o.timeoutMs ?? SETUP_TIMEOUT_MS })`; code !== 0 → throw `pi-herdr: setup "${cmd}" falló (exit N)\n${tail}`; catch del throw de timeout de `RunFn` → mismo error con motivo `timeout` y tail de `err.stdout/err.stderr`. Tail: `(stderr.trim() || stdout.trim())`, slice últimos 2000 chars.
- [ ] **Paso 4: Run** `npx vitest run tests/setup.test.ts` → verde.
- [ ] **Paso 5: commit** `feat(setup): runSetup serializado con timeout 10min y tail de salida en fallo`

## Tarea 4: wiring en dispatch + schema + visibilidad

**Ficheros:**
- Modificar: `src/dispatch.ts`, `src/registry.ts` (`DispatchRecord.setupCommand?: string`), `index.ts` (schema `DispatchParams` + description), `README.md` (fila de params de `herdr_dispatch` + sección Worktree)
- Test: `tests/dispatch.test.ts`

**Interfaces:**
- Consume: `parseSetupMode`, `detectSetupCommand`, `resolveRepoRoot`, `runSetup` (T2/T3); `DispatchInput` gana `setupCommand?: string`; `DispatchResult` gana `setupNote?: string`.
- Produce: `herdr_dispatch` completo con setup (happy path y validaciones; el fallo de setup es Tarea 5).

- [ ] **Paso 1: tests que fallan** (`tests/dispatch.test.ts`, patrón existente: tmpdir repo real con lockfiles + fakeRun que enruta `git -C ... rev-parse` → repoRoot, `worktree add` → ok, `bash -c` → ok):
  - Auto con prioridad: repo con `pnpm-lock.yaml` + `package-lock.json`, `dispatch({ task, worktree: true, setupCommand: undefined })` → result.setupNote ≈ /setup OK \(pnpm install --frozen-lockfile, \d+s\)/; record.setupCommand = `"pnpm install --frozen-lockfile"` visible en `listDispatches`.
  - Orden de llamadas: `bash -c` ANTES de `tab create` (focus de revisión 5).
  - Monorepo: cwd = `<repo>/packages/x` con lockfile en `<repo>/` → detección funciona (rev-parse devuelve raíz).
  - Explícito: `setupCommand: "npm install"` → corre ese, ignora lockfiles.
  - `"none"` → sin llamada `bash -c`, sin note (behavior actual).
  - Sin lockfiles + auto → throw listando los 5 ficheros buscados + hint `"none"`; CERO side effects: ninguna llamada `worktree add` ni `tab create`.
  - `""` → throw /no válido/, cero side effects.
  - `setupCommand: "npm ci"` + worktree false efectivo → throw /worktree/; `"none"` + false → dispatch normal sin error.
  - Omitido + worktree false → dispatch normal (regresión: no error).
- [ ] **Paso 2: Run** `npx vitest run tests/dispatch.test.ts` → FAIL.
- [ ] **Paso 3: implementar** — en `dispatch()`:
  1. Tras el merge de config: `const setupMode = parseSetupMode(input.setupCommand, effective.worktree === true)` (throw temprano puro).
  2. Si `effective.worktree`: `const repoRoot = await resolveRepoRoot(deps.run, cwd)`; si `setupMode.kind === "auto"`: `const cmd = detectSetupCommand(repoRoot) ?? throw` (mensaje con `LOCKFILE_COMMANDS.map(c => c.file)` + hint `"none"`). Si no worktree: cmd = undefined.
  3. `createWorktree` (sin cambios; su rev-parse interno se queda).
  4. Si cmd: `const { elapsedMs } = await runSetup(deps.run, { command: cmd, cwd: worktree.dir })` (el fallo lo captura Tarea 5); `setupNote = \`setup OK (${cmd}, ${Math.round(elapsedMs/1000)}s)\``.
  5. `DispatchRecord` + `setupCommand: cmd`; `DispatchResult` + `setupNote`; `dispatchReport` añade la nota; `listDispatches` añade `setup ${cmd}` si existe.
  6. Schema en `index.ts`: `setupCommand: Type.Optional(Type.String({ description: ... }))` con la semántica completa (auto/none/literal, 10 min, fallo aborta). README actualizado.
- [ ] **Paso 4: Run** `npx vitest run` completo + `npm run typecheck` → verde.
- [ ] **Paso 5: commit** `feat(dispatch): setupCommand — preparación del worktree antes del agente (auto/none/literal)`

## Tarea 5: fallo de setup → abort + rollback conservador

**Ficheros:**
- Modificar: `src/dispatch.ts` (catch alrededor de `runSetup`)
- Test: `tests/dispatch.test.ts`

**Interfaces:**
- Consume: `cleanupWorktree` (patrón del catch de `agentStart` existente), error con tail de T3.
- Produce: semántica D4 completa; spec 003 cerrada.

- [ ] **Paso 1: tests que fallan:**
  - `bash -c` → code 1 con stderr `"EFAIL tail"` → throw con /EFAIL tail/, /exit 1/ y el comando; NINGUNA llamada `tab create`/`agent start`; rollback: `worktree remove` + `branch -d` llamados con el dir del worktree.
  - Rollback conservador: status dirty (route `status` devuelve ` M x`) → throw con /CONSERVADO/ y SIN `worktree remove`.
- [ ] **Paso 2: Run** `npx vitest run tests/dispatch.test.ts` → FAIL.
- [ ] **Paso 3: implementar** — envolver el bloque setup+topología+agentStart: catch de `runSetup` (reconocible porque aún no hay topología) → `cleanupWorktree(deps.run, worktree)` best-effort, message `${orig.message}${note}` con el mismo formato de nota del rollback existente (`worktree ${dir} eliminado en rollback` / `CONSERVADO: ${reason}`). Sin `closeTarget`.
- [ ] **Paso 4: Run** `npx vitest run` completo + `npm run typecheck` → verde.
- [ ] **Paso 5: commit** `feat(dispatch): fallo de setup aborta el dispatch con rollback conservador del worktree`

## Cobertura spec → tareas

R1 T4 · R2 T4 · R3 T4 · R4 T4 · R5 T4 · R6 T3+T5 · R7 T4 · R8 T2+T3 · R9 T2 · R10 T3 · foco 1 T2/T4 · foco 2 T5 · foco 3 T1/T3 · foco 4 T3 · foco 5 T4
