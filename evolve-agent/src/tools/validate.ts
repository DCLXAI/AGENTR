import { EvolveError } from "../core/errors.js";

export function assertObject(value: unknown, label = "arguments"): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new EvolveError("TOOL_ARGS_INVALID", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function stringArg(
  args: Record<string, unknown>,
  key: string,
  options: { required?: boolean; min?: number; max?: number; fallback?: string } = {},
): string | undefined {
  const value = args[key] ?? options.fallback;
  if (value === undefined && !options.required) return undefined;
  if (typeof value !== "string") throw new EvolveError("TOOL_ARGS_INVALID", `${key} must be a string`);
  const min = options.min ?? 0;
  const max = options.max ?? 1_000_000;
  if (value.length < min || value.length > max) {
    throw new EvolveError("TOOL_ARGS_INVALID", `${key} length must be between ${min} and ${max}`);
  }
  return value;
}

export function numberArg(
  args: Record<string, unknown>,
  key: string,
  options: { required?: boolean; min?: number; max?: number; integer?: boolean; fallback?: number } = {},
): number | undefined {
  const value = args[key] ?? options.fallback;
  if (value === undefined && !options.required) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new EvolveError("TOOL_ARGS_INVALID", `${key} must be a finite number`);
  }
  if (options.integer && !Number.isInteger(value)) throw new EvolveError("TOOL_ARGS_INVALID", `${key} must be an integer`);
  if (options.min !== undefined && value < options.min) throw new EvolveError("TOOL_ARGS_INVALID", `${key} must be >= ${options.min}`);
  if (options.max !== undefined && value > options.max) throw new EvolveError("TOOL_ARGS_INVALID", `${key} must be <= ${options.max}`);
  return value;
}

export function booleanArg(
  args: Record<string, unknown>,
  key: string,
  options: { required?: boolean; fallback?: boolean } = {},
): boolean | undefined {
  const value = args[key] ?? options.fallback;
  if (value === undefined && !options.required) return undefined;
  if (typeof value !== "boolean") throw new EvolveError("TOOL_ARGS_INVALID", `${key} must be a boolean`);
  return value;
}

export function stringArrayArg(
  args: Record<string, unknown>,
  key: string,
  options: { required?: boolean; maxItems?: number; maxItemLength?: number; fallback?: string[] } = {},
): string[] | undefined {
  const value = args[key] ?? options.fallback;
  if (value === undefined && !options.required) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new EvolveError("TOOL_ARGS_INVALID", `${key} must be an array of strings`);
  }
  if (value.length > (options.maxItems ?? 128)) throw new EvolveError("TOOL_ARGS_INVALID", `${key} has too many items`);
  const maxLength = options.maxItemLength ?? 10_000;
  if (value.some((item) => item.length > maxLength)) throw new EvolveError("TOOL_ARGS_INVALID", `${key} contains an oversized item`);
  return [...value];
}

export function rejectUnknownKeys(args: Record<string, unknown>, allowed: string[]): void {
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new EvolveError("TOOL_ARGS_INVALID", `Unknown arguments: ${unknown.join(", ")}`);
}
