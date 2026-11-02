# Spec 003 — pi-herdr: comando de preparación del worktree (setup)

## Contexto

Los worktrees de pi-herdr (spec 001, D5) nacen como `git worktree add`: código completo, pero SIN dependencias instaladas. Hoy el agente despachado pierde sus primeros turnos en `npm install` (o lo intenta sin deps y falla), y en 16 GB de RAM dos agentes instalando a la vez compiten por memoria. El orquestador ya sabe qué gestor usa el repo (está en el lockfile); el agente no debería descubrirlo él.

Feature: un comando de preparación que corre en el worktree recién creado, antes de crear tab o arrancar agente — el agente encuentra el repo listo.

Hechos verificados en el repo:
- `dispatch()` ya crea el worktree ANTES de la topología (invariante D7 de spec 001: error temprano, cero side effects) y ya tiene un path de rollback conservador para fallos de `agentStart`.
- Toda ejecución externa pasa por la `RunFn` inyectable (`herdr.ts`), con timeout propio por llamada — seam existente para tests y para el setup.
- La config global (`/herdr`, spec 002) quedó descartada para este param en brainstorming: el default correcto depende del repo, y el repo ya lo declara en su lockfile.

## Intención y por qué

- El agente despachado arranca con el worktree LISTO para trabajar (deps instaladas), sin gastar turnos ni memoria en descubrirlo.
- La decisión "qué comando" la toma el repo (lockfile) por defecto; el caller solo cuando el default no vale.
- Fallo del setup = fallo del dispatch: jamás se despacha un agente a un worktree a medio preparar.

## Objetivos

1. Param `setupCommand?: string` en `herdr_dispatch` con tres modos: auto-detección por lockfile (default), comando explícito, y desactivado.
2. Ejecución oculta desde el padre, en el dir del worktree, con timeout propio y salida capturada.
3. Fallo → abort del dispatch con rollback conservador del worktree (misma política D5 de spec 001: jamás destruir trabajo).
4. Cero regresiones: sin `setupCommand` + sin lockfile conocido el dispatch worktree sigue siendo posible vía escape hatch explícito.
5. Sets de dispatches paralelos jamás se solapan: serialización con mutex en-proceso.

## No-objetivos

- Config global del setup en `/herdr` (v1; se puede añadir luego si molesta).
- Progreso visible del setup (pane, streaming): corre oculto; en error se reporta el tail.
- Reintentos, cache de deps compartida entre worktrees, o setup para dispatches sin worktree.
- Detección de gestores no-JS (cargo, go, mix): el mapa de lockfiles es el de abajo, punto.

## Anti-objetivos

- Jamás ejecutar el setup en el repo del padre: solo en el worktree recién creado.
- Jamás despachar tras un setup fallido "con warning": abort siempre.
- No romper la política conservadora de cleanup por un fallo de setup.

## Decisiones de Implementación

**D1 — Param y modos**: `setupCommand?: string` en `herdr_dispatch`. Tres modos, case-sensitive:
- Omitido o `"auto"` → auto-detección (D2).
- `"none"` → sin setup: behavior idéntico a hoy (escape hatch para repos sin toolchain conocido).
- Cualquier otro string → comando literal, ejecutado con `bash -c <comando>` en el dir del worktree.
- String vacío `""` → error de validación temprano.
- `setupCommand` (modo `"auto"` o comando explícito) con `worktree` efectivo `false` → error temprano (el setup es del worktree; correrlo en el cwd real es un side effect que el caller no pidió). Excepción: `"none"` + `worktree:false` → no-op silencioso ("none" ya significa no hacer nada; errorar sería fricción sin señal).
- Aplica a cualquier `kind` (prepara el worktree, no al agente — sin el gate de skills/extensions de spec 002 D4).

**D2 — Auto-detección por lockfile**: se leen los lockfiles en la RAÍZ del repo padre, resuelta con `git rev-parse --show-toplevel` (la misma resolución que usa `createWorktree`) — no en el cwd literal del dispatch, que puede ser un subdirectorio (monorepos) mientras el agente acaba en la raíz del worktree. Ocurre ANTES de `createWorktree` (mismo HEAD; leer el padre evita crear nada para luego fallar). Mapa:
- `pnpm-lock.yaml` → `pnpm install --frozen-lockfile`
- `bun.lock` o `bun.lockb` → `bun install`
- `yarn.lock` → `yarn install --immutable`
- `package-lock.json` → `npm ci`

Varios lockfiles coexistiendo (típico en repos en transición, como el propio pi-herdr) → prioridad fija: pnpm > bun > yarn > npm (`package-lock.json` el último porque suele ser legacy). Ninguno conocido → error temprano listando los ficheros buscados (con hint de `setupCommand: "none"` si no se quieren deps), CERO side effects (ni worktree ni tab).

**D3 — Ejecución**: tras `createWorktree`, ANTES de crear topología. `bash -c <comando>` con cwd = dir del worktree, vía `RunFn` con timeout propio de 10 minutos (los comandos de control herdr siguen a 15s). Oculto: stdout/stderr capturados; timeout tratado como fallo. Para cumplir el tail de D4 en timeout, la `RunFn` real (`localRun`) adjunta la salida parcial capturada al `Error` que ya lanza por timeout (nuevo campo opcional, sin cambiar su contrato de throw ni los tests existentes).

**D4 — Fallo → abort + rollback**: exit != 0 o timeout → NO se crea tab ni agente; rollback del worktree reutilizando `cleanupWorktree` conservador (dirty → se conserva y se reporta, gate humano — idéntico al fallo de `agentStart` hoy, pero sin close de topología porque aún no existe). El error incluye el comando, el motivo (exit code / timeout) y el tail de la salida (stderr con fallback a stdout, últimos ~2000 chars; en timeout, el output parcial adjunto al Error de D3).

**D5 — Visibilidad**: éxito → el resultado del dispatch y `dispatchReport` llevan nota breve "setup OK (<cmd>, <elapsed>s)". `DispatchRecord` guarda el comando efectivo; `herdr_agents` lo muestra.

**D6 — Serialización de sets paralelos**: mutex en-proceso (promise queue a nivel módulo, proceso único de la extensión → sin deadlocks ni estado en disco): los setups de dispatches concurrentes corren uno tras otro. Efecto aceptado: un dispatch en cola puede ver su llamada bloqueada hasta (espera + timeout propio de 10 min); si el primero falla o expira, el segundo arranca igual (el mutex serializa ejecución, no propaga fallos).

## Queda a criterio del builder

- Módulo (nuevo `setup.ts` vs dentro de `dispatch.ts`); forma exacta de la nota de éxito y del tail; cómo inyectar el timeout de 10 min en `RunFn` (constante vs option); orden y forma de los tests (fake `RunFn` unitarios + un E2E con repo fixture).

## Requisitos

- R1. `worktree: true` sin `setupCommand` en repo con lockfile conocido → setup auto corre en el worktree antes del agente.
- R2. Comando explícito gana sobre la auto-detección.
- R3. `setupCommand: "none"` → dispatch idéntico al behavior actual (sin setup).
- R4. Auto en repo sin lockfile conocido → error temprano, CERO side effects.
- R5. `setupCommand` (auto o explícito) con `worktree: false` → error temprano, CERO side effects. `"none"` + `worktree: false` → no-op.
- R6. Comando falla (exit != 0 o timeout) → no se crea tab, rollback conservador, error con comando + motivo + tail.
- R7. Éxito → nota con elapsed; comando efectivo visible en `herdr_agents`.
- R8. Timeout del setup: 10 minutos, propio, sin tocar el de control herdr.
- R9. Multi-lockfile → prioridad pnpm > bun > yarn > npm.
- R10. Dispatches con setup concurrentes → los setups se ejecutan serializados (mutex en-proceso); un fallo del primero no cancela al segundo.

## Criterios de aceptación (Given/When/Then)

- GIVEN repo con `pnpm-lock.yaml` y `package-lock.json` WHEN dispatch `worktree: true` sin más THEN setup = `pnpm install --frozen-lockfile` y el agente arranca DESPUÉS del setup.
- GIVEN `setupCommand: "npm install"` THEN corre `bash -c "npm install"` en el worktree (ignora lockfiles).
- GIVEN `setupCommand: "none"` THEN behavior idéntico a hoy (ni detección ni ejecución).
- GIVEN repo sin lockfiles WHEN dispatch `worktree: true` sin `setupCommand` THEN error ANTES de crear worktree/tab.
- GIVEN comando exit 1 con output THEN error contiene tail del output y el worktree se borra (si quedó limpio) o se conserva con razón.
- GIVEN comando que cuelga THEN a los 10 min se aborta igual que un exit 1.
- GIVEN `setupCommand: "npm ci"` y `worktree: false` efectivo THEN error temprano.
- GIVEN `setupCommand: "none"` y `worktree: false` efectivo THEN dispatch normal, sin error ni setup.
- GIVEN dos dispatches con setup lanzados en paralelo THEN el segundo setup empieza cuando acaba el primero (colados jamás).
- GIVEN setup exit 0 THEN resultado incluye "setup OK" y el registro lista el comando efectivo.

## Casos límite

- `""` → error de validación (no es none).
- `"Auto"`/`"NONE"` en mayúsculas → comando LITERAL (los modos son case-sensitive; documentado).
- Dispatch con cwd en subdirectorio (monorepo) → detección lee la RAÍZ del repo; lockfile en raíz cuenta.
- Fallo del setup que deja ficheros trackeados modificados → worktree conservado, gate humano.
- Fallo que deja solo `node_modules` (gitignored) → status limpio → worktree removido OK.
- Detección lee el PADRE, no el worktree (equivalente por HEAD; evita TOCTOU y side effects).
- `kind` != pi + `setupCommand` → permitido.
- Repo con lockfile PERO despacho que no necesita deps → caller pasa `"none"`; el default opinionado es parte del contrato.

## Preguntas abiertas

Ninguna material.
