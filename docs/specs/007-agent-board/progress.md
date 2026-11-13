# Ledger — plan: docs/specs/007-agent-board/plan.md

Task 1: complete (commits dd18cb4, tests: npm test → 398 passed / 18 files, tsc --noEmit limpio)

Task 3: complete (commits 1902cf8, tests: npm test → 423 passed / 19 files, tsc --noEmit limpio; @earendil-works/pi-tui@1.4.0 --save-exact en devDependencies)

Ruling: la task truncada vive en la propia línea completa (D3 "<task truncada>") y se muestra recortada solo si quedan ≥8 chars de contenido visible; por debajo, el segmento cae entero — el plan no fija el umbral (formato exacto es a criterio del builder) y "c..." no informa; coste si me equivoco: en widths muy justos se ve la task algo antes o después de lo ideal, sin efecto en el resto del degradado.

Ruling: truncateToWidth de pi-tui embebe resets ANSI (\x1b[0m) junto al ellipsis — las aserciones de CONTENIDO de tests comparan texto sin escapes ANSI; visibleWidth los ignora, así que las medidas no se ven afectadas.

Task 2: complete (commits 7f6bef0, tests: npm test → 412 passed / 19 files, tsc --noEmit limpio)

Ruling: applyTickStatus mapea "done" a idle (equivalente display de terminal) y cualquier otro status desconocido mantiene el actual — D10 no lista done/unknown explícitamente pero los tests del plan exigen ("working","done")→"idle" y ("working","unknown")→"working"; coste si me equivoco: un agente done se pintaría idle en vez de mantener working — irrelevante, done es terminal.

Ruling: los updates de este ledger van en commits `chore(ledger)` propios — el hash del commit de tarea solo existe tras el commit, y un --amend lo invalidaría; coste si me equivoco: historial con 3 commits chore extra, inofensivos.
