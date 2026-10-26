# Ledger — plan: docs/specs/001-dispatch-tool/plan.md

Rama: feat/dispatch-tool (repo nuevo, sin remote aún).

## Pre-flight

- T4 consume `Registry` antes de que exista T9. Ruling: crear `src/registry.ts` minimal (add/get/markClosed in-memory con la firma final de T9) ya en T4; T9 la extiende con persist/fromEntries/reconcile. — Evita placeholder paralelo y firma distinta entre tareas. — Coste si me equivoco: refactor leve en T9.

## Tareas


Task 1: complete (commit 157664d, tests: npx vitest run → 14/14, typecheck OK)
- Ruling: runOk inyecta timeoutMs 15s explícito en cada llamada de control (contrato del seam); agentStart 120s.
