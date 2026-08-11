import { EvolveError } from "../core/errors.js";
import type { Executor, ExecutorKind, ExecutorProbe, ExecutionRequest, ExecutionResult } from "./types.js";

export class ExecutorRegistry {
  private readonly executors = new Map<ExecutorKind, Executor>();

  public constructor(private readonly defaultKind: ExecutorKind, executors: Executor[]) {
    for (const executor of executors) {
      if (this.executors.has(executor.kind)) throw new Error(`Duplicate executor kind: ${executor.kind}`);
      this.executors.set(executor.kind, executor);
    }
    if (!this.executors.has(defaultKind)) throw new Error(`Default executor ${defaultKind} is not registered`);
  }

  public getDefaultKind(): ExecutorKind {
    return this.defaultKind;
  }

  public list(): ExecutorKind[] {
    return [...this.executors.keys()].sort();
  }

  public get(requested: string): Executor {
    const kind = requested === "default" ? this.defaultKind : requested;
    if (kind !== "docker" && kind !== "local") throw new EvolveError("EXECUTOR_UNKNOWN", `Unknown executor: ${requested}`);
    const executor = this.executors.get(kind);
    if (!executor) throw new EvolveError("EXECUTOR_DISABLED", `${kind} executor is not enabled`);
    return executor;
  }

  public async execute(requested: string, request: ExecutionRequest): Promise<ExecutionResult> {
    return this.get(requested).execute(request);
  }

  public async probeAll(): Promise<ExecutorProbe[]> {
    const probes: ExecutorProbe[] = [];
    for (const executor of [...this.executors.values()].sort((left, right) => left.kind.localeCompare(right.kind))) {
      try {
        probes.push(await executor.probe());
      } catch (error: unknown) {
        probes.push({
          kind: executor.kind,
          available: false,
          ready: false,
          summary: error instanceof Error ? error.message : String(error),
          warnings: [],
          details: {},
        });
      }
    }
    return probes;
  }
}
