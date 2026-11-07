# Ledger — plan: docs/specs/005-auto-dagr/plan.md

Rama: feat/005-auto-dagr (base: main @ 668d3ec). Spec: docs/specs/005-auto-dagr/spec.md.

## Pre-flight

- Probes con `dagr check --strict` (binario real del plugin) fijaron los rulings R-A..R-G del plan: E150 prohíbe tarea done + intento settled_unverified (→ tarea settled_unverified); no existen intentos blocked/canceled (→ tarea blocked con intento working; tarea canceled con intento lost+receipt); --strict hace fatales los warnings (locator/liveness/timestamps/cause obligados de facto); campos top-level extra tolerados (→ linaje dentro del run.json, sin meta.json).
- API pi verificada en tipos: execute(toolCallId, params, signal, onUpdate, ctx) — 5º arg ctx con sessionManager.getSessionId(); session_start handler recibe ctx idem. Fallback PI_SESSION_ID.
- Env: inyección solo vía --env K=V al crear topología (dato verificado por el humano).
- Ejecución: directo por el orquestador (sin builders despachados en esta sesión); review con contexto fresco vía pi -p antes del merge.

## Tareas

