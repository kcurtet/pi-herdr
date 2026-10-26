# Plan de implementación: pi-herdr 002 — skills/extensiones/defaults configurables

> Ejecutar con la skill `executing-plans`, tarea a tarea. Pasos con checkbox `- [ ]`.

**Objetivo:** Params `skills`/`extensions` (`true|false|lista`, default false) en `herdr_dispatch` con resolución de nombres, exención automática de `herdr-agent-state.ts`, y comando `/herdr` con wizard/autocompletado/persistencia para los 6 defaults.

**Arquitectura:** Resolver puro con `ResourceDirs` inyectables (dirs + settings.json + roots npm/git) → todo testeable contra árboles temporales. Config persistida estilo turnkit (`$PI_HOME/extensions-config/pi-herdr.json`) con merge puro `param > config > builtin`. El comando `/herdr` es shell fino sobre load/save + resolver.

**Stack:** igual que 001 (TS nodenext, vitest, TypeBox, Extension API pi 1.4.x).

**Spec:** `docs/specs/002-agent-resources/spec.md`.

## Restricciones globales

- Hereda TODAS las de 001 (`--no-wait`, `--no-focus`, name regex, error temprano D7, peerDep only).
- Exención de estado: `-e <state.ts>` auto cuando `--no-extensions` Y el fichero existe; jamás la pide el usuario.
- `kind ≠ "pi"` + skills/extensions → error ANTES de crear nada.
- `[]` = false; `true` = cero flags de esa categoría.
- Config inválida se ignora con warning en `/herdr`, nunca rompe el dispatch.
- Jerarquía estricta: param explícito > config persistida > builtin default.

## Foco de revisión

1. Flags de pi filtrados/escapados mal (task con `--` que se come args) → T3 test de args exactos.
2. Exención duplicada o ausente (child sin estados exactos) → T3 tests con stateExt presente/ausente.
3. Merge invertido (config pisando param) → T2 tests param>config por cada key.
4. Resolver resolviendo contra dirs del PADRE equivocados (agentsSkills vs piSkills orden) → T1 tests de orden y empates.
5. Wizard escribiendo config corrupta / reset parcial roto → T4 tests roundtrip y reset por key.

## Estructura de ficheros

- Crear: `src/resources.ts` (resolver D1/D2), `src/config.ts` (tipo + load/save + merge), `src/piargs.ts` (builder de args D3).
- Modificar: `src/dispatch.ts` (input + piArgs + record), `src/herdr.ts` (agentStart piArgs), `src/registry.ts` (record.piArgs opcional + display), `index.ts` (schema skills/extensions + `/herdr` + wiring config), `README.md`.
- Tests: `tests/resources.test.ts`, `tests/config.test.ts`, `tests/piargs.test.ts`, añadir a `tests/dispatch.test.ts` e `tests/index.test.ts`.

---

### Tarea 1: Resolver de recursos (D1/D2)

**Ficheros:** Crear `src/resources.ts`, `tests/resources.test.ts`.

**Interfaces (Produce):**
```ts
export interface ResourceDirs { piSkills: string; agentsSkills: string; extensions: string; settingsJson: string; stateExt: string; npmNodeModules: string; gitRoot: string }
export function defaultResourceDirs(env: Record<string,string|undefined>): ResourceDirs;
// PI_HOME (default ~/.pi/agent) → piSkills, extensions, settingsJson, stateExt, npmNodeModules, gitRoot; HOME → agentsSkills
export function resolveSkills(items: string[], d: ResourceDirs): string[];   // throw ResourceError
export function resolveExtensions(items: string[], d: ResourceDirs): string[];
```

- [ ] **P1: test ROJO** — árbol temporal: piSkills/a/SKILL.md, agentsSkills/b/SKILL.md, piSkills/c.md, agentsSkills/a/SKILL.md (empate → gana pi), extensions/loc.ts, settings.json fixture con `packages: ["npm:pi-lens", "git:kcurtet/pi-commit", "git:https://github.com/kcurtet/pi-monitor", "git:github.com/o/r"]` + `extensions: ["/abs/x.ts"]`, npmNodeModules/pi-lens/package.json (pi.extensions), gitRoot/github.com/kcurtet/pi-commit/package.json. Casos: nombre→piSkills; nombre→agentsSkills; path `/x` directo ok; path inexistente → throw; `b` inexistente en ambos → throw lista dirs; extension: `loc` → extensions/loc.ts; `pi-lens` → npm path+entry; `pi-commit` → git path (host inferido github.com) + entry; `pi-monitor` → git (URL completa); `builtin:x` → tal cual; `github:foo/bar` sin copia → throw sugiriendo `pi list`; source git sin package.json → throw claro.
- [ ] **P2: run FAIL → P3: implementar → P4: PASS → P5: commit** `feat: resolver de skills y extensiones con packages[]+extensions[]`

### Tarea 2: Config store + merge (D7/D8)

**Ficheros:** Crear `src/config.ts`, `tests/config.test.ts`.

**Interfaces (Produce):**
```ts
export interface DispatchDefaults { skills?: boolean | string[]; extensions?: boolean | string[]; topology?: "tab"|"pane"|"workspace"; kind?: string; keepOpen?: boolean; worktree?: boolean }
export function loadDefaults(path: string): { defaults: DispatchDefaults; warnings: string[] }; // JSON inválido/valores no válidos → warning, nunca throw
export function saveDefaults(path: string, d: DispatchDefaults): void;                          // mkdir -p, JSON tab
export function mergeInput(param: Partial<DispatchInput-ish>, config: DispatchDefaults): ResolvedDefaults; // param>config>builtin por key
```
- Consume: tipos de input de dispatch (001).

- [ ] **P1: test ROJO** — merge: cada key param>config>builtin (6 keys); config skills:true + param sin skills → true; param `[]` cuenta como explícito (→ false); loadDefaults: fichero inexistente → {}; JSON roto → warning; topology:"x" → warning + ignorado; save/load roundtrip exacto.
- [ ] **P2: FAIL → P3: impl → P4: PASS → P5: commit** `feat: config store con merge param>config>builtin`

### Tarea 3: piArgs + wiring en dispatch (D3/D4/D5)

**Ficheros:** Crear `src/piargs.ts`, `tests/piargs.test.ts`; modificar `src/herdr.ts` (agentStart `piArgs?: string[]` tras `--`), `src/dispatch.ts` (input skills/extensions, config merge, piArgs al record), `tests/dispatch.test.ts`.

**Interfaces (Produce):**
```ts
export function buildPiArgs(resolved: { skills: boolean|string[]; extensions: boolean|string[]; kind: string }, d: ResourceDirs): string[];
// skills:false → --no-skills; true → nada; lista → --no-skills --skill p...
// extensions análogo + auto -e <stateExt> si existe (detrás de --no-extensions)
// kind!=="pi" + (skills|extensions ≠ true por param/config explícito... NO: solo si el RESULTADO añade flags) → throw
```
Ojo D4: el gate es "params presentes" (param o config) con kind≠pi, aunque resuelvan a "true" — spec R8 dice `skills:["x"]` + claude → error. Simplificación honesta: si kind≠pi Y (skills o extensions definidos en param O config) → throw. Documentar en el paso.

- [ ] **P1: test ROJO** — args exactos por caso: default (sin nada) → `["--no-skills","--no-extensions","-e",state]`; skills:true → sin flags skills; lista skills → `--no-skills --skill /a --skill /b`; stateExt ausente → sin `-e`; extensions lista + builtin + estado → orden flags; kind:"claude" + skills param → throw ANTES de resolver; dispatch test: record.piArgs guardado; agentStart recibe `--` + piArgs; error de resolución → cero llamadas de creación.
- [ ] **P2: FAIL → P3: impl → P4: PASS + suite → P5: commit** `feat: piArgs con exención de estado y gate kind!=pi`

### Tarea 4: Comando /herdr (D6)

**Ficheros:** Modificar `index.ts` (registerCommand), `tests/index.test.ts`.

**Interfaces:**
- Consume: loadDefaults/saveDefaults/mergeInput (T2), resolver (T1), `AutocompleteItem` de `@earendil-works/pi-tui` (patrón turnkit).

- [ ] **P1: test ROJO** — fake ctx con `ui.select` programable y `ui.notify` capturador: bare `/herdr` → notify con 6 keys + origen (config/builtin) por key; `config skills true` → saveDefaults con skills:true + notify; `config skills a,b` → lista; `config topology pane` → set; `reset` → vacía; `reset skills` → solo esa; key inválida → error; wizard: `config` con UI → secuencia de selects programada escribe config completa; headless (`ctx.hasUI=false`) → usage, sin crash; `getArgumentCompletions("config sk")` → key skills; `("config skills ")` → true/false (+nombres si dirs existen); `("reset sk")` → skills.
- [ ] **P2: FAIL → P3: impl → P4: PASS → P5: commit** `feat: comando /herdr con wizard, reset y autocompletado`

### Tarea 5: Schema, herdr_agents, README y smokes

**Ficheros:** Modificar `index.ts` (schema skills/extensions con unión Boolean|Array, defaults desde config al arrancar), `src/registry.ts`/`listDispatches` (piArgs en línea si presentes), `README.md`.

- [ ] **P1: test ROJO** — schema: `skills`/`extensions` unión boolean|array en herdr_dispatch; listDispatches incluye piArgs cortos; factory registra comando `herdr`.
- [ ] **P2: FAIL → P3: impl → P4: PASS + typecheck**
- [ ] **P5: smoke carga** — `pi --extension . --model ollama/gemma4 -p "responde solo: ok"` limpio.
- [ ] **P6: E2E vivo** — dentro de herdr: dispatch default (settle + auto-close OK con flags activos) Y dispatch `skills:["using-skills"]` (settle OK). Verificar piArgs en herdr_agents. Registrar en progress.md.
- [ ] **P7: commit** `feat: 002 completa — schema, display, README, smokes`

## Auto-revisión

- **Cobertura:** R1→T3, R2→T3, R3→T1/T3, R4→T1/T3, R5→T5(E2E), R6→T2/T3, R7→T2, R8→T3, R9→T4. Casos límite: empate dirs T1, git sin package.json T1, [] =false T2/T3, state ausente T3, config inválida T2/T4, headless T4.
- **Consistencia:** `ResourceDirs` T1↔T3/T4; `DispatchDefaults` T2↔T3/T4/T5; `buildPiArgs` T3 consumido por dispatch; piArgs → `agentStart` (T3) → record (T3) → display (T5).
- **Proporción:** firma de `buildPiArgs` y gate D4 simplificado documentados en la propia tarea.
