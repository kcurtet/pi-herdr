# Spec 004 — Modo global: orquestar agentes que no despachó esta sesión

## Problema

pi-herdr nació para que **cada workspace se orqueste a sí mismo**: las tools solo ven el `Registry` de
la sesión (sus despachos). Una orquestadora global por voz (Trinity, en jerga) necesita lo contrario:
ver, leer y **vigilar** agentes que el humano lanzó a mano —pi y Claude, en cualquier workspace—,
y enterarse cuando terminan o se bloquean sin hacer polling.

Hoy puede ver y leer vía CLI (`herdr agent list/read`), pero no tiene **avisos**: el watcher
(`armWatcher`, eventos con `triggerTurn`) solo se arma para despachos propios.

## Decisiones

- **D1 — Scope por sesión, no por config global.** `PI_HERDR_SCOPE=global` en el entorno de la
  sesión activa el modo global. Sin la variable (o con otro valor): comportamiento actual intacto.
  No va en `pi-herdr.json` porque ese config lo comparten todas las sesiones.
- **D2 — Ajenos = solo lectura + vigilancia.** En global, `herdr_agents` añade todos los agentes de
  herdr; `herdr_read` acepta cualquier agente (nombre o `pane_id`, p.ej. `w1D:p1`). `herdr_prompt`
  y `herdr_stop` **siguen limitados a despachos propios**: mandar trabajo o cerrar agentes ajenos
  queda para la CLI con confirmación humana (fuera de alcance).
- **D3 — `herdr_watch` / `herdr_unwatch` (solo global).** Adoptan un agente ajeno en un watcher
  propio (`armWatcher`, mismo motor) y emiten eventos `herdr-watch-event` con `triggerTurn`:
  `blocked`, `settled` (con la cola de la salida), `gone`, `stranded`.
- **D4 — Un agente vigilado NUNCA se cierra ni se toca.** El watcher de `herdr_watch` no pasa por
  `settle.ts` (cierre/cleanup de worktree): solo informa. Sin entrada en el `Registry`.
- **D5 — Una vigilancia = un aviso por defecto.** Tras el primer `settled`, el watch termina
  (`keep: true` → sigue vigilando las siguientes rondas). `blocked` re-arma siempre (espera el cambio).
- **D6 — Vida por `pane_id` o nombre.** La verificación antes de `gone` (issue #14) acepta ambos:
  los agentes lanzados a mano no tienen nombre.
- **D7 — Watch duplicado = no-op con aviso.** Vigilar dos veces el mismo objetivo no arma otro wait.

## Criterios de aceptación

- **A1** Sin `PI_HERDR_SCOPE`: tools y descripciones idénticas a antes; `herdr_watch` no existe.
- **A2** Global: `herdr_agents` lista despachos propios + todos los agentes de herdr (kind, estado,
  cwd, título, pane).
- **A3** Global: `herdr_read w1D:p1` lee un agente ajeno sin registro.
- **A4** `herdr_watch` sobre un agente que termina emite un `herdr-watch-event` settled con la salida
  y no ejecuta ningún `close`.
- **A5** `blocked` emite evento y la vigilancia sigue; tras el settle siguiente termina (sin keep).
- **A6** `herdr_unwatch` detiene el wait; `session_shutdown` detiene todas las vigilancias.
- **A7** Watch de un objetivo inexistente → error claro, sin wait armado.

## Fuera de alcance

Prompt/stop de agentes ajenos desde tools; reanudar vigilancias tras resume de sesión.
