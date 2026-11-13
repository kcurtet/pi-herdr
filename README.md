# pi-herdr

Extensión de [pi](https://github.com/earendil-works/pi) que convierte el flujo de despacho visible en herdr en tools: **una llamada `herdr_dispatch` = tab nueva + agente + prompt + vigilancia + cierre automático**.

Requiere correr dentro de herdr (`HERDR_ENV=1`).

## Tools

| Tool | Propósito |
|---|---|
| `herdr_dispatch` | Despacha un agente visible (default: tab en la workspace actual, kind pi) y devuelve `{agent, paneId, taskId}` al instante. Params: `task` (requerida), `name`, `cwd`, `topology` (tab\|pane\|workspace), `kind`, `worktree`, `keepOpen`, `skills`, `extensions`. |
| `herdr_prompt` | Segunda ronda a un agente vivo de esta sesión. `interrupt: true`: encara además el tool call colgado — esc al pane si el agente está `working` (abort; pi: `app.interrupt`) para que el steering encolado arranque ya. |
| `herdr_read` | Salida del agente (recent-unwrapped, default 200 líneas), limpia de chrome del TUI de pi: reglas full-width, statusline y padding no llegan al consumidor. |
| `herdr_stop` | Abandona ya: cierra su tab/pane/workspace y limpia su worktree. |
| `herdr_agents` | Lista los despachos de la sesión. |

## Modo global (spec 004)

Por defecto cada sesión solo ve y orquesta **sus** despachos. Con `PI_HERDR_SCOPE=global` en el entorno de la sesión (p.ej. una orquestadora como Trinity de [jerga](https://github.com/kcurtet/jerga)):

| Tool | En global |
|---|---|
| `herdr_agents` | Despachos propios **+ todos los agentes de herdr** (pi, claude…): objetivo (nombre o `pane_id`), estado, cwd, título. |
| `herdr_read` | Lee **cualquier** agente, por nombre o `pane_id` (`w1D:p1`). |
| `herdr_watch` | Vigila un agente ajeno y avisa (mensaje con `triggerTurn`) cuando **termina**, **se bloquea** o **desaparece**. Un aviso por defecto; `keep: true` = cada ronda. |
| `herdr_unwatch` | Deja de vigilar. |

Los agentes ajenos son de **solo lectura + vigilancia**: nunca se cierran ni se promptean desde las tools (`herdr_prompt`/`herdr_stop` siguen limitadas a despachos propios). La variable es por sesión, no va en `pi-herdr.json`, para no cambiar el comportamiento de las demás sesiones.

## Comportamiento

- **Eventos, no polling**: un watcher interno (`herdr agent wait` driven) emite `blocked`/`settled`/`gone`/`stranded`/`interrupted` como mensajes que disparan turno cuando el agente principal está idle. El settle trae la salida del agente. `stranded` = el wait murió pero el agente SIGUE vivo (p.ej. server herdr caído/reiniciándose): nada se cierra, el despacho queda live — decide con `herdr_stop`.
- **Auto-cierre**: al settle el tab se cierra solo (spec "un despacho = un pane = una vida"). `blocked` NUNCA cierra — la aprobación se decide en el pane visible. `keepOpen: true` desactiva el auto-cierre.
- **Steering + interrupt** (`herdr_prompt` con `interrupt: true`, spec 006): el texto se encola como steering dentro de pi y, si el agente está `working`, se envía `esc` a su pane para abortar el tool call en curso — jamás `ctrl+c` (en pi borra el input encolado o mata al agente). `blocked`/`idle` nunca reciben esc. Anti-blip: un settle que llega con el agente YA `working` de nuevo (transición abort→steering, rounds encadenados, prompt manual del humano) se suprime — el que se entrega es el de la ronda completada. Grace: un settle tras una interrupción nuestra SIN recovery JAMÁS cierra el despacho — llega un evento `interrupted` y decides (`herdr_prompt` / `herdr_stop`). El abort MANUAL del humano en el pane (Esc a mano, sin `herdr_prompt`) no es distinguible de un settle normal y cierra según `keepOpen` (herdr no expone causa de settle). El grace es in-memory: un resume en la ventana esc→settle lo pierde.
- **Worktree opcional** (`worktree: true`): rama `hd/<name>` desde HEAD en `<repo>/../.hd-worktrees/<name>`. Cleanup conservador: solo se borra con working tree limpio y rama fully-merged; si hay WIP o commits sin merge, se conserva y se reporta (gate humano).
- **Setup del worktree** (`setupCommand`, spec 003): con `worktree: true`, comando de preparación que corre oculto en el worktree recién creado, ANTES de crear tab/agente. Omitido o `"auto"` → detecta por lockfile en la raíz del repo (`pnpm-lock.yaml` > `bun.lock`/`bun.lockb` > `yarn.lock` > `package-lock.json`); `"none"` → sin setup (escape hatch para repos sin toolchain JS); cualquier otro string → literal vía `bash -c`. Timeout 10 min; los dispatches con setup se serializan entre sí (mutex en-proceso). Si el setup falla, el dispatch se aborta con rollback conservador del worktree y el error trae el tail de la salida.
- **Resume/crash**: el registry se persiste en entries de sesión y `session_start` reconcilia contra `herdr agent list` — los agentes vivos recuperan watcher; los muertos se cierran (worktree pendiente se limpia una sola vez).
- **Shutdown**: `session_shutdown` cierra todo lo vivo, idempotente.

## Agent board (spec 007)

Widget persistente **sobre el editor** con una línea por despacho live de la sesión: qué hay vivo, en qué estado está y cuánto lleva — de un vistazo, sin tool calls ni scroll. Actualización en dos vías: eventos del watcher (inmediata) + tick de 30s que re-verifica el estado real vía `herdr agent get` (cubre el prompt manual del humano en el pane, que no emite nada) y refresca el elapsed. `blocked` además avisa con un **toast** (`warning`, uno por evento — la decisión es humana y urgente).

Línea completa, degradando por width de la terminal al estrechar (task → rama → kind → elapsed, suelo `name · STATUS` con el name truncado como último recurso — jamás desborda):

```
impl-login · WORKING 12m · pi · hd/impl-login · construye el login del admin…
impl-review · BLOCKED 3m · pi · revisa el PR #42 con ojo en l…
fix-payments · STRANDED 1h04m · fix del pago atrapado en rebase
agente-6 · IDLE 22m · pi
agente-7 · WORKING 5m · claude
+2 más
```

Cap de 5 líneas + `+k más` (orden por creación). Elapsed = tiempo **en el estado actual**: `BLOCKED 45m` es señal de alarma; cambia de estado → se reinicia el contador. Estados y su origen (los eventos del watcher SIEMPRE pisan al tick — el watcher es el dueño de la verdad, el tick es red de seguridad):

| Display | Origen evento (watcher) | Origen tick (`agent get`) |
|---|---|---|
| `WORKING` | dispatch / settle suprimido re-trabajando | reconcilia libre (working/blocked/idle) |
| `BLOCKED` | evento `blocked` (+ toast) | reconcilia libre |
| `IDLE` | `settled` con `keepOpen: true` | reconcilia libre (R7: prompt manual lo levanta) |
| `INTERRUPTED` | evento `interrupted` (grace, decide con `herdr_prompt`/`herdr_stop`) | sticky: solo puede levantarse a `WORKING` |
| `STRANDED` | evento `stranded` (wait muerto, agente quizá vivo — decide con `herdr_stop`) | **intocable** por el tick |

El settle sin `keepOpen` y `gone` no pintan estado: el despacho se cierra y la línea desaparece. Tras resume el board se repuebla desde los records restaurados (task/kind persisten en el registro) y arranca en `WORKING` hasta que un tick inmediato fija el estado real. Todo lo que pinta sale del registro — mismo board antes y después de un resume.

- **Solo TUI**: el guard es `ctx.mode === "tui"` en el arranque — en `-p`, JSON o RPC no hay widget, ni timer, ni toasts (comportamiento idéntico a sin board). El board es cosmético y no-throw: ningún fallo suyo puede romper dispatch/watch/settle.
- **Config**: `/herdr config board off` lo apaga en caliente (widget limpio + tick parado en la sesión viva); `on` (builtin) lo re-enciende. Sin despachos vivos el widget desaparece; `session_shutdown` para el tick y limpia.

## Skills y extensiones del agente despachado

Por defecto el agente despachado arranca **limpio**: `--no-skills --no-extensions` (más `-e` automático para la integración de estado de herdr, que el watcher necesita). Control por dispatch:

- `skills: false` (default) — sin skills · `skills: true` — herencia nativa completa · `skills: ["writing-specs", "/abs/SKILL.md"]` — solo esas (nombres o paths, resueltos en el padre antes de crear nada).
- `extensions` igual; nombres resueltos de `~/.pi/agent/extensions`, `packages[]`/`extensions[]` de settings (`npm:`, `git:`), o `builtin:<name>`/paths directos.
- `kind` distinto de `pi` + skills/extensions → error temprano.

## Defaults configurables: `/herdr`

Estilo turnkit: wizard + autocompletado + persistencia en `$PI_HOME/extensions-config/pi-herdr.json`.

```
/herdr                                  # estado (origen config/builtin)
/herdr config                           # wizard interactivo
/herdr config skills writing-specs,triage
/herdr config topology pane
/herdr reset [key]
```

Los defaults: `skills`, `extensions`, `topology`, `kind`, `keepOpen`, `worktree`, `board`. Jerarquía: **param de la tool > config > builtin**.

## Auto-dagr (spec 005)

Con `HERDR_ENV=1` cada sesión con pi-herdr graba **su propio grafo dagr** (contrato v3) en `~/.local/state/herdr-dagr/<workspace-label>/<session-id>.json` — sin cooperación de ningún agente:

- `herdr_dispatch` crea la tarea (id estable `<agente>-<n>`, kind `agent`) con intento a1 y el estado REAL de herdr; `herdr_prompt` añade intentos (a2, a3…); settle/blocked/gone/stop/reconcile/shutdown actualizan según el mapeo D0 (settle → `settled_unverified`/`asserted` — nunca éxito verificado; blocked → tarea `blocked` con unblock operator; gone → intento `lost` + tarea `failed`; stop/fin de sesión → tarea `canceled`).
- **Linaje**: el dispatch inyecta `DAGR_RUN`/`DAGR_TASK` al hijo vía `--env` al crear la topología; la sesión hija registra `lineage` en su propio run. Con dagr activo los hijos arrancan con pi-herdr auto-exento (como herdr-agent-state) para que graben su subárbol — escape: `herdr_dagr_children: false`.
- **Vista compuesta**: tras cada write, la sesión regenera `composed-<raíz>.json` (atómico, último-gana) integrando hijos bajo SU tarea mediante proyectos wrapper. Abre el pane de dagr sobre ese fichero y ves los tres niveles (Nyx → orquestadores → trabajadores) en vivo.
- Grabado jamás rompe ni retrasa una tool: writes tmp→rename serializados, errores → warning y seguir; `dagr check --strict` sobre el tmp como validación blanda si el binario está (PATH o plugin instalado).
- Config: `herdr_dagr: false` apaga todo (ni ficheros ni inyección); `PI_HERDR_DAGR_STATE_DIR` reubica el estado (tests/nichos). `/herdr` muestra ambos flags (readonly).

## Install

```
pi install github:kcurtet/pi-herdr
```

o copia/symlink a `~/.pi/agent/extensions/`.

## Dev

```
npm install
npm test        # vitest — suite completa (seams RunFn/spawnWait, sin herdr real)
npm run typecheck
```

Carga local: `pi --extension .`

## Spec

`docs/specs/001-dispatch-tool/` — spec y plan de implementación (SDD).
