import type { AnyTool } from "./types";

export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();

  register(...defs: AnyTool[]): this {
    for (const d of defs) {
      if (this.tools.has(d.name)) throw new Error(`Duplicate tool name: ${d.name}`);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(d.name)) throw new Error(`Tool name must be a valid JS identifier: ${d.name}`);
      this.tools.set(d.name, d);
    }
    return this;
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name);
  }

  list(filter?: (t: AnyTool) => boolean): AnyTool[] {
    const all = [...this.tools.values()];
    return filter ? all.filter(filter) : all;
  }

  get size(): number {
    return this.tools.size;
  }
}
