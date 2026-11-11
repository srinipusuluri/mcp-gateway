import type { SfRecord } from "../types";

export type Table = SfRecord[];
export type Dataset = Record<string, Table>;

export const USERS = {
  admin: "005000000000001AAA",
  east: "005000000000002AAA",
  west: "005000000000003AAA",
} as const;

const mkId = (prefix: string, n: number) => `${prefix}${String(n).padStart(12, "0")}AAA`;
export const accId = (n: number) => mkId("001", n);
const conId = (n: number) => mkId("003", n);
const oppId = (n: number) => mkId("006", n);
const caseId = (n: number) => mkId("500", n);

const day = 86_400_000;
const iso = (now: Date, offsetDays: number) => new Date(now.getTime() + offsetDays * day).toISOString();
const dateOnly = (now: Date, offsetDays: number) => iso(now, offsetDays).slice(0, 10);

/** Deterministic demo org, generated relative to `now` so date-based logic stays meaningful. */
export function buildDataset(now = new Date()): Dataset {
  const accounts: Array<[string, string, string, number, string, string, number, number, string, string]> = [
    // name, industry, type, revenue, rating, city, overdueInvoices, pastDue, owner, taxId
    ["Acme Corporation", "Technology", "Customer", 52_000_000, "Hot", "San Francisco", 3, 84_000, USERS.east, "12-3456789"],
    ["Globex Industries", "Manufacturing", "Customer", 310_000_000, "Warm", "Chicago", 0, 0, USERS.east, "98-7654321"],
    ["Initech", "Technology", "Customer", 18_500_000, "Warm", "Austin", 1, 12_500, USERS.west, "45-1112223"],
    ["Umbrella Health", "Healthcare", "Customer", 120_000_000, "Cold", "Boston", 4, 156_000, USERS.east, "33-4445556"],
    ["Stark Logistics", "Transportation", "Prospect", 76_000_000, "Hot", "New York", 0, 0, USERS.west, "77-8889990"],
    ["Wayne Financial", "Banking", "Customer", 890_000_000, "Warm", "Gotham", 0, 0, USERS.admin, "21-3141592"],
    ["Hooli Media", "Media", "Prospect", 44_000_000, "Cold", "Palo Alto", 2, 31_000, USERS.west, "55-6667778"],
    ["Soylent Foods", "Consumer Goods", "Customer", 64_000_000, "Warm", "Portland", 0, 0, USERS.admin, "11-2223334"],
  ];
  const Account: Table = accounts.map((a, i) => ({
    Id: accId(i + 1), Name: a[0], Industry: a[1], Type: a[2], AnnualRevenue: a[3], Rating: a[4], BillingCity: a[5], BillingCountry: "US",
    NumberOfEmployees: 200 + i * 350, Website: `https://www.${a[0].toLowerCase().replace(/[^a-z]/g, "")}.example.com`, Phone: `+1-555-01${String(i).padStart(2, "0")}`,
    OwnerId: a[8], CreatedDate: iso(now, -900 + i * 40), Overdue_Invoices__c: a[6], Past_Due_Amount__c: a[7], Tax_ID__c: a[9],
  }));

  const people: Array<[number, string, string, string, string]> = [
    [1, "Dana", "Whitfield", "VP Engineering", "Engineering"], [1, "Raj", "Patel", "Procurement Lead", "Finance"], [1, "Mei", "Chen", "CTO", "Executive"],
    [2, "Luis", "Ortega", "Plant Director", "Operations"], [2, "Hannah", "Berg", "IT Manager", "IT"],
    [3, "Peter", "Gibbons", "Director IT", "IT"], [3, "Samir", "Nagheenanajar", "Engineer", "Engineering"],
    [4, "Elena", "Rossi", "CIO", "Executive"], [4, "Tom", "Okafor", "Billing Contact", "Finance"],
    [5, "Pepper", "Hart", "COO", "Executive"], [6, "Lucius", "Fox", "Head of Technology", "Technology"], [6, "Selina", "Kyle", "Risk Officer", "Risk"],
    [7, "Gavin", "Belson", "Head of Product", "Product"], [8, "Ana", "Lima", "Supply Chain VP", "Operations"],
  ];
  const Contact: Table = people.map((p, i) => {
    const acct = accounts[p[0] - 1]!;
    return {
      Id: conId(i + 1), FirstName: p[1], LastName: p[2], Name: `${p[1]} ${p[2]}`, Email: `${p[1]}.${p[2]}@${acct[0].toLowerCase().replace(/[^a-z]/g, "")}.example.com`.toLowerCase(),
      Phone: `+1-555-02${String(i).padStart(2, "0")}`, Title: p[3], Department: p[4], AccountId: accId(p[0]), OwnerId: acct[8], National_ID__c: `${100 + i}-${20 + i}-${3000 + i}`,
    };
  });

  const opps: Array<[number, string, string, number, number, number, number, string, number | null]> = [
    // acct, name, stage, amount, closeOffsetDays, probability, createdOffset, type, previousAmount
    [1, "Acme – Platform Expansion", "Negotiation/Review", 420_000, 21, 80, -120, "Existing Business", 500_000],
    [1, "Acme – Support Renewal", "Proposal/Price Quote", 95_000, 45, 60, -60, "Renewal", 95_000],
    [1, "Acme – Legacy Migration", "Closed Won", 210_000, -30, 100, -200, "Existing Business", null],
    [2, "Globex – Plant Automation", "Needs Analysis", 780_000, 90, 40, -45, "New Business", null],
    [2, "Globex – IoT Sensors", "Qualification", 150_000, 120, 20, -20, "New Business", null],
    [3, "Initech – Analytics Add-on", "Closed Lost", 60_000, -15, 0, -150, "Existing Business", null],
    [3, "Initech – Seats Expansion", "Proposal/Price Quote", 88_000, 12, 60, -35, "Existing Business", 120_000],
    [4, "Umbrella – Compliance Suite", "Negotiation/Review", 640_000, -5, 75, -140, "New Business", 700_000],
    [4, "Umbrella – Data Platform", "Prospecting", 300_000, 150, 10, -10, "New Business", null],
    [5, "Stark – Fleet Telemetry", "Proposal/Price Quote", 520_000, 30, 55, -50, "New Business", null],
    [5, "Stark – Pilot", "Closed Won", 75_000, -60, 100, -120, "New Business", null],
    [6, "Wayne – Risk Engine", "Needs Analysis", 1_200_000, 100, 40, -30, "New Business", null],
    [6, "Wayne – Audit Module", "Negotiation/Review", 340_000, 14, 80, -80, "Existing Business", null],
    [7, "Hooli – Media Suite", "Qualification", 210_000, 75, 20, -25, "New Business", 260_000],
    [8, "Soylent – Traceability", "Closed Won", 145_000, -20, 100, -110, "New Business", null],
    [8, "Soylent – Renewal", "Prospecting", 58_000, 60, 10, -5, "Renewal", null],
  ];
  const Opportunity: Table = opps.map((o, i) => {
    const closed = o[2].startsWith("Closed");
    return {
      Id: oppId(i + 1), Name: o[1], AccountId: accId(o[0]), StageName: o[2], Amount: o[3], CloseDate: dateOnly(now, o[4]), Probability: o[5], IsClosed: closed, IsWon: o[2] === "Closed Won",
      Type: o[7], LeadSource: ["Web", "Partner", "Referral", "Event"][i % 4], NextStep: closed ? null : "Schedule exec review", ForecastCategoryName: closed ? "Closed" : o[5] >= 60 ? "Commit" : "Pipeline",
      OwnerId: accounts[o[0] - 1]![8], LastModifiedDate: iso(now, -((i * 3) % 20) - 1), CreatedDate: iso(now, o[6]), Previous_Amount__c: o[8],
    };
  });

  const cases: Array<[number, number, string, string, string, string, number, boolean]> = [
    // acct, contactIdx, subject, status, priority, type, ageDays, escalated
    [1, 1, "API latency spikes in production", "Working", "High", "Problem", 9, false],
    [1, 2, "Invoice discrepancy Q3", "New", "Medium", "Question", 3, false],
    [1, 3, "SSO outage affecting executives", "Escalated", "High", "Problem", 12, true],
    [2, 4, "Sensor firmware rollback request", "Working", "Medium", "Problem", 6, false],
    [3, 6, "Seat provisioning failing", "New", "High", "Problem", 8, false],
    [3, 7, "Feature request: audit export", "Closed", "Low", "Feature Request", 40, false],
    [4, 8, "Data loss on nightly sync", "Escalated", "High", "Problem", 15, true],
    [4, 9, "Billing portal access", "Working", "Medium", "Question", 11, false],
    [4, 8, "Compliance report discrepancy", "New", "High", "Problem", 5, false],
    [5, 10, "Onboarding documentation gap", "Closed", "Low", "Question", 30, false],
    [6, 11, "SAML configuration help", "Working", "Low", "Question", 4, false],
    [7, 13, "Trial extension request", "New", "Low", "Question", 2, false],
    [8, 14, "Integration timeout", "On Hold", "Medium", "Problem", 20, false],
    [1, 1, "Dashboard export formatting", "Closed", "Low", "Question", 25, false],
  ];
  const Case: Table = cases.map((c, i) => ({
    Id: caseId(i + 1), CaseNumber: `0000${1000 + i}`, Subject: c[2], Status: c[3], Priority: c[4], Origin: ["Phone", "Email", "Web"][i % 3], Type: c[5],
    Description: `Customer reports: ${c[2].toLowerCase()}. Reference tax id 12-3456789 and card 4111 1111 1111 1111 were pasted by the customer.`,
    AccountId: accId(c[0]), ContactId: conId(c[1]), OwnerId: accounts[c[0] - 1]![8], IsClosed: c[3] === "Closed", IsEscalated: c[7], CreatedDate: iso(now, -c[6]),
    ClosedDate: c[3] === "Closed" ? iso(now, -c[6] + 3) : null,
  }));

  const Product2: Table = [
    { Id: mkId("01t", 1), Name: "Platform Enterprise", ProductCode: "PLT-ENT", Family: "Platform" },
    { Id: mkId("01t", 2), Name: "Premium Support", ProductCode: "SUP-PRM", Family: "Support" },
    { Id: mkId("01t", 3), Name: "Analytics Add-on", ProductCode: "ANL-ADD", Family: "Analytics" },
    { Id: mkId("01t", 4), Name: "Implementation Services", ProductCode: "SVC-IMP", Family: "Services" },
  ];
  const Quote: Table = [
    { Id: mkId("0Q0", 1), Name: "Acme Expansion Quote v2", QuoteNumber: "Q-00001", OpportunityId: oppId(1), AccountId: accId(1), Status: "Presented", Subtotal: 480_000, Discount: 12.5, GrandTotal: 420_000, ExpirationDate: dateOnly(now, 14), CreatedDate: iso(now, -20) },
    { Id: mkId("0Q0", 2), Name: "Umbrella Compliance Quote", QuoteNumber: "Q-00002", OpportunityId: oppId(8), AccountId: accId(4), Status: "Draft", Subtotal: 800_000, Discount: 20, GrandTotal: 640_000, ExpirationDate: dateOnly(now, -3), CreatedDate: iso(now, -40) },
    { Id: mkId("0Q0", 3), Name: "Stark Telemetry Quote", QuoteNumber: "Q-00003", OpportunityId: oppId(10), AccountId: accId(5), Status: "Presented", Subtotal: 560_000, Discount: 7.1, GrandTotal: 520_000, ExpirationDate: dateOnly(now, 20), CreatedDate: iso(now, -15) },
  ];
  const line = (n: number, q: number, p: number, qty: number, list: number, disc: number) => ({
    Id: mkId("0QL", n), QuoteId: mkId("0Q0", q), Product2Id: mkId("01t", p), Quantity: qty, ListPrice: list, UnitPrice: Math.round(list * (1 - disc / 100)), Discount: disc, TotalPrice: Math.round(list * (1 - disc / 100)) * qty, Description: null,
  });
  const QuoteLineItem: Table = [line(1, 1, 1, 100, 3000, 10), line(2, 1, 2, 100, 600, 15), line(3, 1, 4, 40, 3000, 12), line(4, 2, 1, 150, 3500, 22), line(5, 2, 3, 150, 1200, 18), line(6, 2, 4, 60, 3000, 25), line(7, 3, 1, 120, 3500, 6), line(8, 3, 2, 120, 700, 9)];
  const Order: Table = [
    { Id: mkId("801", 1), OrderNumber: "00000100", AccountId: accId(1), Status: "Activated", TotalAmount: 210_000, EffectiveDate: dateOnly(now, -30) },
    { Id: mkId("801", 2), OrderNumber: "00000101", AccountId: accId(5), Status: "Activated", TotalAmount: 75_000, EffectiveDate: dateOnly(now, -60) },
    { Id: mkId("801", 3), OrderNumber: "00000102", AccountId: accId(8), Status: "Draft", TotalAmount: 145_000, EffectiveDate: dateOnly(now, -20) },
  ];
  const Asset: Table = [
    { Id: mkId("02i", 1), Name: "Platform Enterprise – 100 seats", AccountId: accId(1), SerialNumber: "PLT-ACM-001", Status: "Installed", InstallDate: dateOnly(now, -300), Quantity: 100, Price: 270_000 },
    { Id: mkId("02i", 2), Name: "Telemetry Pilot Kit", AccountId: accId(5), SerialNumber: "TEL-STK-007", Status: "Installed", InstallDate: dateOnly(now, -55), Quantity: 25, Price: 75_000 },
  ];
  const SBQQ__Subscription__c: Table = [
    { Id: mkId("a0S", 1), SBQQ__Account__c: accId(1), SBQQ__ProductName__c: "Premium Support", SBQQ__Quantity__c: 100, SBQQ__NetPrice__c: 510, SBQQ__StartDate__c: dateOnly(now, -300), SBQQ__EndDate__c: dateOnly(now, 65) },
    { Id: mkId("a0S", 2), SBQQ__Account__c: accId(3), SBQQ__ProductName__c: "Platform Enterprise", SBQQ__Quantity__c: 40, SBQQ__NetPrice__c: 2700, SBQQ__StartDate__c: dateOnly(now, -200), SBQQ__EndDate__c: dateOnly(now, 165) },
  ];
  const Knowledge__kav: Table = [
    { Id: mkId("ka0", 1), Title: "Resolving API latency spikes", UrlName: "api-latency-spikes", Summary: "Check regional status, rate-limit headers and connection pooling before escalating.", Body__c: "<p>1. Verify the status page. 2. Inspect <b>Retry-After</b> headers. 3. Enable connection pooling and keep-alive. 4. If p95 > 2s for 15 minutes, open a P1 with a HAR capture.</p>", PublishStatus: "Online", Language: "en_US", LastPublishedDate: iso(now, -30) },
    { Id: mkId("ka0", 2), Title: "Configuring SAML single sign-on", UrlName: "saml-sso-setup", Summary: "Step-by-step SAML 2.0 configuration for Okta, Entra ID and Ping.", Body__c: "<p>Upload IdP metadata, map NameID to the federation identifier, then test with the SSO diagnostics page. Clock skew over 3 minutes causes assertion rejection.</p>", PublishStatus: "Online", Language: "en_US", LastPublishedDate: iso(now, -90) },
    { Id: mkId("ka0", 3), Title: "Nightly sync data-loss runbook", UrlName: "nightly-sync-data-loss", Summary: "Triage and recover from failed or partial nightly syncs.", Body__c: "<p>Pause the scheduler, compare row counts using the reconciliation report, replay from the last good checkpoint. Always attach the job id when escalating.</p>", PublishStatus: "Online", Language: "en_US", LastPublishedDate: iso(now, -10) },
    { Id: mkId("ka0", 4), Title: "Understanding billing portal access", UrlName: "billing-portal-access", Summary: "Roles and invitations required for the billing portal.", Body__c: "<p>Only users with the Billing Admin role can open the portal. Invite from Settings > Users.</p>", PublishStatus: "Online", Language: "en_US", LastPublishedDate: iso(now, -200) },
  ];
  const User: Table = [
    { Id: USERS.admin, Name: "Alex Admin", Email: "alex.admin@example.com" },
    { Id: USERS.east, Name: "Erin East", Email: "erin.east@example.com" },
    { Id: USERS.west, Name: "Wes West", Email: "wes.west@example.com" },
  ];

  return { Account, Contact, Opportunity, Case, Product2, Quote, QuoteLineItem, Order, Asset, SBQQ__Subscription__c, Knowledge__kav, User };
}
