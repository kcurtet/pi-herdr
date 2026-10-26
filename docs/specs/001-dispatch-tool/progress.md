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
Task 5: complete (commit 832fdca, tests: npx vitest run → 53/53, typecheck OK)
Task 6: complete (commit 296c79c, tests: 58/58, typecheck OK)
Task 7: complete (commit 49df3e6, tests: 62/62, typecheck OK)
- Ruling T8: merged-check lazy (solo con status limpio se pregunta branch --merged); decideCleanup sigue como tabla de decisión pura usada por cleanupWorktree.
Task 8: complete (commit e0c76c0, tests: 73/73, typecheck OK)
Task 9: complete (commit eff9198, tests: 80/80, typecheck OK)
- Ruling T10: API real pi 1.4 appendEntry(customType, data) y entries {type:'custom'} — Registry adaptado (no objeto único). Smoke carga: pi --extension . --model ollama/gemma4 → ok. E2E vivo: dispatch real, settle con output, auto-close verificados.
Task 10: complete (commit fd472de, tests: 87/87, typecheck OK, smoke carga OK, E2E vivo OK — agente responde-solo-palabra settled 'listo' + auto-close)

## Revisión final (fresco, 2 ejes)

Estándares (7 smells, todos judgement calls → minors diferidos): dup bloque cleanup ×3, settleFor param muerto, void handle, liveNames dup, clump {repo,dir,branch}, middle man readAgent, colocación SettleHandler. Nota: nextTaskId módulo → dup tras resume (sin rotura: eventos por agent name).
Spec: CRÍTICO worktree repo=rec.cwd=worktree.dir → merged-check siempre true (D5/R6 violadas). Parcial: herdr_stop no para watcher (D1, auto-mitigado por gone). D3 batching descartado por plan (ruling). Orphan worktree en rollback (start/prompt fallan tras crear worktree → invisible). Menores defer: session_start re-appenda entries, settle traga closeTarget fail, agentPrompt inicial ignora retorno blocked.
Fix pass: (A) worktree lleva repo propio; (B) stopDispatch para watcher antes de cerrar; (C) rollback limpia worktree huérfano + nota en error.
- Fix pass revisión: (A) CRÍTICO worktree.repo en DispatchRecord, cleanup contra repo padre (RED→GREEN 89/89); (B) stopDispatch watcher-first (D1); (C) rollback cleanup+nota. Menors defer: re-append session_start, settle traga close fail, smells estándar, nextTaskId.
