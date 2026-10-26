# Spec 002 — Skills, extensiones y defaults configurables del agente despachado

## Contexto

pi-herdr v0.1 despacha agentes pi que heredan TODO el descubrimiento nativo: skills de `~/.pi/agent/skills`, `~/.agents/skills` y del proyecto; extensiones de settings/`~/.pi/agent/extensions`. El humano quiere agentes despachados **limpios por defecto**, con herencia total o listado explícito como opt-in, y un **menú de configuración** para fijar los defaults (estilo turnkit: wizard + autocompletado + persistencia).

Hechos verificados en vivo (probe con child real + binario):
- La CLI de pi soporta el control nativo: `--no-skills`/`--skill <path>` (repetible) y `--no-extensions`/`-e <path>` (repetible, `builtin:<name>`); los explícitos coexisten con los `--no-*`.
- `herdr agent start <name> --kind pi --pane <id> -- <AGENT_ARG>...` pasa args al agente.
- herdr arranca pi **sin flags** (cmdline = `pi`): su integración de estado (`~/.pi/agent/extensions/herdr-agent-state.ts`, instalada por herdr) carga por discovery.
- Con `--no-extensions` el child no carga esa integración, pero herdr **detecta idle por pantalla** (probe: settle idle OK) — el watcher NO se rompe; la extensión aporta exactitud (blocked preciso).
- Instalación real de pi: settings.json usa `packages[]` (`npm:<pkg>`, `git:<url>` variante, paths locales) — `extensions[]` (paths directos) suele estar vacía o ausente.

## Intención

Dos params en `herdr_dispatch` con semántica `true | false | [lista]` (default `false`), y un comando `/herdr` para fijar los defaults con wizard interactivo, autocompletado y persistencia.

## Objetivos

1. `skills?: boolean | string[]` — `false` → `--no-skills`; `true` → sin intervención; lista → `--no-skills` + `--skill <path>` por ítem.
2. `extensions?: boolean | string[]` — análogo con `--no-extensions` + `--extension <path>`.
3. Exención automática de la integración de estado de herdr cuando se restringen extensiones (determinismo del watcher).
4. Resolución de nombres en el PADRE, ANTES de crear topología (error temprano, cero side effects — hereda D7 de spec 001).
5. `/herdr` + `$PI_HOME/extensions-config/pi-herdr.json`: defaults configurables para los 6 params con default, con jerarquía **param de la tool > config persistida > builtin default**.

## No-objetivos

- Instalar o copiar skills/extensiones al child — solo flags.
- Filtrar skills de proyecto cuando `true`: `true` = comportamiento nativo pi íntegro.
- Config por-agente o per-cwd: v1 es global (una config por PI_HOME).

## Decisiones de Implementación

**D1 — Resolución de skills** (por ítem): empieza por `/` o `.` → path directo (debe existir; error si no). Si no → nombre: buscar `~/.pi/agent/skills/<name>/SKILL.md`, luego `~/.agents/skills/<name>/SKILL.md`, luego `<name>.md` en ambos (mismo orden). Sin match → error listando los dirs buscados. `~/.pi/agent/skills` gana empates.

**D2 — Resolución de extensiones** (por ítem): `/` o `.` → path directo. `builtin:<x>` → passthrough intacto (pi valida). Nombre → buscar en orden:
1. `~/.pi/agent/extensions/<name>` (directorio o fichero `.ts`/`.js`).
2. `extensions[]` de settings.json (paths directos) cuyo basename case.
3. `packages[]` de settings.json: `npm:<pkg>` → `~/.pi/agent/npm/node_modules/<pkg>`; `git:<url>` (formas `github.com/o/r`, `o/r`, `https://github.com/o/r`) → `~/.pi/agent/git/<host>/<o>/<r>`; path local → él mismo (relativo al dir de settings.json). El entry real sale de `package.json` → `pi.extensions[0]` resuelto a absoluto. Match por basename del paquete/repo.
Sin match → error sugiriendo `pi list`.

**D3 — Transporte y exención de estado**: los flags van por el passthrough de herdr (`agent start ... -- <piArgs>`); `agentStart` gana `piArgs: string[]`. Cuando se pasa `--no-extensions` (modo false o lista), se auto-añade `-e <path a herdr-agent-state.ts>` si existe en `~/.pi/agent/extensions/` (estados exactos para el watcher; ausente → se omite en silencio). La exención es interna: el usuario nunca la pide.

**D4 — kind ≠ pi**: si `skills`/`extensions` vienen con `kind` distinto de `pi` → error temprano (los flags son de la CLI de pi y romperían otros agentes).

**D5 — Defaults y registro**: ausencia de param = default efectivo (config o builtin). `true` = NO añadir flags de esa categoría. Lista vacía `[]` = `false`. `DispatchRecord` guarda los `piArgs` resultantes (visibilidad en `herdr_agents`).

**D6 — Comando `/herdr`** (patrón turnkit):
- `/herdr` → estado: defaults efectivos con origen (config/builtin) + ayuda.
- `/herdr config` → wizard interactivo (`ctx.ui.select` encadenados; headless sin UI → usage claro). Recorre los 6 keys.
- `/herdr config <key> <valor>` → set directo (`true`, `false`, lista entre comas/espacios, o ítems).
- `/herdr reset [key]` → limpia (todo o un key) volviendo a builtin.
- `getArgumentCompletions`: completa `<key>` (6 keys), `<valor>` (true/false) y, para skills/extensions, nombres resueltos en vivo de los dirs de D1/D2.

**D7 — Persistencia**: `$PI_HOME/extensions-config/pi-herdr.json`, shape `{ defaults?: { skills?, extensions?, topology?, kind?, keepOpen?, worktree? } }` con los mismos tipos que los params de la tool. Solo valores explícitamente configurados se guardan.

**D8 — Los 6 defaults configurables**: `skills`, `extensions`, `topology`, `kind`, `keepOpen`, `worktree`. El builtin default no cambia: `skills:false, extensions:false, topology:"tab", kind:"pi", keepOpen:false, worktree:false`.

## Queda a criterio del builder

- Módulo propio de resolución vs dentro de dispatch; orden exacto de flags; forma del error; wizard UX (orden de preguntas, etiquetas); cómo mostrar valores lista en `/herdr`; smoke de R5.

## Requisitos

- R1. Dispatch sin params y sin config → child arranca con `--no-skills --no-extensions -e <state.ts>` (si existe).
- R2. `skills: ["writing-specs", "/abs/SKILL.md"]` → solo esas skills (y `--no-extensions -e <state>`).
- R3. `extensions: ["pi-monitor", "builtin:lens"]` → resuelto por packages[] + passthrough, más la exención de estado.
- R4. Nombre irresoluble → error ANTES de crear tab (cero llamadas herdr de creación).
- R5. La coexistencia `--no-skills --skill` / `--no-extensions -e` funciona en pi real (smoke E2E documentado).
- R6. `/herdr config skills true` + dispatch sin params → child SIN `--no-skills` (herencia).
- R7. Param explícito gana a config: config `topology: "pane"` + param `topology: "tab"` → tab.
- R8. `skills: ["x"]` con `kind: "claude"` → error temprano.
- R9. `/herdr` muestra los 6 defaults efectivos con su origen.

## Criterios de aceptación (Given/When/Then)

- GIVEN sin config WHEN dispatch por defecto THEN passthrough = `--no-skills --no-extensions -e <state>` (o sin `-e` si no existe el fichero).
- GIVEN config `{skills: true}` WHEN dispatch sin params THEN passthrough SIN flags de skills.
- GIVEN config `{topology: "pane"}` WHEN param `topology: "tab"` THEN se crea tab.
- GIVEN `skills: ["a","b"]` con `b` inexistente THEN error y CERO llamadas herdr de creación.
- GIVEN `extensions: ["github:foo/bar"]` sin copia local THEN error sugiriendo `pi list`.
- GIVEN skills resueltas THEN `agent start` recibe `-- --no-skills --skill /abs/a --skill /abs/b`.

## Casos límite

- Ítem path inexistente → error temprano.
- Nombre en ambos dirs de skills → gana `~/.pi/agent/skills`.
- Fuente git: sin `package.json` → `pi.extensions` → error claro.
- `[]` = false. `true` + lista simultáneos imposible por schema (unión).
- `herdr-agent-state.ts` ausente → exención omitida en silencio.
- Config con valor inválido (p.ej. topology: "x") → ignorada con warning en `/herdr` (nunca rompe el dispatch).
- `/herdr config` en modo headless → usage claro, sin crash.

## Preguntas abiertas

Ninguna material.
