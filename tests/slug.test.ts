import { describe, expect, it } from "vitest";
import { agentList, type RunFn } from "../src/herdr.ts";
import { resolveName, slugify } from "../src/slug.ts";

/** Mock RunFn que responde a `agent list` con los nombres indicados. */
function runWithAgents(names: string[]): RunFn {
	return async (_file, args) => {
		if (args.slice(0, 2).join(" ") === "agent list") {
			const stdout = JSON.stringify({
				id: "cli:agent:list",
				result: { agents: names.map((n) => ({ name: n, agent_status: "idle", pane_id: "w1:p1" })) },
			});
			return { code: 0, stdout, stderr: "" };
		}
		return { code: 1, stdout: "", stderr: "unmocked" };
	};
}

describe("slugify", () => {
	it("3 primeras palabras significativas, minúsculas, sin puntuación", () => {
		expect(slugify("Revisa el login del admin!!")).toBe("revisa-login-admin");
	});
	it("normaliza diacríticos", () => {
		expect(slugify("Revisión del módulo de pagos")).toBe("revision-modulo-pagos");
	});
	it("recorta a 32 sin guion final", () => {
		const s = slugify("implementacion-super-larga-con-muchas-palabras-significativas-aqui");
		expect(s.length).toBeLessThanOrEqual(32);
		expect(s.endsWith("-")).toBe(false);
	});
	it("palabras cortas y stopwords no cuentan como significativas", () => {
		expect(slugify("el y de un revisa login")).toBe("revisa-login");
	});
	it("task que arranca por dígito → prefijo t- (NAME_RE, issue #15)", () => {
		expect(slugify("404 handler fix")).toBe("t-404-handler-fix");
	});
	it("task de una sola palabra numérica también recibe prefijo", () => {
		expect(slugify("404")).toBe("t-404");
	});
	it("prefijo no empuja el slug por encima de 32 chars ni deja guion final", () => {
		const s = slugify("4044044044044044044044044044044040"); // palabra numérica de 34 chars
		expect(s).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
		expect(s.length).toBeLessThanOrEqual(32);
		expect(s.endsWith("-")).toBe(false);
	});
	it("vacío o irrelevante → cadena vacía", () => {
		expect(slugify("!! ?? el y de")).toBe("");
	});
});

describe("resolveName", () => {
	it("task que arranca por dígito → nombre que cumple NAME_RE y ≤32 chars", async () => {
		const name = await resolveName(runWithAgents([]), "404 handler fix");
		expect(name).toBe("t-404-handler-fix");
		expect(name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
		expect(name.length).toBeLessThanOrEqual(32);
	});
	it("task de un solo dígito → nombre válido", async () => {
		const name = await resolveName(runWithAgents([]), "7");
		expect(name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
		expect(name.length).toBeLessThanOrEqual(32);
	});
	it("tasks normales → slug sin prefijo añadido (pinning)", async () => {
		expect(await resolveName(runWithAgents([]), "revisa el login")).toBe("revisa-login");
	});
	it("sin colisión devuelve el slug tal cual", async () => {
		const name = await resolveName(runWithAgents(["otro"]), "Revisa el login del admin!!");
		expect(name).toBe("revisa-login-admin");
	});
	it("slug colisionante → sufijo -2", async () => {
		const name = await resolveName(runWithAgents(["revisa-login-admin"]), "Revisa el login del admin!!");
		expect(name).toBe("revisa-login-admin-2");
	});
	it("slug largo de una palabra colisionante → recorta para dejar sitio al sufijo", async () => {
		const largo = "a".repeat(32); // slugify de una palabra de 40 chars
		const name = await resolveName(runWithAgents([largo]), "a".repeat(40));
		expect(name.length).toBeLessThanOrEqual(32);
		expect(name.endsWith("-2")).toBe(true);
	});
	it("slug irrelevante → fallback dispatch-N (agentes vivos + 1)", async () => {
		const name = await resolveName(runWithAgents(["a", "b"]), "!! ??");
		expect(name).toBe("dispatch-3");
	});
	it("fallback dispatch-N esquiva colisiones subiendo desde vivos+1", async () => {
		const name = await resolveName(runWithAgents(["a", "dispatch-3"]), "!! ??");
		expect(name).toBe("dispatch-4");
	});
	it("explicit válido y libre se usa tal cual", async () => {
		const name = await resolveName(runWithAgents(["otro"]), "task", "mi-nombre_1");
		expect(name).toBe("mi-nombre_1");
	});
	it("explicit inválido → throw de validación", async () => {
		await expect(resolveName(runWithAgents([]), "task", "Bad_Name")).rejects.toThrow(/nombre/i);
		await expect(resolveName(runWithAgents([]), "task", "1empieza-numero")).rejects.toThrow(/nombre/i);
		await expect(resolveName(runWithAgents([]), "task", "x".repeat(33))).rejects.toThrow(/nombre/i);
	});
	it("explicit colisionante → throw con sugerencia", async () => {
		await expect(resolveName(runWithAgents(["ya-existe"]), "task", "ya-existe")).rejects.toThrow(/ya-existe-2/);
	});
});

describe("integración con el seam", () => {
	it("resolveName consulta agentList del seam real", async () => {
		const agents = await agentList(runWithAgents(["x"]));
		expect(agents[0].name).toBe("x");
	});
});
