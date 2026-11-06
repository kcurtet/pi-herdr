# pi-herdr

Extensión de [pi](https://github.com/earendil-works/pi) que convierte el flujo de despacho visible en herdr en tools: **una llamada `herdr_dispatch` = tab nueva + agente + prompt + vigilancia + cierre automático**.

Requiere correr dentro de herdr (`HERDR_ENV=1`).

## Tools

| Tool | Propósito |
|---|---|
| `herdr_dispatch` | Despacha un agente visible (default: tab en la workspace actual, kind pi) y devuelve `{agent, paneId, taskId}` al instante. Params: `task` (requerida), `name`, `cwd`, `topology` (tab\|pane\|workspace), `kind`, `worktree`, `keepOpen`, `skills`, `extensions`. |
| `herdr_prompt` | Segunda ronda a un agente vivo de esta sesión. |
| `herdr_read` | Salida del agente (recent-unwrapped, default 200 líneas). |
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

- **Eventos, no polling**: un watcher interno (`herdr agent wait` driven) emite `blocked`/`settled`/`gone`/`stranded` como mensajes que disparan turno cuando el agente principal está idle. El settle trae la salida del agente. `stranded` = el wait murió pero el agente SIGUE vivo (p.ej. server herdr caído/reiniciándose): nada se cierra, el despacho queda live — decide con `herdr_stop`.
- **Auto-cierre**: al settle el tab se cierra solo (spec "un despacho = un pane = una vida"). `blocked` NUNCA cierra — la aprobación se decide en el pane visible. `keepOpen: true` desactiva el auto-cierre.
- **Worktree opcional** (`worktree: true`): rama `hd/<name>` desde HEAD en `<repo>/../.hd-worktrees/<name>`. Cleanup conservador: solo se borra con working tree limpio y rama fully-merged; si hay WIP o commits sin merge, se conserva y se reporta (gate humano).
- **Setup del worktree** (`setupCommand`, spec 003): con `worktree: true`, comando de preparación que corre oculto en el worktree recién creado, ANTES de crear tab/agente. Omitido o `"auto"` → detecta por lockfile en la raíz del repo (`pnpm-lock.yaml` > `bun.lock`/`bun.lockb` > `yarn.lock` > `package-lock.json`); `"none"` → sin setup (escape hatch para repos sin toolchain JS); cualquier otro string → literal vía `bash -c`. Timeout 10 min; los dispatches con setup se serializan entre sí (mutex en-proceso). Si el setup falla, el dispatch se aborta con rollback conservador del worktree y el error trae el tail de la salida.
- **Resume/crash**: el registry se persiste en entries de sesión y `session_start` reconcilia contra `herdr agent list` — los agentes vivos recuperan watcher; los muertos se cierran (worktree pendiente se limpia una sola vez).
- **Shutdown**: `session_shutdown` cierra todo lo vivo, idempotente.

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

Los 6 defaults: `skills`, `extensions`, `topology`, `kind`, `keepOpen`, `worktree`. Jerarquía: **param de la tool > config > builtin**.

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
