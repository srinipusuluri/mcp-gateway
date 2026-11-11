import { assertReadOnlySoql } from "../soql";
import {
  SalesforceApiError,
  type ApiUsage,
  type GlobalDescribeEntry,
  type ObjectDescribe,
  type QueryResult,
  type SalesforceApi,
  type SfRecord,
} from "../types";
import { buildDataset, USERS, type Dataset } from "./data";
import { OBJECTS, toFieldDescribe, type ObjectSpec } from "./schema";
import { evalExpr, parseSoql } from "./soql-eval";

/** Simulated Salesforce permissions of ONE user (profile + permission sets + sharing). */
export interface MockUserContext {
  userId: string;
  label: string;
  /** Objects the user can read / create / update. Missing = no access. */
  objects: Record<string, { read?: boolean; create?: boolean; update?: boolean }>;
  /** Field-level security: fields hidden from this user, per object. */
  hiddenFields?: Record<string, string[]>;
  /** 'all' = org-wide read; 'own' = only records the user owns (private OWD). */
  sharing: "all" | "own";
}

const READ_ALL = Object.fromEntries(OBJECTS.map((o) => [o.name, { read: true }]));

export const MOCK_USERS: Record<string, MockUserContext> = {
  sf_admin: { userId: USERS.admin, label: "System Administrator", objects: { ...Object.fromEntries(OBJECTS.map((o) => [o.name, { read: true, create: true, update: true }])) }, sharing: "all" },
  sf_analyst: { userId: USERS.admin, label: "Sales Analyst (read-only, all records)", objects: READ_ALL, sharing: "all" },
  sf_service: {
    userId: USERS.west,
    label: "Service Agent (no revenue/amount fields, can edit Cases)",
    objects: { ...READ_ALL, Case: { read: true, create: true, update: true }, Quote: {}, QuoteLineItem: {}, SBQQ__Subscription__c: {} },
    hiddenFields: { Account: ["AnnualRevenue", "Tax_ID__c", "Past_Due_Amount__c"], Opportunity: ["Amount", "Previous_Amount__c"], Contact: ["National_ID__c"] },
    sharing: "all",
  },
  sf_rep_east: { userId: USERS.east, label: "Sales Rep East (private sharing: own records only)", objects: READ_ALL, hiddenFields: { Account: ["Tax_ID__c"], Contact: ["National_ID__c"] }, sharing: "own" },
};

/** The shared, mutable fake org. One per process; each request gets a user-scoped client view of it. */
export class MockOrg {
  readonly data: Dataset;
  private seq = 9000;
  constructor(readonly now = new Date(), data?: Dataset) {
    this.data = data ?? buildDataset(now);
  }
  nextId(prefix: string): string {
    return `${prefix}${String(++this.seq).padStart(12, "0")}AAA`;
  }
}

const RELATIONSHIPS: Record<string, { fk: string; table: string }> = {
  Account: { fk: "AccountId", table: "Account" },
  Owner: { fk: "OwnerId", table: "User" },
  Contact: { fk: "ContactId", table: "Contact" },
  Opportunity: { fk: "OpportunityId", table: "Opportunity" },
  Quote: { fk: "QuoteId", table: "Quote" },
  Product2: { fk: "Product2Id", table: "Product2" },
};

const ID_PREFIX: Record<string, string> = { Case: "500", Account: "001", Contact: "003", Opportunity: "006" };

export class MockSalesforceClient implements SalesforceApi {
  readonly mode = "mock" as const;
  apiCalls = 0;

  constructor(
    private readonly org: MockOrg,
    private readonly user: MockUserContext,
  ) {}

  apiUsage(): ApiUsage {
    return { used: this.apiCalls, limit: 15000 };
  }

  private spec(name: string): ObjectSpec {
    const s = OBJECTS.find((o) => o.name.toLowerCase() === name.toLowerCase());
    // Same error Salesforce gives for objects that do not exist or are invisible.
    if (!s || !this.user.objects[s.name]?.read) throw new SalesforceApiError(404, "NOT_FOUND", `The requested resource does not exist: ${name}`);
    return s;
  }

  private hidden(object: string): Set<string> {
    return new Set((this.user.hiddenFields?.[object] ?? []).map((x) => x.toLowerCase()));
  }

  private fieldExists(spec: ObjectSpec, field: string): boolean {
    return spec.fields.some((f) => f.name.toLowerCase() === field.toLowerCase()) && !this.hidden(spec.name).has(field.toLowerCase());
  }

  private visible(object: string, rec: SfRecord): boolean {
    if (this.user.sharing === "all") return true;
    if (["Account", "Contact", "Opportunity", "Case"].includes(object)) return rec.OwnerId === this.user.userId;
    if (["Quote", "Order", "Asset"].includes(object) && rec.AccountId) {
      const acct = this.org.data.Account?.find((a) => a.Id === rec.AccountId);
      return acct?.OwnerId === this.user.userId;
    }
    return true;
  }

  private getField = (object: string) => (rec: SfRecord, path: string): unknown => {
    const parts = path.split(".");
    let cur: SfRecord | undefined = rec;
    let obj = object;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!;
      if (!cur) return null;
      if (i === parts.length - 1) return cur[p] ?? null;
      const rel = RELATIONSHIPS[p];
      if (!rel) throw new SalesforceApiError(400, "INVALID_FIELD", `Didn't understand relationship '${p}' in field path '${path}'.`);
      const fkVal: unknown = cur[rel.fk];
      cur = this.org.data[rel.table]?.find((r) => r.Id === fkVal);
      obj = rel.table;
    }
    void obj;
    return null;
  };

  private checkFieldPath(spec: ObjectSpec, path: string): void {
    const parts = path.split(".");
    if (parts.length === 1) {
      if (!this.fieldExists(spec, path)) {
        throw new SalesforceApiError(400, "INVALID_FIELD", `No such column '${path}' on entity '${spec.name}'. If you are attempting to use a custom field, be sure to append '__c' after the custom field name.`);
      }
      return;
    }
    const rel = RELATIONSHIPS[parts[0]!];
    if (!rel) throw new SalesforceApiError(400, "INVALID_FIELD", `Didn't understand relationship '${parts[0]}'.`);
    const target = OBJECTS.find((o) => o.name === rel.table);
    if (!target || !this.user.objects[target.name]?.read) throw new SalesforceApiError(400, "INVALID_FIELD", `No such relationship '${parts[0]}' on entity '${spec.name}'.`);
    if (!target.fields.some((f) => f.name === parts[1]) || this.hidden(target.name).has(parts[1]!.toLowerCase())) {
      throw new SalesforceApiError(400, "INVALID_FIELD", `No such column '${parts[1]}' on entity '${target.name}'.`);
    }
  }

  async query<T = SfRecord>(soql: string, opts: { maxRecords?: number } = {}): Promise<QueryResult<T>> {
    assertReadOnlySoql(soql);
    this.apiCalls++;
    const q = parseSoql(soql);
    let spec: ObjectSpec;
    try {
      spec = this.spec(q.object);
    } catch {
      throw new SalesforceApiError(400, "INVALID_TYPE", `sObject type '${q.object}' is not supported.`);
    }
    for (const f of q.fields) this.checkFieldPath(spec, f);
    for (const o of q.orderBy) this.checkFieldPath(spec, o.field);
    const walk = (e: typeof q.where): void => {
      if (!e) return;
      if (e.t === "cmp") this.checkFieldPath(spec, e.field);
      else if (e.t === "not") walk(e.e);
      else {
        walk(e.l);
        walk(e.r);
      }
    };
    walk(q.where);

    const env = { now: this.org.now, getField: this.getField(spec.name) };
    let rows = (this.org.data[spec.name] ?? []).filter((r) => this.visible(spec.name, r));
    if (q.where) rows = rows.filter((r) => evalExpr(q.where!, r, env));
    for (const o of [...q.orderBy].reverse()) {
      rows = [...rows].sort((a, b) => {
        const av = env.getField(a, o.field) as string | number | null;
        const bv = env.getField(b, o.field) as string | number | null;
        const c = av == null ? (bv == null ? 0 : -1) : bv == null ? 1 : av < bv ? -1 : av > bv ? 1 : 0;
        return o.desc ? -c : c;
      });
    }
    const total = rows.length;
    const start = q.offset ?? 0;
    const limit = Math.min(q.limit ?? 2000, opts.maxRecords ?? 2000);
    const page = rows.slice(start, start + limit);
    const records = page.map((r) => {
      const out: SfRecord = {};
      for (const f of q.fields) {
        const parts = f.split(".");
        if (parts.length === 1) {
          const canonical = spec.fields.find((x) => x.name.toLowerCase() === f.toLowerCase())!.name;
          out[canonical] = r[canonical] ?? null;
        } else {
          const nested = (out[parts[0]!] as SfRecord | undefined) ?? {};
          nested[parts[1]!] = env.getField(r, f);
          out[parts[0]!] = nested;
        }
      }
      return out as T;
    });
    return { records, totalSize: total, done: start + page.length >= total };
  }

  async describeGlobal(): Promise<GlobalDescribeEntry[]> {
    this.apiCalls++;
    return OBJECTS.filter((o) => this.user.objects[o.name]?.read).map((o) => ({
      name: o.name,
      label: o.label,
      custom: !!o.custom,
      queryable: true,
      createable: !!this.user.objects[o.name]?.create,
      updateable: !!this.user.objects[o.name]?.update,
    }));
  }

  async describeObject(name: string): Promise<ObjectDescribe> {
    this.apiCalls++;
    const spec = this.spec(name);
    const perms = this.user.objects[spec.name]!;
    const hidden = this.hidden(spec.name);
    return {
      name: spec.name,
      label: spec.label,
      custom: !!spec.custom,
      queryable: true,
      createable: !!perms.create,
      updateable: !!perms.update,
      deletable: false,
      // FLS: hidden fields are simply absent from a user's describe, exactly like real Salesforce.
      fields: spec.fields.filter((f) => !hidden.has(f.name.toLowerCase())).map((f) => toFieldDescribe(f, !!perms.create, !!perms.update)),
    };
  }

  async getRecord<T = SfRecord>(object: string, id: string, fields?: string[]): Promise<T> {
    const q = await this.query<SfRecord>(`SELECT ${(fields?.length ? fields : ["Id"]).join(", ")} FROM ${object} WHERE Id = '${id.replace(/[^A-Za-z0-9]/g, "")}' LIMIT 1`);
    const rec = q.records[0];
    if (!rec) throw new SalesforceApiError(404, "NOT_FOUND", "Provided external ID field does not exist or is not accessible");
    return rec as T;
  }

  private writeChecks(object: string, fields: SfRecord, mode: "create" | "update") {
    const spec = OBJECTS.find((o) => o.name === object);
    const perms = this.user.objects[object];
    if (!spec || !perms?.read) throw new SalesforceApiError(404, "NOT_FOUND", `The requested resource does not exist: ${object}`);
    if (!perms[mode]) throw new SalesforceApiError(403, "INSUFFICIENT_ACCESS_OR_READONLY", `insufficient access rights on object: ${object}`);
    const hidden = this.hidden(object);
    for (const key of Object.keys(fields)) {
      const fs = spec.fields.find((f) => f.name === key);
      if (!fs || hidden.has(key.toLowerCase())) throw new SalesforceApiError(400, "INVALID_FIELD", `No such column '${key}' on sobject of type ${object}`);
      const d = toFieldDescribe(fs, !!perms.create, !!perms.update);
      if (mode === "create" ? !d.createable : !d.updateable) throw new SalesforceApiError(400, "INVALID_FIELD_FOR_INSERT_UPDATE", `Unable to ${mode} field: ${key}`);
      if (fs.picklist && typeof fields[key] === "string" && !fs.picklist.includes(fields[key] as string)) {
        throw new SalesforceApiError(400, "INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST", `bad value for restricted picklist field: ${String(fields[key])}`);
      }
    }
  }

  async createRecord(object: string, fields: SfRecord) {
    this.apiCalls++;
    this.writeChecks(object, fields, "create");
    const table = (this.org.data[object] ??= []);
    const id = this.org.nextId(ID_PREFIX[object] ?? "a00");
    const defaults: SfRecord = object === "Case"
      ? { CaseNumber: String(2000 + table.length), Status: "New", Priority: "Medium", IsClosed: false, IsEscalated: false, CreatedDate: this.org.now.toISOString(), OwnerId: this.user.userId }
      : { OwnerId: this.user.userId };
    table.push({ ...defaults, ...fields, Id: id });
    return { id, success: true };
  }

  async updateRecord(object: string, id: string, fields: SfRecord) {
    this.apiCalls++;
    this.writeChecks(object, fields, "update");
    const rec = (this.org.data[object] ?? []).find((r) => r.Id === id && this.visible(object, r));
    if (!rec) throw new SalesforceApiError(404, "ENTITY_IS_DELETED", "entity is deleted or not accessible");
    Object.assign(rec, fields);
    if (object === "Case" && "Status" in fields) rec.IsClosed = fields.Status === "Closed";
    return { id, success: true };
  }
}

export function mockUserFor(profileKey: string): MockUserContext {
  const u = MOCK_USERS[profileKey];
  if (!u) throw new Error(`Unknown mock profile '${profileKey}'`);
  return u;
}
