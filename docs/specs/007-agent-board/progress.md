# Ledger — plan: docs/specs/007-agent-board/plan.md

Task 1: complete (commits dd18cb4, tests: npm test → 398 passed / 18 files, tsc --noEmit limpio)

Review: SPEC-OK (revisor fresco) + Estándares 2 duros/4 judgement calls — fixes 1-4 aplicados, 2 minors diferidos.

Minor diferido (a): especialización `key === "board"` en dos sitios de command.ts (saveValue y reset por-key) — reunirla en un onChange por key dentro de VALUE_SPECS sería Speculative Generality inversa para una sola clave con callback; coste de diferir: si llega una segunda clave con efecto de sesión, tocar 3 sitios en vez de 1.

Minor diferido (b): `opts` de BoardUi.setWidget sin uso desde board.ts — se mantiene por fidelidad estructural al API real de pi (los fakes de test calcan la firma, así el wiring no miente sobre lo que acepta); candidata a poda futura si pi estabiliza la firma sin options.

Task 7: complete (commits 4821a0f, tests: npm test → 447 passed / 19 files, npm run typecheck limpio; README con sección Agent board: estados evento/tick, degradado, config board, nota solo-TUI)

Plan completo (T1–T7): 7 commits de tarea + 7 chore(ledger). Sin pendientes.

Task 6: complete (commits 1e9ca86, tests: npm test → 447 passed / 19 files, tsc --noEmit limpio)

Ruling: T6 rompe un TERCER pin que el plan no listaba — tests/piargs.test.ts helper r() construye un ResolvedDefaults literal y gana `board: "on"`; actualizado con el mismo rationale que el pin mergeInput-builtin (board viaja por el pipeline de defaults); coste si me equivoco: ninguno, es el mismo patrón.

Ruling: el test de wiring de index (enabled inicial del partial crudo + on/off en caliente vía el comando real de la factory) va MÁS ALLÁ del paso 1 del plan (que solo pedía config/command/board) — cubre R10 de punta a punta sin tocar la suite pre-007; coste: 2 tests extra que acoplan index.test.ts a CommandCtxLike (fácil de mantener).

Task 5: complete (commits b4ddafe, tests: npm test → 438 passed / 19 files, tsc --noEmit limpio)

Ruling: restaurado sin entrada en el map se reconcilia con display inicial "working" implícito (liveRecords/lines ya lo hacen así) — así el primer tick puede DEGRADARLO a idle/blocked según lo que herdr reporte; el test de R13 lo fija; coste si me equivoco: un restaurado arranca pintando WORKING unos ms hasta el tick inmediato del wiring (imperceptible y conservador).

Task 4: complete (commits 74e7587, tests: npm test → 433 passed / 19 files, tsc --noEmit limpio)

Ruling: BoardComponent gana un 4º parámetro opcional `maxLines` (default 5) — la firma del plan no cablea el maxLines de BoardDeps al componente y sin él /herdr no podría configurar el cap; backwards-compatible con los call-sites firmados (lines, now, paint); coste: desviación mínima de la firma congelada.

Ruling: refresh() invalida el cache del componente TAMBIÉN en la rama de clear (y ANTES de clearWidget, que suelta la ref) — el plan no lo pide pero sin ello un render posterior al vaciado devolvería líneas fantasma del cache; coste si me equivoco: ninguno observable (invalidate en widget ya no pintado es gratis).

Ruling: los tests unitarios del Board replican el orden real del wiring (registry.add(rec) ANTES de board.onDispatched(rec)) vía helper dispatchB — la membresía del board sale del registry y onDispatched solo pinta; el plan asume ese contexto sin decirlo explícitamente.

Task 3: complete (commits 1902cf8, tests: npm test → 423 passed / 19 files, tsc --noEmit limpio; @earendil-works/pi-tui@1.4.0 --save-exact en devDependencies)

Ruling: la task truncada vive en la propia línea completa (D3 "<task truncada>") y se muestra recortada solo si quedan ≥8 chars de contenido visible; por debajo, el segmento cae entero — el plan no fija el umbral (formato exacto es a criterio del builder) y "c..." no informa; coste si me equivoco: en widths muy justos se ve la task algo antes o después de lo ideal, sin efecto en el resto del degradado.

Ruling: truncateToWidth de pi-tui embebe resets ANSI (\x1b[0m) junto al ellipsis — las aserciones de CONTENIDO de tests comparan texto sin escapes ANSI; visibleWidth los ignora, así que las medidas no se ven afectadas.

Task 2: complete (commits 7f6bef0, tests: npm test → 412 passed / 19 files, tsc --noEmit limpio)

Ruling: applyTickStatus mapea "done" a idle (equivalente display de terminal) y cualquier otro status desconocido mantiene el actual — D10 no lista done/unknown explícitamente pero los tests del plan exigen ("working","done")→"idle" y ("working","unknown")→"working"; coste si me equivoco: un agente done se pintaría idle en vez de mantener working — irrelevante, done es terminal.

Ruling: los updates de este ledger van en commits `chore(ledger)` propios — el hash del commit de tarea solo existe tras el commit, y un --amend lo invalidaría; coste si me equivoco: historial con 3 commits chore extra, inofensivos.
