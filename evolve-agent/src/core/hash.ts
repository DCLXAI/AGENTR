import { createHash } from "node:crypto";
import { stableStringify } from "./stable-json.js";

export function sha256Bytes(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Json(value: unknown): string {
  return sha256Bytes(stableStringify(value));
}
