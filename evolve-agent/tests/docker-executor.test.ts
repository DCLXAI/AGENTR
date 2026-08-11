import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DockerExecutor, buildDockerRunArgs } from "../src/execution/docker-executor.js";
import { ImagePolicy } from "../src/execution/image-policy.js";
import { DockerNetworkPolicy } from "../src/execution/network-policy.js";
import type { ProcessRunner, ProcessRunRequest, ProcessRunResult } from "../src/execution/process-runner.js";
import type { ExecutionRequest, ResourceLimits } from "../src/execution/types.js";
import { FileSecretBroker } from "../src/secrets/secret-broker.js";

const IMAGE = `node:22-bookworm-slim@sha256:${"a".repeat(64)}`;
const LIMITS: ResourceLimits = { memoryMb: 512, cpus: 1, pids: 128, tmpfsMb: 64 };

class RecordingRunner implements ProcessRunner {
  public readonly calls: ProcessRunRequest[] = [];

  public async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    this.calls.push(request);
    if (request.args[0] === "run") {
      return {
        code: 0,
        signal: null,
        timedOut: false,
        truncated: false,
        stdout: "token=super-secret-token\n",
        stderr: "",
        durationMs: 12,
      };
    }
    return {
      code: 0,
      signal: null,
      timedOut: false,
      truncated: false,
      stdout: "",
      stderr: "",
      durationMs: 2,
    };
  }
}

function request(workspace: string): ExecutionRequest {
  return {
    runId: "ep_aaaaaaaaaaaaaaaaaaaaaaaa-run-1",
    command: "node",
    args: ["--version"],
    workspace,
    cwd: workspace,
    timeoutMs: 5_000,
    maxOutputBytes: 32_000,
    workspaceAccess: "read-only",
    network: "none",
    secretNames: ["TEST_TOKEN"],
    limits: LIMITS,
    image: IMAGE,
  };
}

test("Docker image and network policy fail closed", () => {
  assert.throws(() => new ImagePolicy(["node:22"]), /sha256-pinned/);
  assert.throws(() => new DockerNetworkPolicy(["host"]), /Unsafe network/);

  const images = new ImagePolicy([IMAGE], IMAGE);
  assert.equal(images.resolve(), IMAGE);
  assert.throws(() => images.resolve(`node:20@sha256:${"b".repeat(64)}`), /not in EVOLVE_DOCKER_ALLOWED_IMAGES/);

  const networks = new DockerNetworkPolicy(["evolve-egress"]);
  assert.deepEqual(networks.resolve("none"), { name: "none", enforcement: "deny-all" });
  assert.deepEqual(networks.resolve("evolve-egress"), {
    name: "evolve-egress",
    enforcement: "operator-managed:evolve-egress",
  });
  assert.throws(() => networks.resolve("bridge"), /bypasses the hardened network boundary/);
});

test("Docker run arguments encode the hardened sandbox contract", () => {
  const workspace = path.join(os.tmpdir(), "evolve-workspace");
  const args = buildDockerRunArgs({
    request: request(workspace),
    image: IMAGE,
    network: "none",
    networkEnforcement: "deny-all",
    user: "65532:65532",
    containerName: "evolve-test",
    secretMounts: [
      { name: "TEST_TOKEN", hostPath: "/tmp/secret-token", containerPath: "/run/secrets/TEST_TOKEN" },
    ],
    maximums: { memoryMb: 2_048, cpus: 2, pids: 256, tmpfsMb: 256 },
  });
  const rendered = JSON.stringify(args);
  for (const required of [
    "--pull",
    "never",
    "--read-only",
    "--cap-drop",
    "ALL",
    "no-new-privileges:true",
    "--network",
    "none",
    "--memory",
    "512m",
    "--pids-limit",
    "128",
    "--ipc",
    "none",
    "TEST_TOKEN_FILE=/run/secrets/TEST_TOKEN",
  ]) {
    assert.ok(args.includes(required), `missing Docker hardening argument: ${required}`);
  }
  assert.ok(rendered.includes("readonly"));
  assert.ok(!rendered.includes("super-secret-token"));
  assert.equal(args.at(-2), "node");
  assert.equal(args.at(-1), "--version");
});

test("Docker executor redacts injected secrets and emits a policy receipt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "evolve-docker-test-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const runner = new RecordingRunner();
  const broker = new FileSecretBroker(path.join(root, "secrets"), ["TEST_TOKEN"], 60_000, (name) =>
    name === "TEST_TOKEN" ? "super-secret-token" : undefined,
  );
  const executor = new DockerExecutor(runner, broker, {
    binary: "docker",
    user: "65532:65532",
    imagePolicy: new ImagePolicy([IMAGE], IMAGE),
    networkPolicy: new DockerNetworkPolicy([]),
    maximums: { memoryMb: 2_048, cpus: 2, pids: 256, tmpfsMb: 256 },
    requireRootless: false,
  });

  try {
    const result = await executor.execute(request(workspace));
    assert.equal(result.success, true);
    assert.equal(result.stdout, "token=[REDACTED_SECRET:TEST_TOKEN]\n");
    assert.equal(result.isolation.boundary, "docker-container");
    assert.equal(result.isolation.networkPolicy, "deny-all");
    assert.equal(result.receipt.commandHash.length, 64);
    assert.equal(result.receipt.policyHash.length, 64);
    assert.equal(runner.calls.length, 2, "docker run plus best-effort cleanup");

    const dockerRun = runner.calls[0];
    assert.ok(dockerRun);
    const serialized = JSON.stringify({ args: dockerRun.args, env: dockerRun.env });
    assert.ok(!serialized.includes("super-secret-token"), "secret values must never enter Docker CLI args or env");
    assert.ok(serialized.includes("TEST_TOKEN_FILE=/run/secrets/TEST_TOKEN"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("Docker readiness requires seccomp, cgroups, and the pinned local image", async () => {
  class ProbeRunner implements ProcessRunner {
    public constructor(private readonly securityOptions: string[]) {}
    public async run(input: ProcessRunRequest): Promise<ProcessRunResult> {
      const joined = input.args.join(" ");
      let stdout = "";
      if (joined.startsWith("version ")) stdout = "29.0.1\n";
      else if (joined.includes("SecurityOptions")) stdout = `${JSON.stringify(this.securityOptions)}\n`;
      else if (joined.includes("CgroupVersion")) stdout = "2\n";
      else if (joined.startsWith("image inspect")) stdout = `sha256:${"d".repeat(64)}\n`;
      return {
        code: 0,
        signal: null,
        timedOut: false,
        truncated: false,
        stdout,
        stderr: "",
        durationMs: 1,
      };
    }
  }

  const root = await mkdtemp(path.join(os.tmpdir(), "evolve-probe-test-"));
  try {
    const broker = new FileSecretBroker(path.join(root, "secrets"), [], 60_000);
    const options = {
      binary: "docker",
      user: "65532:65532",
      imagePolicy: new ImagePolicy([IMAGE], IMAGE),
      networkPolicy: new DockerNetworkPolicy([]),
      maximums: { memoryMb: 2_048, cpus: 2, pids: 256, tmpfsMb: 256 },
      requireRootless: true,
    };
    const ready = await new DockerExecutor(
      new ProbeRunner(["name=seccomp,profile=builtin", "name=rootless"]),
      broker,
      options,
    ).probe();
    assert.equal(ready.ready, true);
    assert.equal(ready.details.seccomp, true);
    assert.equal(ready.details.resource_limits_ready, true);

    const missingSeccomp = await new DockerExecutor(new ProbeRunner(["name=rootless"]), broker, options).probe();
    assert.equal(missingSeccomp.ready, false);
    assert.ok(missingSeccomp.warnings.some((warning) => warning.includes("seccomp")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
