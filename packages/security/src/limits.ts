import { GatewayError } from "./errors";

const encoder = new TextEncoder();

export function byteLength(s: string): number {
  return encoder.encode(s).length;
}

export function jsonByteLength(value: unknown): number {
  try {
    return byteLength(JSON.stringify(value) ?? "null");
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

export interface CapOutcome {
  value: unknown;
  bytes: number;
  truncated: boolean;
}

/**
 * Enforce a maximum serialized size. Arrays are shrunk (keeping a head) so callers get a
 * still-useful, still-valid JSON value; anything else becomes a marker object.
 */
export function capResult(value: unknown, maxBytes: number): CapOutcome {
  const bytes = jsonByteLength(value);
  if (bytes <= maxBytes) return { value, bytes, truncated: false };
  if (Array.isArray(value)) {
    let lo = 0;
    let hi = value.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (jsonByteLength(value.slice(0, mid)) <= maxBytes - 200) lo = mid;
      else hi = mid - 1;
    }
    const kept = value.slice(0, lo);
    return {
      value: { _truncated: true, originalCount: value.length, keptCount: lo, items: kept },
      bytes: jsonByteLength(kept),
      truncated: true,
    };
  }
  if (value && typeof value === "object") {
    // Shrink the largest top-level arrays progressively.
    const obj = { ...(value as Record<string, unknown>) };
    for (let i = 0; i < 40 && jsonByteLength(obj) > maxBytes; i++) {
      const entries = Object.entries(obj).sort((a, b) => jsonByteLength(b[1]) - jsonByteLength(a[1]));
      const first = entries[0];
      if (!first) break;
      const [k, v] = first;
      if (Array.isArray(v) && v.length > 1) obj[k] = v.slice(0, Math.floor(v.length / 2));
      else if (typeof v === "string" && v.length > 64) obj[k] = v.slice(0, Math.floor(v.length / 2)) + "…[truncated]";
      else {
        delete obj[k];
        obj._truncatedKeys = [...((obj._truncatedKeys as string[]) ?? []), k];
      }
    }
    if (jsonByteLength(obj) <= maxBytes) return { value: { ...obj, _truncated: true }, bytes: jsonByteLength(obj), truncated: true };
  }
  throw new GatewayError("result_too_large", `Result exceeds the ${maxBytes} byte limit and cannot be truncated safely. Aggregate or project fields inside your code.`);
}
