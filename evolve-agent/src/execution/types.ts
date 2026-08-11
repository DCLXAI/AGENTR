export type ExecutorKind = "docker" | "local";
export type WorkspaceAccess = "read-only" | "read-write";

export interface ResourceLimits {
  memoryMb: number;
  cpus: number;
  pids: number;
  tmpfsMb: number;
}

export interface ExecutionRequest {
  runId: string;
  command: string;
  args: string[];
  workspace: string;
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  workspaceAccess: WorkspaceAccess;
  network: string;
  secretNames: string[];
  limits: ResourceLimits;
  image?: string;
}

export interface ExecutionResult {
  executor: ExecutorKind;
  success: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  truncated: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  image?: string;
  network: string;
  workspaceAccess: WorkspaceAccess;
  secretNames: string[];
  receipt: {
    runId: string;
    sandboxId: string;
    commandHash: string;
    policyHash: string;
  };
  isolation: {
    boundary: string;
    readOnlyRoot: boolean;
    capabilitiesDropped: boolean;
    noNewPrivileges: boolean;
    resourceLimits: boolean;
    networkPolicy: string;
    secretDelivery: string;
  };
}

export interface ExecutorProbe {
  kind: ExecutorKind;
  available: boolean;
  ready: boolean;
  summary: string;
  warnings: string[];
  details: Record<string, string | number | boolean | null>;
}

export interface Executor {
  readonly kind: ExecutorKind;
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
  probe(): Promise<ExecutorProbe>;
}
