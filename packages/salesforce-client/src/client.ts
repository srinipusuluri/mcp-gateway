import { assertReadOnlySoql, assertIdentifier, assertSalesforceId } from "./soql";
import {
  SalesforceApiError,
  SalesforceAuthError,
  type ApiUsage,
  type GlobalDescribeEntry,
  type ObjectDescribe,
  type QueryResult,
  type SalesforceApi,
  type SfRecord,
} from "./types";

export interface TokenProvider {
  getAccessToken(): Promise<string>;
  /** Force a refresh (after a 401). Must throw SalesforceAuthError if the session cannot be renewed. */
  refresh(): Promise<string>;
  instanceUrl(): Promise<string>;
}

export interface SalesforceClientOptions {
  tokens: TokenProvider;
  apiVersion?: string;
  fetch?: typeof fetch;
  maxRetries?: number;
  /** Injected for tests so retries are instant. */
  sleep?: (ms: number) => Promise<void>;
}

function stripAttributes<T>(rec: T): T {
  if (Array.isArray(rec)) return rec.map(stripAttributes) as T;
  if (rec && typeof rec === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec as Record<string, unknown>)) if (k !== "attributes") out[k] = stripAttributes(v);
    return out as T;
  }
  return rec;
}

export class SalesforceClient implements SalesforceApi {
  readonly mode = "live" as const;
  apiCalls = 0;
  private usage: ApiUsage = {};
  private readonly apiVersion: string;
  private readonly doFetch: typeof fetch;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: SalesforceClientOptions) {
    this.apiVersion = (opts.apiVersion ?? "v66.0").replace(/^(?=\d)/, "v");
    this.doFetch = opts.fetch ?? ((...a) => fetch(...a));
    this.maxRetries = opts.maxRetries ?? 2;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  apiUsage(): ApiUsage {
    return { ...this.usage };
  }

  private async request<T>(method: string, pathOrUrl: string, body?: unknown): Promise<T> {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const instance = await this.opts.tokens.getAccessToken().then(async (t) => ({ t, base: await this.opts.tokens.instanceUrl() }));
      const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${instance.base}${pathOrUrl}`;
      this.apiCalls++;
      let res: Response;
      try {
        res = await this.doFetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${instance.t}`,
            Accept: "application/json",
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch {
        if (attempt < this.maxRetries) {
          await this.sleep(250 * 2 ** attempt);
          continue;
        }
        throw new SalesforceApiError(0, "NETWORK_ERROR", "Could not reach Salesforce.");
      }
      const limit = res.headers.get("Sforce-Limit-Info");
      const m = limit?.match(/api-usage=(\d+)\/(\d+)/);
      if (m) this.usage = { used: Number(m[1]), limit: Number(m[2]) };

      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await this.opts.tokens.refresh(); // throws SalesforceAuthError when session cannot be renewed
        continue;
      }
      if ((res.status === 429 || res.status === 503 || res.status === 502) && attempt < this.maxRetries) {
        const ra = Number(res.headers.get("Retry-After"));
        await this.sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 5000) : 250 * 2 ** attempt);
        continue;
      }
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      if (!res.ok) {
        const first = Array.isArray(json) ? (json[0] as { message?: string; errorCode?: string } | undefined) : undefined;
        if (res.status === 401) throw new SalesforceAuthError("Salesforce session is invalid or expired.");
        throw new SalesforceApiError(res.status, first?.errorCode ?? `HTTP_${res.status}`, first?.message ?? `Salesforce returned HTTP ${res.status}.`);
      }
      return json as T;
    }
  }

  private p(path: string): string {
    return `/services/data/${this.apiVersion}${path}`;
  }

  async query<T = SfRecord>(soql: string, opts: { maxRecords?: number } = {}): Promise<QueryResult<T>> {
    assertReadOnlySoql(soql);
    const max = opts.maxRecords ?? 2000;
    const records: T[] = [];
    let page = await this.request<{ totalSize: number; done: boolean; records: T[]; nextRecordsUrl?: string }>("GET", this.p(`/query?q=${encodeURIComponent(soql)}`));
    let totalSize = page.totalSize;
    for (;;) {
      records.push(...stripAttributes(page.records));
      if (records.length >= max || page.done || !page.nextRecordsUrl) break;
      page = await this.request("GET", page.nextRecordsUrl);
      totalSize = page.totalSize;
    }
    const cut = records.length > max;
    return { records: cut ? records.slice(0, max) : records, totalSize, done: !cut && (page.done || !page.nextRecordsUrl) };
  }

  async describeGlobal(): Promise<GlobalDescribeEntry[]> {
    const r = await this.request<{ sobjects: Array<GlobalDescribeEntry> }>("GET", this.p("/sobjects"));
    return r.sobjects.map((s) => ({ name: s.name, label: s.label, custom: s.custom, queryable: s.queryable, createable: s.createable, updateable: s.updateable }));
  }

  async describeObject(name: string): Promise<ObjectDescribe> {
    assertIdentifier(name, "object name");
    const r = await this.request<ObjectDescribe>("GET", this.p(`/sobjects/${name}/describe`));
    return {
      name: r.name,
      label: r.label,
      labelPlural: r.labelPlural,
      custom: r.custom,
      queryable: r.queryable,
      createable: r.createable,
      updateable: r.updateable,
      deletable: r.deletable,
      fields: r.fields.map((f) => ({
        name: f.name,
        label: f.label,
        type: f.type,
        length: f.length,
        nillable: f.nillable,
        createable: f.createable,
        updateable: f.updateable,
        referenceTo: f.referenceTo,
        picklistValues: f.picklistValues?.map((p) => ({ value: p.value, label: p.label, active: p.active, defaultValue: p.defaultValue })),
      })),
    };
  }

  async getRecord<T = SfRecord>(object: string, id: string, fields?: string[]): Promise<T> {
    assertIdentifier(object, "object name");
    assertSalesforceId(id);
    const qs = fields?.length ? `?fields=${encodeURIComponent(fields.map((f) => assertIdentifier(f, "field")).join(","))}` : "";
    return stripAttributes(await this.request<T>("GET", this.p(`/sobjects/${object}/${id}${qs}`)));
  }

  async createRecord(object: string, fields: SfRecord) {
    assertIdentifier(object, "object name");
    const r = await this.request<{ id: string; success: boolean }>("POST", this.p(`/sobjects/${object}`), fields);
    return { id: r.id, success: r.success };
  }

  async updateRecord(object: string, id: string, fields: SfRecord) {
    assertIdentifier(object, "object name");
    assertSalesforceId(id);
    await this.request("PATCH", this.p(`/sobjects/${object}/${id}`), fields);
    return { id, success: true };
  }
}
