# Spec 006 — Steering mid-comando: interrumpir el tool call colgado y que el abort no cierre al agente

## Contexto

Incidente real (issue #19, intruder 2026-11-12): un agente implementador corrió un test colgado — 24 min al 108% de CPU, un `waitFor` sin salida — dentro de un tool call síncrono. Consecuencias encadenadas:

1. **`herdr_prompt` es inerte**: el prompt se envía y aparece en el pane, pero pi lo encola como steering y no lo procesa hasta que el tool call acabe. Con un comando colgado, el steering espera indefinidamente.
2. **El abort cierra al agente**: al abortar el comando (la única forma de desbloquear), el agente settlea y con `keepOpen: false` (default) el tab se auto-cierra — el trabajo a medio hacer queda en el worktree y la continuación exige re-despachar con todo el contexto re-explicado.

Feature: que `herdr_prompt` pueda desbloquear de verdad al agente atascado (interrupción real del tool call en curso) y que una interrupción iniciada por esta sesión JAMÁS se traduzca en cierre del despacho sin decisión del orquestador.

## Hechos verificados (mecanismo real)

1. **Canal del prompt**: `promptAgent` (src/dispatch.ts:122) → `agentPrompt` (src/herdr.ts:167) → `herdr agent prompt <name> <text>` SIN `--wait`; herdr pega el texto en el input del TUI del agente (bracketed-paste + Enter como una submission ordenada, skill de herdr) y solo rechaza con `agent_blocked` si el agente ya espera input (src/herdr.ts:170). pi clasifica ese input como steering: se entrega "después de que el turno actual termine de ejecutar sus tool calls, antes de la siguiente llamada al LLM" (docs de pi, `deliverAs: "steer"`). Con un tool call colgado, ese "después" nunca llega: **el prompt es aceptado pero queda encolado para siempre**. No es un bug de entrega — es la semántica de steering de pi.
2. **Canal de interrupción ya existente**: `herdr agent send-keys <TARGET> <KEY>...` (CLI herdr 0.9.3). Escribe bytes en el PTY del pane = como pulsar la tecla; herdr valida las keys ANTES de escribir nada. La skill oficial documenta `herdr agent send-keys reviewer esc` como superficie de control de agentes (la superficie `pane` queda para control crudo intencional).
3. **Tecla correcta para pi: `esc`**. En pi, `escape` = `app.interrupt` (Cancel/abort, docs/keybindings.md de pi); aborta el tool call en curso (pi mata a su hijo bash con todo el grupo), el run se asienta y el steering encolado dispara el turno siguiente. **`ctrl+c` es una trampa en pi**: está bound a `app.clear` (borra el editor; segunda pulsación = exit) — enviar ctrl+c a un pane pi puede borrar el input encolado o MATAR al agente. El abort manual del incidente fue exactamente ese camino.
4. **El abort NO es distinguible del settle**. `herdr agent wait` solo matchea `idle|working|blocked|done|unknown` (posibles valores de `--until`, CLI help); el snapshot de la API no expone causa ni estado `aborted`. Un abort manual que deja a pi idle llega al watcher como `settled (idle)` común y corriente (src/watch.ts:178 → deliver). El sistema NO puede saber hoy que un settle vino de un abort.
5. **Qué sabe el sistema en el settle**: el `DispatchRecord` (src/registry.ts:25) trae `keepOpen` y `status`; el handler (src/settle.ts:80 settle+keepOpen, src/settle.ts:97 cierre definitivo) decide close/markClosed según eso. No sabe si hay prompt encolado ni si hubo abort.
6. **Blips idle transitorios reales**: el propio `herdr agent prompt --wait` exige actividad `working|blocked` observada en 5s tras submit desde estado no-working (`agent_prompt_stalled`, CLI help) — herdr sabe que entre un abort y la entrega del steering (o entre rounds encadenados) hay idle pasajero que un wait level-triggered matchea AL INSTANTE. Hoy ese blip dispara `settled` → close en caliente con `keepOpen:false`: es el mecanismo por el que el pane de la issue #20 se cerró con attempts vivos (su reconciliación W209 ya está en main, merge e7aec90 — esta spec ataca por qué se llega ahí).
7. **Cero dependencias externas para el núcleo**: `agent send-keys` existe en la CLI instalada; no hay que tocar herdr. La única dependencia externa sería detectar el abort MANUAL (hecho 4) — ver No-objetivos.

## Intención y por qué

- El orquestador puede desbloquear a un agente atascado EN UNA llamada: texto de steering + interrupción del tool call, en ese orden y como una operación atómica.
- Una interrupción iniciada por esta sesión es señalización ("mata esto"), no fin de despacho: el contexto del agente y el trabajo del worktree se conservan; la continuación se steerea al MISMO agente sin re-explicar nada.
- El steering (con o sin interrupt) deja de perder rondas por settles transitorios: el settle final que se entrega es el de la ronda completada, no un blip.

## Objetivos

1. Param `interrupt?: boolean` (default `false`) en `herdr_prompt`: encolar el prompt y, si el agente está working, enviar `esc` al pane para abortar el tool call en curso.
2. Grace del interrupt: si tras una interrupción nuestra el agente asienta SIN que la ronda encolada arranque, el despacho NO se cierra (aunque `keepOpen: false`): evento `interrupted` + decisión del orquestador (`herdr_prompt` / `herdr_stop`).
3. Anti-blip: un settle que llega con el agente YA working de nuevo (transición abort→steering, rounds encadenados, o prompt manual del humano en el pane) se suprime en vez de cerrar en caliente.
4. Respuestas honestas: la tool siempre dice qué pasó (prompt encolado, interrupción enviada / no necesaria / fallida).
5. Cero regresiones: sin `interrupt`, comportamiento byte-idéntico al actual (salvo el anti-blip de 3, que solo añade una verificación antes de cerrar).

## No-objetivos

- **Timeouts en comandos de los briefs**: mitigación del lado del usuario (ya aplicada), no cura. Fuera del repo.
- **Detectar el abort MANUAL del humano** (Esc pulsado en el pane a mano): herdr no expone estado `aborted` ni causa de settle (hecho 4). **Dependencia externa explícita**: si herdr algún día expone esa señal, el grace de D5 se extiende a aborts manuales; hoy un abort manual sin prompt encolado sigue siendo un settle final normal (documentado en README de la tool). La heurística de buscar "aborted" en la salida del pane se rechaza: frágil (falsos positivos con output de tests).
- Tool `herdr_interrupt` separada / bare interrupt sin texto: el caso real siempre lleva texto de steering ("para el test y reporta"); el bare-interrupt degrada a grace + re-prompt (D5). Revisitable si el uso real lo pide.
- Señales a PIDs concretos (SIGKILL quirúrgico del comando hijo): la interrupción es a nivel TUI (pi aborta y limpia a su hijo); no cazamos procesos.
- Enviar `ctrl+c` bajo ninguna circunstancia (hecho 3).
- Cambios en la CLI herdr: ninguno necesario.
- Issue #20: reconciliación de attempts al cierre ya resuelta en main (e7aec90); esta spec evita LLEGAR a ese cierre, no toca su política.

## Anti-objetivos

- NUNCA enviar `ctrl+c` a un pane pi: borra el input del editor o cierra al agente (segunda pulsación).
- El interrupt jamás cierra pane/worktree ni marca el record closed: como mucho setea un flag in-memory.
- NUNCA suprimir un settle sin verificar `working` primero (D4): un settle final tragado sin verificación = despacho zombie invisible.

## Decisiones de implementación

**D1 — Canal de interrupción**: nuevo wrapper `agentSendKeys(run, { name, key })` en src/herdr.ts sobre `herdr agent send-keys <name> esc` (misma superficie `runOk`, CONTROL_TIMEOUT). Key FIJA `esc` para kind pi (`app.interrupt`). Se usa la superficie `agent` (resolución por nombre + validación de keys por herdr), no `pane send-keys` (cruda, para control intencional según la skill). Kinds ≠ pi: misma key `esc`, best-effort documentado (claude/codex usan Esc como interrupt por convención de TUI, pero solo pi es contractual aquí).

**D2 — Surface: param en `herdr_prompt`, no tool nueva**. `interrupt?: boolean` en `HerdrPromptParams`. El caso de uso es una sola operación lógica: texto + desbloqueo. Dos tools separadas invitan al orden inverso (esc primero → blip idle → con `keepOpen:false` el auto-close gana la carrera al prompt) y a carreras entre llamadas del modelo. La atomicidad la garantiza la tool, no la disciplina del caller.

**D3 — Orden interno y guard de estado**: `interrupt: true` → (1) `agentPrompt` normal (el texto queda encolado DENTRO de pi); (2) `agentGet`: `working` → enviar esc; `blocked` → SIN esc (camino `agent_blocked` actual: hay un diálogo humano delante); `idle|done` → SIN esc (el prompt se procesa ya; interrumpir sería un abort auto-infligido). Interrumpir = "asegurar que el prompt se procesa", no "abortar lo que sea". La respuesta de la tool reporta las fases (D7).

**D4 — Anti-blip universal en settle.ts**: antes de tratar un `settled` como final, UNA llamada `agentGet`. Si `agent_status === "working"` → settle TRANSITORIO: suprimir (sin emit, sin close, sin cleanup, sin dagr, sin markClosed), devolver `true` — el watcher existente re-arma en fase `rearm` (working|blocked), que instant-matchea el working observado y pasa al ciclo settle: el próximo settle que se entregue es el de la ronda completada. Protege el flujo con interrupt, el steering natural y el prompt manual del humano en el pane. Si `agentGet` FALLA: NO suprimir — entregar como hoy (suprimir con estado no verificable podría tragarse el settle final para siempre: watcher colgado esperando un working que ya pasó). El `agentRead` que watch.ts ya hizo antes de deliver se desperdicia en el caso suprimido: coste aceptado (una lectura por settle transitorio).

**D5 — Grace: abort de esta sesión ≠ cierre**. Flag in-memory `interruptGrace` en el `DispatchRecord`, set SOLO tras un esc enviado con éxito (D3), clear al entregar cualquier settle del agente (suprimido o final). Settle entregado con grace activo (tras el check de D4, agente `idle|done`): NO close, NO cleanup, NO markClosed aunque `keepOpen: false` — evento `interrupted` (details `{ kind: "interrupted" }`; contenido: agente interrumpido, idle, pane abierto; decide con `herdr_prompt` para la continuación o `herdr_stop` para cerrar), record live, watcher re-armado (`rearm`), `dagr.note(agent, "interrupted — idle a la espera de decisión")`. Si el agente nunca vuelve a trabajar, el watcher queda colgado en rearm: hang aceptado (mismo trade-off documentado en watch.ts), escape `herdr_stop`. Con `agentGet` fallando en el check de D4 y grace activo → grace path igual (no se cierra con estado no verificable).

**D6 — dagr**: settle suprimido (D4) → sin escritura. `interrupted` (D5) → `note`; el intento sigue `working` (no es terminal). Settle final tras recovery → `settled` normal (auto-close según `keepOpen`). El `prompt` con interrupt crea el intento como cualquier prompt. Consistente con D0 de 005; W209 queda como red de cierre, no como flujo esperado.

**D7 — Respuesta de `herdr_prompt`**: siempre honesta por fases: prompt (encolado / blocked), interrupt (enviado / no necesario porque el estado era X / FALLO con el prompt SÍ encolado + hint de reintento). El fallo del send-keys NO lanza: el prompt ya está dentro y ocultarlo tras un throw sería mentir; el error viaja en el texto. Con grace activo, la respuesta avisa de que un settle sin recovery NO cerrará el despacho.

**D8 — Persistencia del grace: in-memory, sin appendEntry nuevo**. Resume/crash en la ventana esc→settle pierde el grace y el settle post-resume sigue la política normal (`close` si `!keepOpen`). Ventana estrecha; no justifica un tercer tipo de entry en la rama.

## Queda a criterio del builder

- Dónde vive `interruptGrace` exactamente (campo del record vs map paralelo en el módulo, siempre sin persistir).
- Nuevo wrapper `agentSendKeys` en herdr.ts + fixture `agent-send-keys.json`, o reutilización de `runOk` directa.
- Orden de tests (promptAgent con fakeRun por rutas `agent prompt`/`agent get`/`agent send-keys`; settle handler con los mismos fakes) y si el guard de D3 amerita test de concurrencia con `deferred()` (helpers).
- Wording exacto del evento `interrupted` y de las respuestas de la tool.

## Requisitos

- R1. `herdr_prompt(agent, text, interrupt: true)` con agente working: envía `agent prompt` ANTES que `agent send-keys <name> esc`; setea grace tras éxito del esc.
- R2. Mismo caso con agente `idle|done`: prompt normal, SIN esc, SIN grace; la respuesta lo dice.
- R3. Mismo caso con `blocked`: camino `agent_blocked` actual, SIN esc.
- R4. `send-keys` falla: sin throw; respuesta con prompt-encolado + fallo + hint; SIN grace.
- R5. Settle con `agentGet` → working: suprimido (cero side effects, sin dagr), handler devuelve true, grace clear.
- R6. Settle con grace + agente `idle|done`: evento `interrupted`, SIN close/cleanup/markClosed, record live, `dagr.note`, handler true, grace clear — también con `keepOpen: false` explícito.
- R7. Settle final sin grace ni working: comportamiento idéntico al actual (suite existente verde sin editar sus expectations de cierre).
- R8. Flujo interrupt→recovery: blip suprimido + settle final normal entregado; close según `keepOpen`.
- R9. Mapeo dagr según D6 (suprimido = nada; interrupted = note; final = settled).
- R10. `herdr_prompt` conserva errores actuales (agente desconocido / cerrado) y la nota sin-watcher de la issue #17; interrupt funciona igual sin watcher (send-keys no depende de vigilancia).

## Criterios de aceptación (Given/When/Then)

- GIVEN fakeRun con `agent prompt` ok, `agent get` → working, `agent send-keys` ok, y record keepOpen:false WHEN `promptAgent(interrupt: true)` THEN las calls van en orden prompt→get→send-keys con key `esc`, `interruptGrace` queda seteado y la respuesta menciona la interrupción.
- GIVEN `agent get` → idle WHEN `promptAgent(interrupt: true)` THEN cero calls a send-keys, sin grace, respuesta "no estaba trabajando".
- GIVEN prompt rechazado con `agent_blocked` WHEN `promptAgent(interrupt: true)` THEN mensaje blocked actual, cero send-keys.
- GIVEN `agent send-keys` exit 1 WHEN `promptAgent(interrupt: true)` THEN sin throw; la respuesta dice que el prompt quedó encolado y la interrupción falló (con hint); sin grace.
- GIVEN settle handler + `agent get` → working WHEN llega `settled (idle, output)` THEN nada emitido, cero close/cleanup/dagr, record intacto, handler devuelve true.
- GIVEN record con grace + `agent get` → idle WHEN settle THEN evento con details kind "interrupted", sin close ni markClosed (aún con keepOpen:false), `dagr.note` llamado, handler true, grace clear.
- GIVEN settle con grace y `agent get` que LANZA WHEN settle THEN grace path igual: evento interrupted, sin cierre (no se cierra con estado no verificable).
- GIVEN settle SIN grace, `agent get` → idle WHEN settle THEN emit final + close + markClosed (idéntico a hoy).
- GIVEN settle SIN grace y `agent get` que lanza WHEN settle THEN entrega como hoy (jamás suprimir sin verificación).
- GIVEN interrupt → blip (get working) → settle final (get idle) WHEN fluye THEN solo se entrega el evento final; con keepOpen:false el target se cierra UNA vez.
- GIVEN despacho live sin watcher WHEN `promptAgent(interrupt: true)` THEN esc enviado + nota sin-watcher (#17) presente en la respuesta.
- GIVEN agente cerrado/desconocido WHEN `promptAgent` THEN errores actuales intactos.

## Casos límite

- Esc que llega tras un settle natural (race get-working → settle → esc a pi ya idle): cierra overlay o no-op en pi; el prompt encolado arranca la ronda igual. Aceptado y documentado.
- Esc con un overlay abierto en el pane del agente: cierra el overlay, no interrumpe. Mitigado por el guard de D3 (solo working recibe esc; blocked nunca).
- `kind` ≠ pi: esc best-effort por convención de TUI; solo pi es contractual (tests fakes sobre pi).
- Resume entre esc y settle: grace perdido (D8) → el settle post-resume sigue política normal.
- Humano tecleando en el pane a la vez: esc no distingue fuente; no borra el editor (eso es ctrl+c, vetado).
- Doble interrupt con grace ya activo: re-set idempotente.
- `interrupt: true` con texto vacío: error de validación actual del texto, antes de cualquier side effect.
- Prompt con interrupt sobre agente ULTRA-rápido que settlea entre el agentPrompt y el agentGet: el get ve idle → sin esc → sin abort auto-infligido (el guard de D3 también es anti-race).

## Preguntas abiertas

Ninguna material. (El abort manual sin prompt encolado seguirá siendo settle final hasta que herdr exponga causa de settle — ya documentado como dependencia externa en No-objetivos.)
