import assert from "node:assert/strict";
import test from "node:test";
import { dockerClientEnvironment, safeEnvironment } from "../src/execution/safe-environment.js";

test("child environments exclude model credentials while preserving Docker connection settings", () => {
  const before = {
    openai: process.env.OPENAI_API_KEY,
    docker: process.env.DOCKER_HOST,
  };
  process.env.OPENAI_API_KEY = "must-not-propagate";
  process.env.DOCKER_HOST = "unix:///tmp/docker.sock";
  try {
    const local = safeEnvironment("/workspace");
    assert.equal(local.OPENAI_API_KEY, undefined);
    assert.equal(local.HOME, "/workspace");

    const docker = dockerClientEnvironment();
    assert.equal(docker.OPENAI_API_KEY, undefined);
    assert.equal(docker.DOCKER_HOST, "unix:///tmp/docker.sock");
  } finally {
    if (before.openai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = before.openai;
    if (before.docker === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = before.docker;
  }
});
