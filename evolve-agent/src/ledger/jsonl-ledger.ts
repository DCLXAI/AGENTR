import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { ensureDir } from "../core/fs.js";
import { sha256Json } from "../core/hash.js";
import type { JsonValue, LedgerEvent, LedgerVerification } from "../core/types.js";

interface LedgerUnsignedEvent {
  version: 1;
  index: number;
  timestamp: string;
  episodeId: string;
  type: string;
  payload: JsonValue;
  prevHash: string | null;
}

export class JsonlLedger {
  private appendQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly filePath: string) {}

  public async append(episodeId: string, type: string, payload: JsonValue): Promise<LedgerEvent> {
    let result: LedgerEvent | undefined;
    this.appendQueue = this.appendQueue.then(async () => {
      await ensureDir(path.dirname(this.filePath));
      const events = await this.readAll();
      const previous = events.at(-1);
      const unsigned: LedgerUnsignedEvent = {
        version: 1,
        index: events.length,
        timestamp: new Date().toISOString(),
        episodeId,
        type,
        payload,
        prevHash: previous?.hash ?? null,
      };
      result = { ...unsigned, hash: sha256Json(unsigned) };
      await appendFile(this.filePath, `${JSON.stringify(result)}\n`, "utf8");
    });
    await this.appendQueue;
    if (!result) throw new Error("Ledger append did not produce an event");
    return result;
  }

  public async readAll(): Promise<LedgerEvent[]> {
    try {
      const text = await readFile(this.filePath, "utf8");
      return text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as LedgerEvent);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  public async forEpisode(episodeId: string): Promise<LedgerEvent[]> {
    return (await this.readAll()).filter((event) => event.episodeId === episodeId);
  }

  public async verify(): Promise<LedgerVerification> {
    let events: LedgerEvent[];
    try {
      events = await this.readAll();
    } catch (error: unknown) {
      return { valid: false, events: 0, error: error instanceof Error ? error.message : String(error) };
    }

    let previousHash: string | null = null;
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (!event) return { valid: false, events: index, error: `Missing event at index ${index}` };
      if (event.index !== index) return { valid: false, events: index, error: `Index mismatch at ${index}` };
      if (event.prevHash !== previousHash) return { valid: false, events: index, error: `Chain mismatch at ${index}` };
      const { hash, ...unsigned } = event;
      if (sha256Json(unsigned) !== hash) return { valid: false, events: index, error: `Hash mismatch at ${index}` };
      previousHash = event.hash;
    }
    return { valid: true, events: events.length };
  }
}
