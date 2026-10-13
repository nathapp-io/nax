/** The bytes nax last wrote for each run-state file of one run's feature (#2497). Internal maps are the keeper's own state. */
import type { RunStatePath } from "./paths";

export interface KeptFile extends RunStatePath {
  readonly path: string;
  readonly content: string;
}

export class RunStateKeeper {
  private readonly kept = new Map<string, KeptFile>();
  private readonly inFlight = new Map<string, number>();

  constructor(
    readonly runId: string,
    readonly feature: string,
  ) {}

  owns(p: RunStatePath): boolean {
    return p.feature === this.feature;
  }

  record(path: string, p: RunStatePath, content: string): void {
    this.kept.set(path, { ...p, path, content });
  }

  get(path: string): KeptFile | undefined {
    return this.kept.get(path);
  }

  files(): readonly KeptFile[] {
    return [...this.kept.values()];
  }

  roots(): readonly string[] {
    return [...new Set(this.files().map((f) => f.root))];
  }

  begin(path: string): void {
    this.inFlight.set(path, (this.inFlight.get(path) ?? 0) + 1);
  }

  end(path: string): void {
    const n = (this.inFlight.get(path) ?? 1) - 1;
    if (n <= 0) this.inFlight.delete(path);
    else this.inFlight.set(path, n);
  }

  isInFlight(path: string): boolean {
    return this.inFlight.has(path);
  }
}
