import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryStore } from "../src/memory/memory-store.js";

test("high-confidence memory is rejected without valid evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "evolve-memory-"));
  try {
    const store = new MemoryStore(root);
    await assert.rejects(
      store.add({
        text: "Use compare-and-swap when replacing a file.",
        tags: ["files"],
        confidence: 0.9,
        sourceEpisodeId: "ep_aaaaaaaaaaaaaaaaaaaaaaaa",
        evidenceIds: [],
        validEvidenceIds: new Set(),
      }),
      /requires current-episode evidence/i,
    );
    const evidence = "ev_aaaaaaaaaaaaaaaaaaaaaaaa";
    const record = await store.add({
      text: "Use compare-and-swap when replacing a file.",
      tags: ["files", "safety"],
      confidence: 0.9,
      sourceEpisodeId: "ep_aaaaaaaaaaaaaaaaaaaaaaaa",
      evidenceIds: [evidence],
      validEvidenceIds: new Set([evidence]),
    });
    assert.equal(record.evidenceIds[0], evidence);
    const matches = await store.search("safe file replace compare swap");
    assert.equal(matches[0]?.id, record.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
