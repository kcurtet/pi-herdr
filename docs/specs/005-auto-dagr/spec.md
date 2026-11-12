# 005 — Auto-dagr: el grafo del enjambre grabado por pi-herdr

## Contexto

La persona trabaja con workspaces de herdr: cada proyecto tiene un orquestador (sesión pi con pi-herdr) que lanza trabajadores, y Nyx (la operadora por voz) lanza workspaces enteros por orden hablada. Ya hay visor: **herdr-dagr** (instalado) dibuja un DAG en un pane desde un `run.json` con contrato v3 (`CONTRACT.md` de aemrebarut/herdr-dagr; proyectos recursivos con `parent`, tareas, intentos, estados, evidence tiers).

Lo que falta: que el grafo **se graba solo y siempre bien** — sin disciplina de agente — y que los tres niveles (Nyx → orquestadores → trabajadores) se vean como **un solo árbol integrado**.

Decisión de arquitectura (humano, 2026-11-07): el punto de grabación es **pi-herdr** (ve la causalidad real: quién nace, para qué, cada ronda, cada settle), no un plugin de herdr (que solo ofrece panes/acciones, sin hooks de ciclo de vida — habría que hacer polling).

## Objetivo

«Nyx, abre el proyecto X y haz Y» → workspace + orquestador + trabajadores trabajando, y en el pane de dagr (abierto sobre el `composed.json`) el árbol completo naciendo y avanzando en vivo, sin que ningún agente sepa que dagr existe.

## Objetivos

1. Cada sesión pi con pi-herdr mantiene **su propio `run.json`** (contrato v3) actualizado automáticamente por los eventos de sus tools.
2. **Linaje**: todo agente despachado sabe (por entorno) de qué run depende y bajo qué tarea cuelga; su sesión graba esa referencia.
3. **Vista compuesta**: un `composed.json` por raíz de linaje que integra hijos bajo sus nodos, regenerado atómicamente; el pane de dagr sobre él muestra los tres niveles.
4. Cero cooperación exigida a los agentes: el agente puede seguir usando pi-herdr como siempre; el grafo sale igual.

## No-objetivos

- Cambiar dagr ni su contrato; solo escribir ficheros válidos v3.
- Semántica fina en el auto-grafo (gates, evidence tiers, políticas): el auto-graba estados e intentos ESTRUCTURALES; los tiers/gates los sigue poniendo un productor humano/agente si quiere (futuro).
- Grabar agentes que no pasan por pi-herdr (sesiones manuales, claude sin extensión): fuera del alcance v1.
- UI nueva: visor = dagr.

## Decisiones de implementación

**D0 — Mapeo autoritativo de estados herdr → contrato v3** (resuelto en builder-check):
- nace el despacho → tarea `working`, intento a1 `working`.
- settle (idle/done) → intento terminal con `outcome: settled_unverified` y `evidence: asserted` (el agente lo afirmó; nadie lo verificó — el contrato prohíbe tratarlo como éxito verificado); tarea `done`.
- blocked → intento `blocked` (con `unblock owner: operator` si W205 lo pide); tarea `blocked`.
- gone/muerte (o reconcile tras resume que cierra despachos muertos) → intento `lost` + tarea `failed` (nota `reconciled` si aplica).
- `herdr_stop` y cierre de sesión (shutdownCleanup) → intento `canceled` + tarea `canceled` (nota `fin de sesión` en el cierre normal).
- cierre del pane con MÁS de un intento vivo (issue #20: `herdr_prompt` sobre turno colgado) → el principal cierra con la transición (settle: el ÚLTIMO vivo, que E150 exige coincidir con el estado terminal de la tarea; gone/canceled: lost) y cada intento que siga `working` se reconcilia `lost` con receipt de la causa del cierre + evento `attempt_settled` — sin stale attempts (W209).
- `lost` NUNCA es estado de tarea (E112): es outcome de intento.

**D1 — Eventos grabados.** En la sesión pi que carga pi-herdr:
- `herdr_dispatch(<agente>, task)` → crea tarea (id estable derivado del nombre del agente + contador) con `kind: "agent"`, estado derivado (nace `working`/`blocked` según respuesta) y etiqueta = primera línea de la task; intento a1.
- `herdr_prompt(<agente>, text)` → nuevo intento (a2, a3…) en la tarea del agente, con nota = primera línea del prompt.
- Settle del **watcher interno de despacho** (settle.ts; también los avisos de `herdr_watch` en global SOBRE agentes que esta sesión despachó) → actualiza esa tarea según D0.
- `herdr_stop`, reconcile tras resume y shutdownCleanup → según D0 (canceled / lost+failed).
- `herdr_watch` sobre agentes AJENOS no crea nodos ni toca el run (v1: el grafo no se contamina con lo que esta sesión no despachó).
- Hooks: settle handler, Watches.onEvent (solo tareas propias), reconcile, abandonDispatch y shutdown — no solo las 4 tools.
- Estados fuente: los reales de herdr (agent list/watch), jamás lo que el agente afirma.

**D2 — Fichero por sesión.** Ruta: `~/.local/state/herdr-dagr/<workspace-label>/<session-id>.json` (directorio propio del plugin/estado; workspace label de `herdr workspace list` o del contexto inyectado). Escritura SIEMPRE tmp→rename en el mismo directorio. Cada fichero declara su proyecto raíz (la sesión) y sus tareas.

**D2b — pi-herdr en los hijos.** El default de dispatch es `extensions: false` (--no-extensions). Con `herdr_dagr` activo, `buildPiArgs` auto-exime pi-herdr en los hijos (patrón de herdr-agent-state.ts) para que toda sesión despachada registre su run y su linaje sin cooperación. Coste asumido: las tools de pi-herdr en el contexto de cada hijo. Escape: `herdr_dagr_children: false` las excluye (el grafo pierde esos subárboles).

**D3 — Linaje por entorno.** `herdr_dispatch` inyecta al hijo: `DAGR_RUN=<ruta absoluta del run de la sesión despachante>` y `DAGR_TASK=<id de tarea asignado>`. La sesión hija, al escribir su primer run, registra `parent_run`/`parent_task` (metadatos propios fuera del contrato v3 — viven junto al fichero en un `meta.json` hermano, o campo no-contratado tolerado por dagr check — a decidir por el builder leyendo el contrato) y su proyecto raíz lleva `parent` solo en la vista compuesta.

**D4 — Composición.** Tras cada escritura del propio run, la sesión regenera el composed DE SU RAÍZ — solo si su linaje tiene hijos (una sesión sin hijos no compone: no hay árbol que integrar). Anidamiento v3 (parent es siempre project): por cada `parent_task`, el composer crea un **proyecto wrapper** con el id y título de esa tarea, re-homa la tarea del padre dentro del wrapper (`task.project`) y el proyecto raíz del hijo cuelga del wrapper (`parent`). Resultado visual: workspace-hijo bajo SU tarea. Ids prefijados por sesión (sin colisiones). Ruta: `composed-<raíz>.json` junto a los runs (p.ej. `composed-nyx.json`); varias raíces conviven y el picker de dagr elige. Atómico tmp→rename; último-gana (artefacto derivado). Ciclo imposible (parent_task huérfano por fichero corrupto): se salta el hijo y se loguea.

**D5 — Activación y config.** On por defecto (el valor está en que sea automático); `herdr_dagr: false` en la config de pi-herdr lo apaga. `DAGR_RUN` heredado no se re-inyecta (una sesión hija que despacha a su vez usa SU run). Validación blanda: si `dagr` está en PATH o en la ruta del plugin instalado, `dagr check --strict` tras escribir tmp (solo warning al log si falla; el rename ocurre igual — nunca bloquear una tool por el grafo).

**D6 — Nyx (fuera de este repo, skill).** Runbook «abrir proyecto» = `herdr_dispatch(topology: workspace, keepOpen)` con contexto completo. Al pasar por la tool, el workspace queda grabado en su run. Se implementa en el repo nyx tras este 005.

## Restricciones

- TypeScript/Node como el resto de pi-herdr; suite existente verde; tests nuevos con eventos de tools simulados (sin herdr real).
- Ninguna tool de pi-herdr puede fallar ni retrasarse por el grabado: si algo del grafo rompe, se loguea y la tool sigue.
- Contrato v3 válido SIEMPRE que se publique (tmp validado o construido por elementos que garantizan validez).

## Criterios de aceptación (Given/When/Then)

- **A1** G: sesión con pi-herdr. W: `herdr_dispatch("builder", "task X")`. T: su run.json contiene tarea con id estable, kind agent, intento a1, estado de herdr real.
- **A2** G: tarea existente. W: `herdr_prompt` y luego llega el settle del watch. T: intentos crecen (a2) y el estado pasa a done/blocked real.
- **A3** G: dispatch con `topology: workspace`. T: el hijo recibe DAGR_RUN/DAGR_TASK; su primer run registra el linaje; el composed de la raíz muestra el workspace como proyecto anidado bajo la tarea de Nyx.
- **A4** G: dos sesiones escribiendo a la vez. T: ambos run.json íntegros (tmp+rename); composed.json termina siendo un fichero válido parseable por dagr (aunque sea la versión de quien escribió último).
- **A5** G: `herdr_dagr: false`. T: ni ficheros ni inyección de entorno; tools idénticas.
- **A6** G: dagr disponible. W: escritura. T: `dagr check --strict` pasa sobre el fichero publicado (o warning logged, nunca tool rota).
- **A7** G: flujo completo real (Nyx abre proyecto → orquestador lanza 2 trabajadores). T: composed.json muestra los tres niveles; el pane de dagr lo dibuja en vivo.

## Casos límite

- Agente despachado que muere sin settle (`gone`): estado `lost`, intento cerrado.
- Nombre de agente repetido tras cleanup del registry: ids estables por sesión+nombre+contador, no por pane.
- Watch de un agente ajeno: no crea nodo ni actualiza nada (v1).
- Run hijo creado eagerly en session_start (el orquestador aparece bajo su tarea aunque aún no haya despachado); sesión sin eventos: run mínimo igualmente válido.
- `herdr_dispatch` que falla: no crea tarea (o la crea `failed` con causa — decidir por consistencia con A1).
- Sesión huérfana sin DAGR_RUN (orquestador lanzado a mano): su run es raíz propia; aparece como árbol aparte (picker de dagr).
- Composed con ciclo imposible (parent_task inexistente por fichero corrupto): se salta ese hijo y se loguea.

## Qué queda a criterio del builder

- Ubicación exacta de los metadatos de linaje (meta.json vs campo tolerado).
- Cómo derivar ids estables y legibles (prefijos de sesión cortos).
- Debounce de escrituras (ráfaga de eventos → una escritura por tick).

## Preguntas abiertas

- ¿Vale la pena exponer `herdr_dagr_task(id, estado, nota)` como tool para que un agente productor enriquezca su propio grafo (semántica)? Solo apuntar; no v1.
