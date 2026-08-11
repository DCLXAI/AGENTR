import { EvolveError } from "../core/errors.js";
import type { TaskSpec } from "../core/types.js";
import type { ToolDefinition, ToolRisk } from "../tools/types.js";

export interface PolicyDecision {
  allowed: boolean;
  approvalRequired: boolean;
  reason: string;
}

export class RiskEngine {
  public evaluate(task: TaskSpec, tool: ToolDefinition, args: Record<string, unknown>): PolicyDecision {
    if (!task.requestedTools.includes(tool.name)) {
      return {
        allowed: false,
        approvalRequired: false,
        reason: `Tool ${tool.name} is outside the task's requested tool boundary`,
      };
    }

    if (Object.keys(args).length > 64) {
      return { allowed: false, approvalRequired: false, reason: "Tool argument object is unexpectedly large" };
    }

    const approvalRequired = tool.risk !== "read";
    return {
      allowed: true,
      approvalRequired,
      reason: approvalRequired
        ? `${tool.name} is classified as ${tool.risk} and requires explicit approval`
        : `${tool.name} is a workspace-confined read operation`,
    };
  }

  public assertAllowed(decision: PolicyDecision): void {
    if (!decision.allowed) throw new EvolveError("POLICY_DENIED", decision.reason);
  }
}

export function protectedRisk(risk: ToolRisk): risk is Exclude<ToolRisk, "read"> {
  return risk !== "read";
}
