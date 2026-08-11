import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { stableStringify } from "../core/stable-json.js";

export interface ApprovalRequest {
  episodeId: string;
  toolName: string;
  risk: "write" | "execute" | "external";
  args: Record<string, unknown>;
  reason: string;
}

export interface Approver {
  approve(request: ApprovalRequest): Promise<boolean>;
}

export class InteractiveApprover implements Approver {
  public constructor(private readonly nonInteractive: boolean) {}

  public async approve(request: ApprovalRequest): Promise<boolean> {
    if (this.nonInteractive || !stdin.isTTY || !stdout.isTTY) return false;
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      stdout.write(`\nApproval required [${request.risk}] ${request.toolName}\n`);
      stdout.write(`${request.reason}\n${stableStringify(request.args)}\n`);
      const answer = (await rl.question("Execute this exact action? [y/N] ")).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    } finally {
      rl.close();
    }
  }
}

export class StaticApprover implements Approver {
  public constructor(private readonly decision: boolean) {}
  public async approve(): Promise<boolean> {
    return this.decision;
  }
}
