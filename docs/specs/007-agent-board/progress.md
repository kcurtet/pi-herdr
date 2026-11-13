# Ledger — plan: docs/specs/007-agent-board/plan.md

Task 1: complete (commits dd18cb4, tests: npm test → 398 passed / 18 files, tsc --noEmit limpio)

Task 2: complete (commits 7f6bef0, tests: npm test → 412 passed / 19 files, tsc --noEmit limpio)

Ruling: applyTickStatus mapea "done" a idle (equivalente display de terminal) y cualquier otro status desconocido mantiene el actual — D10 no lista done/unknown explícitamente pero los tests del plan exigen ("working","done")→"idle" y ("working","unknown")→"working"; coste si me equivoco: un agente done se pintaría idle en vez de mantener working — irrelevante, done es terminal.

Ruling: los updates de este ledger van en commits `chore(ledger)` propios — el hash del commit de tarea solo existe tras el commit, y un --amend lo invalidaría; coste si me equivoco: historial con 3 commits chore extra, inofensivos.
