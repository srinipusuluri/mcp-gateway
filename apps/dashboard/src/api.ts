export interface ApiError {
  code: string;
  message: string;
  approvalId?: string;
}

const TOKEN_KEY = "sfcm.token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
export function setToken(t: string | null): void {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: session-only */
  }
  memoryToken = t;
}
let memoryToken: string | null = null;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly apiError: ApiError,
  ) {
    super(apiError.message);
  }
}

export async function api<T = any>(path: string, init: { method?: string; body?: unknown; token?: string | null } = {}): Promise<T> {
  const token = init.token ?? memoryToken ?? getToken();
  const res = await fetch(path, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: { code: "internal_error", message: `Unexpected response (HTTP ${res.status})` } };
  }
  if (!res.ok) throw new HttpError(res.status, json.error ?? { code: "internal_error", message: `HTTP ${res.status}` });
  return json as T;
}

export const fmtMs = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${Math.round(n)} ms`);
export const fmtNum = (n: number) => new Intl.NumberFormat().format(n);
export const fmtTime = (iso: string) => new Date(iso).toLocaleString();
