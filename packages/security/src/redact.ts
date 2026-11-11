/**
 * Sensitive-data filtering. Applied by the host to every tool result BEFORE it
 * crosses back into the sandbox, and again on the final execution result.
 */

const SENSITIVE_KEY =
  /(^|_|\b)(password|passwd|secret|token|access_?token|refresh_?token|client_?secret|api_?key|authorization|ssn|social_?security|tax_?id|credit_?card|card_?number|cvv|iban|bank_?account|private_?key|session_?id)(_|\b|$|__c$)/i;

const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
// US EIN / tax id (NN-NNNNNNN)
const EIN_RE = /(?<![\d-])\d{2}-\d{7}(?![\d-])/g;
const CARD_RE = /\b\d(?:[ -]?\d){12,18}\b/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi;
// Salesforce session ids look like 00D...!AQ...
const SFDC_SESSION_RE = /\b00[A-Za-z0-9]{13,16}![A-Za-z0-9._]{20,}/g;

export const REDACTED = "[REDACTED]";

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function redactString(input: string): { value: string; count: number } {
  let count = 0;
  let out = input.replace(SSN_RE, () => (count++, REDACTED));
  out = out.replace(EIN_RE, () => (count++, REDACTED));
  out = out.replace(BEARER_RE, () => (count++, REDACTED));
  out = out.replace(SFDC_SESSION_RE, () => (count++, REDACTED));
  out = out.replace(CARD_RE, (m) => {
    const digits = m.replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) {
      count++;
      return REDACTED;
    }
    return m;
  });
  return { value: out, count };
}

export interface RedactOptions {
  /** Extra exact field names (case-insensitive) to always redact. */
  extraSensitiveFields?: string[];
  maxDepth?: number;
}

export interface RedactResult<T> {
  value: T;
  redactions: number;
}

export function redactValue<T>(input: T, options: RedactOptions = {}): RedactResult<T> {
  const extra = new Set((options.extraSensitiveFields ?? []).map((f) => f.toLowerCase()));
  const maxDepth = options.maxDepth ?? 32;
  let count = 0;

  const walk = (v: unknown, depth: number): unknown => {
    if (depth > maxDepth) return "[MAX_DEPTH]";
    if (typeof v === "string") {
      const r = redactString(v);
      count += r.count;
      return r.value;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (SENSITIVE_KEY.test(k) || extra.has(k.toLowerCase())) {
          if (val !== null && val !== undefined && val !== "") count++;
          out[k] = val === null || val === undefined ? val : REDACTED;
        } else {
          out[k] = walk(val, depth + 1);
        }
      }
      return out;
    }
    return v;
  };

  return { value: walk(input, 0) as T, redactions: count };
}
