# Spec 001 — pi-herdr: dispatch visible en herdr como tools de pi

## Contexto

La skill `herdr-dispatch` (~/.pi/agent/skills/herdr-dispatch/SKILL.md) describe un flujo de 7 pasos bash para despachar un agente visible en herdr y vigilarlo: preguntar topología, chequear `HERDR_ENV`, crear topología, `herdr agent start`, `herdr agent prompt`, vigilar con monitor, cerrar el pane siempre. Dolores actuales: el modelo ejecuta 5+ comandos torpes uno a uno, se salta pasos (pane sin cerrar, `--wait` por error, IDs deducidos del sidebar), y cada sesión paga el coste de cargar y leer la skill entera.

Esta extensión convierte ese flujo en tools de pi con configuración por defecto: **una llamada = despacho completo**. El resultado llega solo, como eventos que disparan turnos cuando el agente principal está idle.

Referencias de implementación: `~/dev/pi-monitor` (motor de watch a copiar), `~/dev/pi-turnkit` (estructura de repo de extensión), docs de extensiones de pi 1.4.x.

## Intención y por qué

- Cero fricción: `herdr_dispatch(task)` con todo por defecto debe bastar para un despacho.
- Cero pasos olvidables: el cierre y la vigilancia no dependen de que el modelo se acuerde.
- Autocontenida: el motor de watch se copia dentro; no depende de que pi-monitor esté instalado.

## Objetivos

1. Tool `herdr_dispatch` con defaults sensatos (tab nueva en workspace actual, agente pi) y todo lo demás configurable.
2. Vigilancia integrada: eventos `blocked`/`settled` con salida legible del agente.
3. Multi-ronda opt-in: re-prompt al mismo agente vivo (`keepOpen` + `herdr_prompt`).
4. Worktree opcional con política conservadora (nunca destruir trabajo).
5. Extensión autocontenida, distribuible como paquete pi.

## No-objetivos

- Merge/rebase automático de la rama del worktree de vuelta — gate humano siempre.
- Fallback headless (`pi -p`) cuando no hay herdr — error claro y punto.
- Exponer el watcher como tool genérica (`monitor` sigue siendo cosa de pi-monitor; aquí es motor interno).
- Slash command humano (`/dispatch`) en v1.
- Sustituir pi-cockpit `team_dispatch`: ese gobierna planes con worktrees y gates de revisión; este es dispatch manual ad-hoc fuera de team.

## Anti-objetivos

- Nunca destruir trabajo: WIP o commits sin merge se conservan y se reportan, jamás se borran.
- Nunca robar el foco del humano (`--no-focus` siempre en creación de topología).
- Nunca deducir IDs del sidebar: siempre parse del JSON que devuelven los subcomandos.

## Restricciones

- Requiere ejecutar dentro de herdr (`HERDR_ENV=1`); si no, la tool falla con mensaje claro y cero side effects.
- Nombres de agente válidos para herdr: `^[a-z][a-z0-9_-]{0,31}$`, únicos entre agentes vivos.
- `herdr agent start` exige pane en prompt interactivo de shell y devuelve al detectar el agente listo (`interactive_ready`); no dormir ni verificar aparte.
- `herdr agent prompt` SIEMPRE sin `--wait` (submission ≠ turno iniciado).
- `herdr agent wait` se asienta en `idle`/`done`/`blocked` (y termina si el pane desaparece). No lleva timeout: el deadline lo pone el watcher.
- Extension API de pi 1.4.x: `registerTool`, `appendEntry`, `sendMessage` (mensajes custom que disparan turno en idle), `session_start`/`session_shutdown`, reconstrucción de estado desde la rama activa vía session manager.

## Decisiones de Implementación

**D1 — Surface (5 tools)**:
- `herdr_dispatch(task, name?, cwd?, topology?, kind?, worktree?, keepOpen?)` → `{ agent, paneId, taskId, worktreePath? }`
- `herdr_prompt(agent, text)` — re-prompt al agente vivo; el watcher re-arma la espera.
- `herdr_read(agent, lines?)` — salida del agente (`recent-unwrapped`, default últimas 200 líneas).
- `herdr_stop(agent)` — abandonar ya: cierra pane, para watcher, aplica política conservadora si hay worktree.
- `herdr_agents()` — despachos vivos de la sesión (agente, estado, pane, worktree). Útil tras compaction.

**D2 — Defaults**: `topology: "tab"` en el workspace actual (label = name), `kind: "pi"`, `cwd` = cwd de la sesión, `worktree: false`, `keepOpen: false`, `name` = slug de 2-3 palabras significativas de la task (normalizado a la regex y recortado; fallback `dispatch-N`), validando unicidad contra agentes vivos.

**D3 — Watcher interno (copia del motor de pi-monitor)**: por despacho, spawn de `herdr agent wait <name> && herdr agent read <name> --source recent-unwrapped --lines 200`; batching de eventos (≤2s); entrega como mensajes custom vía `sendMessage` que disparan turno cuando el agente principal está idle. Persistent (sin timeout — el ciclo de vida lo gestionan auto-close/keepOpen/stop/shutdown). NO se registra como tool.

**D4 — Ciclo de vida y cierre**:
- `blocked` → evento, tab ABIERTO (la decisión de aprobación es del humano, en el pane visible).
- settle real (`idle`/`done`) → evento final con la salida legible → auto-close del tab/pane, salvo `keepOpen`.
- pane cerrado a mano / agente muerto → evento `gone`, cleanup de registro, worktree según política conservadora.
- `keepOpen: true` → sin auto-close; el watcher sigue emitiendo en cada settle; cierre explícito (`herdr_stop`) o en `session_shutdown`.
- `session_shutdown` cierra todos los panes/tabs tracked (idempotente) y aplica la política de worktree a cada uno.

**D5 — Worktree opcional** (`worktree: true`, requiere que `cwd` sea repo git):
- Rama nueva `hd/<name>`, worktree en directorio hermano del repo: `<repo>/../.hd-worktrees/<name>` (no toca el repo, no requiere gitignore).
- El agente arranca con cwd = worktree.
- Cleanup conservador al cerrar: borrar worktree+rama SOLO si el working tree está limpio y la rama está fully-merged; si hay WIP o commits sin merge → conservar y reportar path+rama en el evento final (gate humano).

**D6 — Registry y estado**: una `appendEntry` por despacho (agent, paneId, taskId, worktree, topology, timestamps) para sobrevivir compaction; reconstrucción en `session_start` SOLO desde la rama activa (las ramas abandonadas son historias alternativas); `session_shutdown` limpia.

**D7 — Errores**: `HERDR_ENV` unset → error de tool claro. Name colisiona con agente vivo → error sugiriendo alternativas. `cwd` inexistente, o no-git con `worktree: true` → error claro ANTES de crear nada. `agent_blocked` devuelto por el prompt inicial → se trata como `blocked` (evento, sin close).

**D8 — Higiene herdr**: `agent prompt` sin `--wait` siempre; topología con `--no-focus` siempre; IDs parseados del JSON devuelto, jamás deducidos del orden del sidebar.

## Queda a criterio del builder

- Estructura interna de módulos; parseo exacto del JSON de cada subcomando herdr; truncado y escape del texto de eventos; formato del evento final (prosa vs bloque de código); timeouts de los subprocesos herdr individuales; algoritmo de slugificación del name por defecto.
- Repo: `~/dev/pi-herdr`, estructura estilo pi-turnkit (`index.ts` + `package.json` con `pi.extensions`, peerDependency de `@earendil-works/pi-coding-agent` — nunca devDependency).

## Requisitos

- R1. `herdr_dispatch` con solo `task` despacha y devuelve `{agent, paneId, taskId}` sin más input.
- R2. El settle llega como mensaje que dispara turno en idle, con salida legible del agente.
- R3. Tras settle sin `keepOpen`, el tab queda cerrado.
- R4. `herdr_prompt` encadena una segunda ronda en el mismo agente sin nuevo dispatch.
- R5. `worktree: true` crea rama `hd/<name>` + worktree hermano, y el agente arranca allí.
- R6. Cleanup conservador: jamás borra worktree con WIP o sin merge; siempre lo reporta.
- R7. Fuera de herdr → error claro, cero side effects.
- R8. `session_shutdown` cierra los panes tracked de forma idempotente.
- R9. El registry sobrevive compaction (`herdr_agents` lista el despacho vivo tras compactar).

## Criterios de aceptación (Given/When/Then)

- GIVEN dentro de herdr WHEN `herdr_dispatch(task="revisa el login", name="login-review")` THEN devuelve agent+paneId+taskId, tab nueva sin foco en el workspace actual, agente pi corriendo con el prompt.
- GIVEN despacho vivo WHEN el agente se asienta THEN mensaje con la salida + tab cerrado + registry actualizado.
- GIVEN despacho vivo WHEN el agente entra en `blocked` THEN mensaje de aviso y tab ABIERTO.
- GIVEN `keepOpen` WHEN settle THEN mensaje, tab abierto, watcher vivo.
- GIVEN `worktree: true` con WIP al cerrar THEN worktree conservado y evento reportando path y rama.
- GIVEN `HERDR_ENV` unset WHEN `herdr_dispatch` THEN error de tool claro, cero side effects.
- GIVEN despacho + compaction WHEN `herdr_agents` THEN el despacho vivo aparece listado.

## Casos límite

- name duplicado con agente vivo → error con sugerencia.
- cwd inexistente o no-git con `worktree: true` → error antes de crear nada.
- humano cierra el pane a mano → evento `gone`, registry marcado, sin errores colgantes.
- herdr server muere a mitad → los subcomandos fallan; el error llega como evento legible; nada queda colgado.
- shutdown durante despacho en vuelo → cleanup idempotente, no se ejecuta dos veces.
- `task` vacía → error de validación del schema.
- slug por defecto excede 32 chars o trae caracteres inválidos → normalizar/recortar, no error.
- segundo `herdr_prompt` mientras el agente sigue procesando el primero → herdr responde `agent_busy`; la tool lo reporta sin romper el watcher.

## Preguntas abiertas

Ninguna material. Las menores están explícitamente cedidas al builder.
