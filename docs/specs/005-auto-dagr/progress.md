# Ledger — plan: docs/specs/005-auto-dagr/plan.md

Rama: feat/005-auto-dagr (base: main @ 668d3ec). Spec: docs/specs/005-auto-dagr/spec.md.

## Pre-flight

- Probes con `dagr check --strict` (binario real del plugin) fijaron los rulings R-A..R-G del plan: E150 prohíbe tarea done + intento settled_unverified (→ tarea settled_unverified); no existen intentos blocked/canceled (→ tarea blocked con intento working; tarea canceled con intento lost+receipt); --strict hace fatales los warnings (locator/liveness/timestamps/cause obligados de facto); campos top-level extra tolerados (→ linaje dentro del run.json, sin meta.json).
- API pi verificada en tipos: execute(toolCallId, params, signal, onUpdate, ctx) — 5º arg ctx con sessionManager.getSessionId(); session_start handler recibe ctx idem. Fallback PI_SESSION_ID.
- Env: inyección solo vía --env K=V al crear topología (dato verificado por el humano).
- Ejecución: directo por el orquestador (sin builders despachados en esta sesión); review con contexto fresco vía pi -p antes del merge.

## Tareas

Task 1 (dagrdoc): complete — commit e1ab4ee (14 tests, suite 293/293, tsc 0; golden con binario real incluido)
Task 2 (recorder): complete — commit 64be5a7 (15 tests, 308/308; amend: bug adopción fichero corrupto — flag `adopted`, reescribe eager)
Task 3 (config+D2b): complete — commit c05e277 (10 tests, 318/318; entryFile() normaliza dir→package entry/index.ts para -e)
Task 4 (linaje en dispatch): complete — commit 0afd510 (10 tests, 328/328; dispatch refactorizado en dispatchArmed para env+release)
Task 5 (ciclo D0): complete — commit 7f48fcb (9 tests, 337/337)
Task 6 (Watches onOwnEvent): complete — commit 07d5c29 (3 tests, 340/340)
Task 7 (compositor+wiring): complete — commits cece575 + 808ab79 (15 tests, 355/355, tsc 0)
  Ruling E2E: el primer wiring componía el PROPIO run (composeFrom(rp)) en vez de SU raíz — fix: findRoot(io, rp) → composeFrom(root). Test de regresión del patrón incluido.
  Smokes reales: (a) 3 runs manuscritos + composer → check --strict limpio + view --snapshot renderiza los 3 niveles con wrappers (bloqueado/unverified visibles); (b) headless `pi -ne --extension . -p` dentro de herdr → run eager creado y strict-válido; (c) E2E linaje: sesión headless HIJA con DAGR_RUN/DAGR_TASK heredados → graba lineage y regenera el composed de la raíz SOLO (proyectos `<pfx>-root` bajo w-abre-1, strict ✓).
  Pendiente humano: A7 con Nyx en vivo (voz → workspace + orquestador + trabajadores, pane de dagr sobre composed). Nota: A7 mecánico verificado por partes (c) + unitarios; el flujo de voz es skill de nyx (D6, fuera de este repo).

## Incidencias del ciclo

- Doble commit rojo por pipes que enmascaraban exit codes (amend en ambos; lección anotada: checkear exit explícito).

