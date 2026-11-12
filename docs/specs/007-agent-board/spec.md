# Spec 007 — Agent board: estado persistente de los subagentes en la UI de pi

## Contexto

Hoy el orquestador (sesión pi que usa `herdr_dispatch`) solo ve a sus subagentes por dos vías: los eventos `blocked`/`settled`/`interrupted`/`stranded`/`gone` que llegan como mensajes en el chat (y se pierden en el scroll) y la tool `herdr_agents`, que cuesta un tool call y muestra un congelado del momento. Entre evento y evento no hay forma de saber qué hay vivo, qué está blocked esperando decisión humana, ni cuánto lleva corriendo cada agente — sin gastar contexto del modelo.

Feature: un board persistente en la UI de pi que muestre info y estado de los subagentes despachados por la sesión, actualizado en vivo (eventos + tick), con señal adicional en `blocked` (toast).

## Hechos verificados (mecanismo real)

1. **Superficies UI de pi 1.5.2** (docs extensions.md / tui.md): `ctx.ui.setWidget(id, lines | (tui, theme) => Component, { placement })` pinta un widget persistente sobre el editor (default `aboveEditor`); `setWidget(id, undefined)` lo limpia. Un **componente custom** expone `render(width): string[]` + `invalidate()`, se redibuja en resize (el width llega en cada render) y debe cachear por width y limpiar el cache desde `invalidate()` (tui.md:22-28, 97-105, 180). El ancho visible se mide con helpers de pi (`visibleWidth`, `truncateToWidth`), nunca `string.length` (ANSI, wide chars).
2. **Guard de modo**: `ctx.hasUI` es `true` en TUI **y RPC**, `false` en `-p`/JSON (extensions.md:1175-1177). En RPC los fire-and-forget (`notify`, `setWidget`) son **funcionales**: emiten `extension_ui_request` por stdout y el cliente puede pintarlos o ignorarlos (rpc-extension-ui.md:8); `hasUI` NO sirve para apagar UI en RPC — el guard que pi prescribe para features de TUI real es `ctx.mode === "tui"` (rpc-extension-ui.md:25). Un componente custom (factory, no `string[]`) en RPC es territorio no documentado.
3. **Acceso a `ui` estable**: `ctx.ui` llega en cada handler de evento (`session_start`, commands, tools). El patrón ya usado por el repo es capturar la referencia en `session_start` (index.ts tiene dos handlers; el de reconcile ya recibe `ctx`). Aviso propio del repo (index.ts, rev issue #4 F1): los action methods de `pi` son stubs hasta `bindCore()` — nada de UI se llama en el cuerpo de la factory, siempre desde handlers.
4. **El registry no tiene estado fino**: `DispatchRecord.status` es solo `"live" | "closed"` (src/registry.ts:25-42); el estado del agente (working/blocked/idle) vive en los eventos del watcher. El embudo único de eventos es `emit` en index.ts:118 → `pi.sendMessage({ customType: "herdr-dispatch-event", ... }, { triggerTurn: true })`, con `details = { customType, agent, kind }` (src/settle.ts:75-125) donde `kind ∈ { blocked, settled, interrupted, stranded, gone }` (settled lleva `keepOpen: true` cuando aplica).
5. **Verdad reconciliable**: `herdr agent get <name>` existe ya envuelto (`agentGet`, src/herdr.ts:207, y `safeAgentStatus` tolerante a fallo, :212) — el board puede re-verificar estado real sin esperar eventos (cubre el prompt manual del humano en el pane, que no emite nada hasta el settle).
6. **Anti-flood de blocked ya resuelto**: el watcher no buclea en blocked desde la issue #8 — un toast por evento blocked es 1:1 con lo que hoy llega como mensaje.
7. **Config existente**: `CONFIG_KEYS = [skills, extensions, topology, kind, keepOpen, worktree]` en src/command.ts:8 con `VALUE_SPECS` por clave (wizard + autocompletado + validación) y `loadDefaults` que reporta claves inválidas como warnings. Añadir una clave es mecánico.
8. **El board es cosmético**: nada del flujo dispatch/watch/settle debe depender de él. `emit` ya es síncrono y best-effort; el board se cuelga ahí sin poder romperlo.
9. **El record no lleva task ni kind**: `DispatchRecord` (registry.ts:25) no guarda el texto de la tarea ni el kind del agente — viven solo en el call-site del dispatch; `rama` existe únicamente como `worktree.branch` en despachos con worktree. Sin persistencia nueva, un board tras resume solo podría pintar `name · STATUS` (ver D9).

## Intención y por qué

- El humano detrás del orquestador ve de un vistazo — sin tool calls ni scroll — qué subagentes hay vivos, en qué estado están y cuánto llevan.
- `blocked` (decisión humana pendiente en un pane) además avisa con toast: es lo único que exige acción YA.
- El estado del board es verdad reconciliada (tick con `agent get`), no solo replay de eventos.

## Objetivos

1. Widget persistente sobre el editor (`aboveEditor`) con una línea por despacho live de esta sesión: `name · STATUS · elapsed · kind · rama · task` degradando por width, suelo `name · STATUS`.
2. Actualización en dos vías: eventos del watcher (inmediata) + tick 30s (elapsed fresco y re-verificación de estado vía `agentGet`).
3. Toast `notify(..., "warning")` por evento `blocked`.
4. Config `board: on | off` (default `on`) en `/herdr` wizard, con efecto inmediato en la sesión.
5. Limpieza total: sin dispatches vivos el widget desaparece; `session_shutdown` para el tick y limpia el widget.
6. Cero regresiones: sin UI (headless/RPC) o con `board: off` el comportamiento es byte-idéntico al actual.

## No-objetivos

- **Agentes ajenos/watched** (spec 004, modo global): fuera — decisión explícita "solo propios". Revisitable: si el uso real lo pide, los watched entran con marca.
- **Footer setStatus / setFooter custom**: superficie elegida es el widget sobre el editor; el footer queda para pi.
- **renderCall/renderResult de las tools** (`herdr_dispatch` etc.): otra feature si acaso.
- **Interactividad en el board** (click/teclas para stop/prompt): el board es solo lectura; las decisiones pasan por el orquestador o `/herdr`.
- **dagr**: el board no graba nada (pure UI); el recorder de la spec 005 queda igual.
- **Cambiar los eventos/mensajes existentes**: el flujo `sendMessage` + `triggerTurn` se queda tal cual; el board es un consumidor pasivo adicional.
- **Cliente RPC consumiendo el board**: los fire-and-forget en RPC emiten `extension_ui_request` que un cliente podría pintar; apagado por D7. Revisitable si aparece un cliente RPC que quiera ese stream.
- **Notificaciones de sistema** (bell/escritorio): toast in-TUI solamente.

## Anti-objetivos

- El board NUNCA rompe el flujo: fallo de render, de `agentGet` del tick o de cualquier pieza del board se traga (log interno si acaso) — jamás propaga a dispatch/watch/settle.
- NUNCA timer corriendo con el board vacío o desactivado: el tick vive solo mientras haya ≥1 record live.
- NUNCA medir anchos a mano: `visibleWidth`/`truncateToWidth` de pi, siempre.
- NUNCA alargar `emit` de forma bloqueante: las actualizaciones del board por evento son síncronas y baratas (mutar estado + invalidate); el trabajo async (agentGet) es solo del tick.
- NUNCA toasts para eventos que no sean `blocked` (el settle ya dispara turno visible; duplicar sería ruido).

## Decisiones de implementación

**D1 — Módulo nuevo `src/board.ts`, consumidor pasivo del embudo existente.** Clase `Board` con: referencia `ui` (capturada en `session_start`), `Map<agent, { display: BoardDisplay, since: number }>` y tick. La membresía del board se deriva del registry (`registry.list()` filtrando `status === "live"`); el estado display se alimenta de los `details.kind` del `emit` + reconcile del tick. Hooks: `onDispatched(rec)` al resolver el dispatch, `onEvent(details)` dentro de `emit`, `onClosed(agent)` (markClosed paths: settle-close, stop, shutdown, reconcile), sin tocar sus firmas — el board se engancha en index.ts, los módulos existentes no lo importan.

**D2 — Estados display y su origen.** `WORKING` (dispatch, o settled suprimido re-trabajando — el tick lo pilla), `BLOCKED` (evento blocked), `IDLE` (settled con `keepOpen: true`), `INTERRUPTED` (evento interrupted: grace activo, decisión pendiente `herdr_prompt`/`herdr_stop`), `STRANDED` (evento stranded: wait muerto, agente quizá vivo — decide con `herdr_stop`). El settle con auto-close NO pinta estado: el record pasa a closed y la línea desaparece (membresía = live).

**D3 — Componente custom, línea degradante.** `setWidget("herdr-board", (tui, theme) => comp)` con `render(width)` que compone cada línea y cachea por `(width, versión)`; mutaciones hacen `invalidate()` + `tui.requestRender()` (coalescido por pi). Línea completa: `name · STATUS elapsed · kind · hd/<branch> · <task truncada>` (kind/task del record tras D9; el slot de rama solo existe con worktree, sin él se omite); al estrechar cae en orden: task → branch → kind → elapsed; suelo `name · STATUS` con el name truncado como último recurso. STATUS con color del tema (`theme.fg`): accent=WORKING, warning=BLOCKED, dim=IDLE, error=INTERRUPTED/STRANDED — re-aplicado por línea (pi resetea estilos por línea). Elapsed como `12m` / `1h04m` desde `since`.

**D4 — Tick 30s lazy con reconcile de verdad.** `setInterval` creado al pasar de 0 a ≥1 live, parado al vaciarse; en cada tick: `safeAgentStatus` por agente live (en paralelo, best-effort — fallo = mantiene último estado), refresh de elapsed, `invalidate + requestRender`. El tick NUNCA escribe en registry ni emite eventos: solo pinta, con la tabla de transiciones de D10. Limpieza total en `session_shutdown` (junto al shutdownCleanup existente). `unref()` del timer para no sujetar el proceso. El init del board tras reconcile lanza un primer tick inmediato (sin esperar los 30s) para fijar el estado real de los records restaurados.

**D5 — Toast blocked en el camino del emit.** En el hook `onEvent`, `kind === "blocked"` → `ui.notify("herdr: <agent> BLOCKED — decisión pendiente en su pane", "warning")` 1:1 con el evento (anti-flood ya garantizado por el watcher). Guard `hasUI`; en RPC/headless no hay toast.

**D6 — Config `board: on | off` con efecto inmediato.** Clave nueva en `CONFIG_KEYS`/`VALUE_SPECS`/DEFAULTS (`"on"` default) con el mismo patrón wizard/autocompletado/validación/warnings que el resto. La lectura inicial es en `session_start`; `/herdr config board off` además avisa al board vivo (flag mutable + clear del widget y stop del tick) para que el cambio surta en la sesión, no tras reiniciar.

**D7 — Solo TUI: no-op total fuera de TUI.** El guard es `ctx.mode === "tui"`, NO `hasUI` (hecho 2): con `hasUI` el board encendería bajo clientes RPC — widget emitiendo requests por stdout, tick lanzando `herdr agent get` cada 30s y toasts como `extension_ui_request` nuevos en el stream del cliente, sin contar el componente custom sin comportamiento documentado en RPC. Fuera de TUI (`-p`, JSON, RPC): sin widget, sin timer, sin toasts; los hooks existen pero son passthrough.

**D8 — Cap de líneas.** Máx 5 líneas de agente + 1 de desborda `+k más`; orden estable por `createdAt`. Con la política de 2-3 agents paralelos del AGENTS.md el cap rara vez muerde; existe para que un `keepOpen` acumulativo no empuche el editor.

**D9 — task/kind persisten en el record (builder check, Q3).** `DispatchRecord` gana `task?: string` y `kind?: string` opcionales, set en dispatch y persistidos por el `appendEntry` existente (spread `{...rec}`); `fromEntries` ya castea tolerante, así que entries pre-007 sin esos campos no rompen nada (sesiones viejas que resumen → línea degradada, caso límite). El board NO mantiene datos de línea propios: todo lo que pinta viene del record — mismo board antes y después de un resume. Extender el record no rompe D1: nadie importa al board, la interfaz del registro no cambia.

**D10 — Tabla de transiciones del tick (builder check, Q2).** El tick es reconciler, no dueño de la semántica. Estados watcher-alive (`WORKING`/`BLOCKED`/`IDLE`): el tick escribe libremente lo que `safeAgentStatus` reporte (cubre el prompt manual del pane y watchers muertos). `INTERRUPTED`: sticky — el tick solo puede levantarlo a `WORKING` (la ronda encolada arrancó); jamás lo degrada a `IDLE` (perdería la señal de decisión pendiente). `STRANDED`: intocable por el tick — su watcher está muerto y ningún evento vendrá a corregir una sobreescritura; solo sale por `herdr_stop`/shutdown. Los eventos del watcher SIEMPRE pisan al último valor del tick: el watcher es el dueño de la verdad, el tick es red de seguridad.

**D11 — Elapsed = tiempo en el estado actual (builder check, Q4).** `since` se resetea en cada transición (evento o tick): `BLOCKED 3m` = lleva 3 minutos bloqueado. El lifetime total del despacho no se muestra: las transiciones ya son visibles en el chat como mensajes y el lifetime rara vez cambia una decisión; el tiempo-en-estado sí (`blocked` 45m es señal de alarma).

## Queda a criterio del builder

- Estructura interna del componente: clases de pi-tui (`VStack`/`Text`) vs `string[]` con ANSI del theme — mientras respete cache por width y helpers de ancho.
- Formato exacto de elapsed y de la línea (separadores, mayúsculas) y colores concretos del theme.
- Dónde vive el `Map` de estados display (dentro de Board vs colchón en index.ts) y la firma exacta de los hooks.
- Estrategia de tests del render: componente con render(width) testeable directo (fixture-driven, imitando el patrón de snapshots del repo si lo hay) vs extracción de `composeLine(state, width): string` pura y testear esa.
- Si el tick agrupa los `safeAgentStatus` con `Promise.allSettled` literal u otro helper.

## Requisitos

- R1. **Given** sesión con UI y `board: on`, **When** `herdr_dispatch` resuelve OK, **Then** la línea del agente aparece en el widget al instante como `name · WORKING 0m · ...` (sin esperar al primer evento ni al tick).
- R2. **Given** agente live, **When** llega evento `blocked`, **Then** su línea pasa a `BLOCKED` (color warning) Y se emite un toast `warning` — exactamente uno por evento.
- R3. **Given** agente live sin `keepOpen`, **When** llega `settled` con auto-close, **Then** la línea desaparece del widget (record closed) y el widget entero se limpia si era el último live.
- R4. **Given** agente con `keepOpen: true`, **When** llega `settled`, **Then** su línea pasa a `IDLE` y permanece.
- R5. **Given** agente con grace activo, **When** llega `interrupted`, **Then** su línea pasa a `INTERRUPTED` y permanece hasta `herdr_prompt`/`herdr_stop` (o siguiente working vía tick).
- R6. **Given** agente live, **When** llega `stranded`, **Then** su línea pasa a `STRANDED` (color error) y permanece (decisión con `herdr_stop`), aunque el tick reporte `working` (D10: intocable).
- R7. **Given** agente `IDLE`/`keepOpen` cuyo pane el humano promptea a mano, **When** pasa un tick, **Then** la línea refleja `WORKING` vía `safeAgentStatus` sin ningún evento del watcher implicado.
- R8. **Given** widget renderizado, **When** la terminal se estrecha, **Then** las líneas degradan (task → branch → kind → elapsed) y con width mínimo queda `name · STATUS` sin desbordar jamás el width.
- R9. **Given** 7 dispatches live, **When** se pinta el board, **Then** 5 líneas + `+2 más`, orden por `createdAt`.
- R10. **Given** `board: off` (config), **When** corre la sesión, **Then** sin widget, sin timer, sin toasts — y `/herdr config board off` en caliente lo apaga ya (clear widget + stop tick).
- R11. **Given** sesión fuera de TUI (`-p`, JSON o RPC), **When** se despachan agents, **Then** comportamiento idéntico al actual: sin widget, sin timer, sin toasts y sin `extension_ui_request` nuevo en stdout.
- R12. **Given** agentes live, **When** `session_shutdown`, **Then** timer parado y widget limpio, además del cleanup existente.
- R13. **Given** resume con dispatches vivos, **When** `session_start` reconcilia, **Then** el board repuebla desde los records live restaurados con task/kind intactos (D9), arranca en `WORKING` y un tick inmediato fija el estado real.
- R14. **Given** cualquier fallo interno del board (agentGet caído, excepción en render), **When** fluye un evento o tick, **Then** el error se traga y dispatch/watch/settle siguen intactos.
- R15. **Given** dispatch con `task`/`kind`, **When** el record se persiste y la sesión resume, **Then** las entries contienen ambos campos y `fromEntries` reconstruye la línea completa; entries pre-007 sin ellos no rompen la reconstrucción (línea degradada).

## Casos límite

- Resize a width menor que `name · STATUS`: el name se trunca, jamás desborda.
- `agentGet` fallando en todos los ticks: el board muestra el último estado conocido para siempre (el watcher ya avisará `stranded` si el wait murió) — no hay estado "unknown" que inventar.
- Dispatch que falla tras reservar taskId: nunca hubo record live → nunca hay línea (hueco de taskId, no de board).
- Dos dispatches con el mismo slug: el registry ya dedupea (`-2`/`-N`) — nombres únicos garantizados.
- `blocked` persistente: el tick sigue (record live), elapsed cuenta desde el `since` del blocked (D11).
- Elapsed cruzando 1h: formato `1h04m`, sin respetar ancho fijo del campo.
- Sesión pre-007 que resume: records sin `task`/`kind` → línea degradada `name · STATUS elapsed`, sin error (D9).
- Agente `INTERRUPTED` cuyo pane el humano promptea a mano: el tick lo levanta a `WORKING` (única salida del INTERRUPTED por tick, D10).

## Preguntas abiertas

- Ninguna bloqueante. La marca visual exacta de `STRANDED` vs `INTERRUPTED` (color error compartido vs distintos) es decisión del builder con el theme en la mano.
