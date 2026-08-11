import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JsonlLedger } from "../src/ledger/jsonl-ledger.js";

test("ledger detects post-hoc event mutation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "evolve-ledger-"));
  const ledgerPath = path.join(root, "episodes.jsonl");
  try {
    const ledger = new JsonlLedger(ledgerPath);
    await ledger.append("ep_aaaaaaaaaaaaaaaaaaaaaaaa", "episode.started", { value: 1 });
    await ledger.append("ep_aaaaaaaaaaaaaaaaaaaaaaaa", "episode.committed", { value: 2 });
    assert.deepEqual(await ledger.verify(), { valid: true, events: 2 });

    const lines = (await readFile(ledgerPath, "utf8")).trim().split("\n");
    const second = JSON.parse(lines[1] as string) as { payload: { value: number } };
    second.payload.value = 999;
    lines[1] = JSON.stringify(second);
    await writeFile(ledgerPath, `${lines.join("\n")}\n`, "utf8");
    const result = await ledger.verify();
    assert.equal(result.valid, false);
    assert.match(result.error ?? "", /hash mismatch/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
