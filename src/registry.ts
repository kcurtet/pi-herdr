/**
 * Registro de despachos de la sesión. En T9 gana persistencia (appendEntry)
 * y reconstrucción; la forma del record ya es la final.
 */
export interface DispatchRecord {
	agent: string;
	taskId: string;
	topology: "tab" | "pane" | "workspace";
	/** tab_id / pane_id / workspace_id según topology: el target de close. */
	targetId: string;
	paneId: string;
	cwd: string;
	worktree?: { dir: string; branch: string };
	keepOpen: boolean;
	createdAt: number;
	status: "live" | "closed";
}

export class Registry {
	private readonly map = new Map<string, DispatchRecord>();

	add(rec: DispatchRecord): void {
		this.map.set(rec.agent, rec);
	}

	get(agent: string): DispatchRecord | undefined {
		return this.map.get(agent);
	}

	list(): DispatchRecord[] {
		return [...this.map.values()];
	}

	markClosed(agent: string): void {
		const rec = this.map.get(agent);
		if (rec) rec.status = "closed";
	}
}
