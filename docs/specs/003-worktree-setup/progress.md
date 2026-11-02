# Ledger — plan: docs/specs/003-worktree-setup/plan.md

Rama: `feat/003-worktree-setup` (base: main @ bafab62). Spec: docs/specs/003-worktree-setup/spec.md.

## Pre-flight

- Interfaces T2→T4 (`parseSetupMode`/`detectSetupCommand`/`resolveRepoRoot`) y T3→T4 (`runSetup`) firmadas en el plan y consistentes. fakeRun enruta `bash -c` por `args.slice(0,2)` — OK. `DispatchRecord.setupCommand` se añade en T4 (registry.ts) — OK. Sin conflictos.

## Tareas

Task 1: complete (commit f7a7c78, tests: `npx vitest run tests/herdr.test.ts` → 17/17 + typecheck OK)
Task 2: complete (commit cc66da5, tests: `npx vitest run tests/setup.test.ts tests/worktree.test.ts` → 22/22 + typecheck OK)
  Ruling: parseSetupMode(undefined, true) → {kind:"auto"} (spec D1 "omitir = auto siempre" en worktree); undefined + false → {kind:"none"} (cero regresión en dispatches sin worktree) — coste si mal: dispatches existentes sin worktree errorarían.
Task 3: complete (commit f819ba2, tests: suite completa `npx vitest run` → 236/236 + typecheck OK)
  Ruling: fakeRun (helpers.ts) no incluía `file` en su clave de routing — mi pre-flight lo asumió mal ("bash -c" no matcheaba). Añadido fallback `<file> <args[0]>` con back-compat (clave args sigue ganando) — coste si mal: habría tocado las rutas de todos los tests.
  Ruling: test del mutex asertaba `started` síncronamente antes de la microtask del queue.then — fix: waitFor antes del expect; el fallo del primer test envenenaba la cola module-level para el segundo (por eso el timeout) — coste si mal: falsos rojos en cascada.
Task 4: complete (commit 9580501, tests: suite completa `npx vitest run` → 243/243 + typecheck OK)
  Ruling: con "omitir = auto siempre" (decisión humana), los 3 tests de worktree pre-existentes (repo mockeado /w/repo sin lockfiles reales) pasaron a necesitar setupCommand:"none" explícito — coste si mal: falsos rojos por el default opinionado, que ES el contrato spec.
  minor (deferred): WatchEvent y defaultResourceDirs importados sin uso en src/dispatch.ts L18/L22 (pre-existente, lens-only; tsc no reclama). → RESUELTO en T5: el delta del lens los escalaba a blocker en cada edit; fix de riesgo cero (tsc+suite verifican), imports limpiados.
Task 5: complete (commit $(git log --format=%h -1), tests: `npx vitest run` → 245/245 + typecheck OK)
