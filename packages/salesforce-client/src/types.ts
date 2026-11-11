export type SfRecord = Record<string, unknown>;

export interface QueryResult<T = SfRecord> {
  records: T[];
  totalSize: number;
  /** True when every matching row was fetched (no further pages / maxRecords cut). */
  done: boolean;
}

export interface FieldDescribe {
  name: string;
  label: string;
  type: string;
  length?: number;
  nillable?: boolean;
  createable: boolean;
  updateable: boolean;
  referenceTo?: string[];
  picklistValues?: Array<{ value: string; label: string; active: boolean; defaultValue?: boolean }>;
}

export interface ObjectDescribe {
  name: string;
  label: string;
  labelPlural?: string;
  custom: boolean;
  queryable: boolean;
  createable: boolean;
  updateable: boolean;
  deletable: boolean;
  fields: FieldDescribe[];
}

export interface GlobalDescribeEntry {
  name: string;
  label: string;
  custom: boolean;
  queryable: boolean;
  createable: boolean;
  updateable: boolean;
}

export interface ApiUsage {
  used?: number;
  limit?: number;
}

/**
 * The host-side Salesforce capability surface. Implemented by SalesforceClient (live REST)
 * and MockSalesforceClient. Sandboxed code NEVER receives an instance; it only gets
 * registry tools that call this on the host.
 */
export interface SalesforceApi {
  readonly mode: "mock" | "live";
  query<T = SfRecord>(soql: string, opts?: { maxRecords?: number }): Promise<QueryResult<T>>;
  describeGlobal(): Promise<GlobalDescribeEntry[]>;
  describeObject(name: string): Promise<ObjectDescribe>;
  getRecord<T = SfRecord>(object: string, id: string, fields?: string[]): Promise<T>;
  createRecord(object: string, fields: SfRecord): Promise<{ id: string; success: boolean }>;
  updateRecord(object: string, id: string, fields: SfRecord): Promise<{ id: string; success: boolean }>;
  /** Number of Salesforce REST calls made through this instance. */
  readonly apiCalls: number;
  apiUsage(): ApiUsage;
}

export class SalesforceApiError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string,
    message: string,
  ) {
    super(message);
    this.name = "SalesforceApiError";
  }
}

export class SalesforceAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SalesforceAuthError";
  }
}

/** Wrap an API so calls made through the wrapper are counted separately (per tool call). */
export function withMeter(api: SalesforceApi, meter: { calls: number }): SalesforceApi {
  const count = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => (...a: A) => {
    meter.calls++;
    return fn(...a);
  };
  return {
    get mode() {
      return api.mode;
    },
    get apiCalls() {
      return api.apiCalls;
    },
    apiUsage: () => api.apiUsage(),
    query: count(api.query.bind(api)) as SalesforceApi["query"],
    describeGlobal: count(api.describeGlobal.bind(api)),
    describeObject: count(api.describeObject.bind(api)),
    getRecord: count(api.getRecord.bind(api)) as SalesforceApi["getRecord"],
    createRecord: count(api.createRecord.bind(api)),
    updateRecord: count(api.updateRecord.bind(api)),
  };
}
