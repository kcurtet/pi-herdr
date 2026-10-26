# Ledger — plan: docs/specs/001-dispatch-tool/plan.md

Rama: feat/dispatch-tool (repo nuevo, sin remote aún).

## Pre-flight

- T4 consume `Registry` antes de que exista T9. Ruling: crear `src/registry.ts` minimal (add/get/markClosed in-memory con la firma final de T9) ya en T4; T9 la extiende con persist/fromEntries/reconcile. — Evita placeholder paralelo y firma distinta entre tareas. — Coste si me equivoco: refactor leve en T9.

## Tareas


Task 1: complete (commit 157664d, tests: npx vitest run → 14/14, typecheck OK)
- Ruling: runOk inyecta timeoutMs 15s explícito en cada llamada de control (contrato del seam); agentStart 120s.
- Ruling T2: 2 tests iniciales mal concebidos corregidos al contrato del plan (slug de 32 chars solo surge de palabras largas; fallback dispatch-N sube desde vivos+1, no el menor libre).
Task 2: complete (commit ece041c, tests: npx vitest run → 28/28)
- Ruling T3: WatchDeps sin emit (la entrega de mensajes vive en settle/T5, que recibe onEvent ya clasificado); fake-herdr.sh PATH shim innecesario — spawnWait inyectable cubre el spawn real con bash en tests.
Task 3: complete (commit 2cf10c4, tests: npx vitest run → 35/35)
- Ruling T4: DispatchDeps toma settleFor+spawnWait inyectables (en vez de emit) — el handler de settle se compone en T5; adapter (ev)=>settle(name,ev).
Task 4: complete (commit e6935fb, tests: npx vitest run → 43/43)
