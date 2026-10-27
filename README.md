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

## Comportamiento

- **Eventos, no polling**: un watcher interno (`herdr agent wait` driven) emite `blocked`/`settled`/`gone` como mensajes que disparan turno cuando el agente principal está idle. El settle trae la salida del agente.
- **Auto-cierre**: al settle el tab se cierra solo (spec "un despacho = un pane = una vida"). `blocked` NUNCA cierra — la aprobación se decide en el pane visible. `keepOpen: true` desactiva el auto-cierre.
- **Worktree opcional** (`worktree: true`): rama `hd/<name>` desde HEAD en `<repo>/../.hd-worktrees/<name>`. Cleanup conservador: solo se borra con working tree limpio y rama fully-merged; si hay WIP o commits sin merge, se conserva y se reporta (gate humano).
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
