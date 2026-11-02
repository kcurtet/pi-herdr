# Ledger — plan: docs/specs/003-worktree-setup/plan.md

Rama: `feat/003-worktree-setup` (base: main @ bafab62). Spec: docs/specs/003-worktree-setup/spec.md.

## Pre-flight

- Interfaces T2→T4 (`parseSetupMode`/`detectSetupCommand`/`resolveRepoRoot`) y T3→T4 (`runSetup`) firmadas en el plan y consistentes. fakeRun enruta `bash -c` por `args.slice(0,2)` — OK. `DispatchRecord.setupCommand` se añade en T4 (registry.ts) — OK. Sin conflictos.

## Tareas

