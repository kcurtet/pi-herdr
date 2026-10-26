# Spec 002 — Skills y extensiones del agente despachado

## Contexto

pi-herdr v0.1 despacha agentes pi que heredan TODO el descubrimiento nativo: skills de `~/.pi/agent/skills`, `~/.agents/skills` y del proyecto, y extensiones de settings/`~/.pi/agent/extensions`. El humano quiere agentes despachados **limpios por defecto**, con herencia total o listado explícito como opt-in.

La CLI de pi ya soporta el control nativo: `--no-skills`/`--skill <path>` y `--no-extensions`/`--extension, -e <path>` (repetibles; los explícitos siguen funcionando junto a los `--no-*`; `-e` soporta `builtin:<name>`). `herdr agent start` acepta passthrough: `... -- <AGENT_ARG>...`.

## Intención

Dos params nuevos en `herdr_dispatch` con semántica idéntica: `true | false | [lista]`, **default `false`** para ambos.

## Objetivos

1. `skills?: boolean | string[]` — `false` → child con `--no-skills`; `true` → sin intervención (herencia nativa completa); lista → `--no-skills` + `--skill <path>` por ítem.
2. `extensions?: boolean | string[]` — análogo con `--no-extensions` + `--extension <path>`.
3. Resolución de nombres en el agente PADRE, ANTES de crear topología (error temprano, cero side effects — hereda D7 de spec 001).

## No-objetivos

- Instalar o copiar skills/extensiones al child — solo flags.
- Filtrar skills de proyecto cuando `true`: `true` significa comportamiento nativo pi íntegro.
- Configuración persistente por-agente o per-cwd: v1 es per-dispatch.

## Decisiones de Implementación

**D1 — Resolución de skills** (por ítem): empieza por `/` o `.` → path directo (debe existir; error si no). Si no → nombre: buscar `~/.pi/agent/skills/<name>/SKILL.md`, luego `~/.agents/skills/<name>/SKILL.md`, luego `<name>.md` en ambos (mismo orden). Sin match → error listando los dirs buscados. `~/.pi/agent/skills` gana empates.

**D2 — Resolución de extensiones** (por ítem): `/` o `.` → path directo. `builtin:<x>` → passthrough intacto (pi valida). Nombre → `~/.pi/agent/extensions/<name>` (directorio o fichero `.ts`/`.js`); si no, buscar en `extensions[]` de `~/.pi/agent/settings.json`: entrada igual al nombre o fuente `github:<owner>/<repo>` (o `<owner>/<repo>`) cuyo directorio de copia `~/.pi/agent/git/<host>/<owner>/<repo>` exista → entry = `package.json` → `pi.extensions[0]` resuelto a absoluto. Sin match → error sugiriendo `pi list`.

**D3 — Transporte**: los flags van por el passthrough de herdr: `agent start <name> --kind pi --pane <id> -- --no-skills --skill <p1> --skill <p2> --no-extensions -e <e1>`. `agentStart` gana un param `piArgs: string[]` (args tras `--`). Schema de la tool: unión Boolean | Array(String) para ambos params, con description que documenta la semántica true/false/lista.

**D4 — Registro**: `DispatchRecord` guarda los `piArgs` resultantes (visibilidad en `herdr_agents` y debugging post-hoc).

**D5 — Defaults**: ausencia de param = `false` (agente limpio: `--no-skills --no-extensions`). `true` = NO añadir ningún flag de esa categoría. Lista vacía `[]` = `false`.

## Queda a criterio del builder

- Estructura interna (módulo de resolución propio vs dentro de dispatch), orden de flags exacto, forma del error de resolución, cómo probar la coexistencia `--no-skills --skill` (smoke con pi real).

## Requisitos

- R1. Dispatch sin params nuevos → child arranca con `--no-skills --no-extensions`.
- R2. `skills: ["writing-specs", "/abs/adhoc/SKILL.md"]` → solo esas dos skills.
- R3. `extensions: ["builtin:lens", "pi-monitor"]` → passthrough + resuelto desde extensions/.
- R4. Nombre irresoluble → error ANTES de crear tab (cero llamadas de topología).
- R5. La coexistencia `--no-skills --skill <p>` funciona en pi real (smoke E2E documentado).

## Criterios de aceptación (Given/When/Then)

- GIVEN dispatch por defecto WHEN arranca el agente THEN el passthrough contiene exactamente `--no-skills --no-extensions`.
- GIVEN `skills: true, extensions: false` THEN passthrough = `--no-extensions` (sin flags de skills).
- GIVEN `skills: ["a", "b"]` con `a` resuelto en `~/.pi/agent/skills` y `b` inexistente THEN error y CERO llamadas herdr de creación.
- GIVEN `extensions: ["github:foo/bar"]` sin copia local THEN error sugiriendo `pi list`.
- GIVEN skills resueltas THEN `agent start` recibe `-- --no-skills --skill /abs/a --skill /abs/b`.

## Casos límite

- Ítem que es path inexistente → error temprano.
- Nombre presente en ambos dirs de skills → gana `~/.pi/agent/skills`.
- Fuente `github:` con repo sin `package.json` → `pi.extensions` → error claro.
- `[]` → tratado como `false`.
- Fichero suelto `<name>.md` como skill → soportado (pi lo admite).

## Preguntas abiertas

Ninguna material.
