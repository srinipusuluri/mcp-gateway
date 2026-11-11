import type { FieldDescribe } from "../types";

export interface FieldSpec {
  name: string;
  label: string;
  type: string;
  createable?: boolean;
  updateable?: boolean;
  referenceTo?: string[];
  picklist?: string[];
}

export interface ObjectSpec {
  name: string;
  label: string;
  custom?: boolean;
  createable?: boolean;
  updateable?: boolean;
  fields: FieldSpec[];
}

const f = (name: string, type = "string", extra: Partial<FieldSpec> = {}): FieldSpec => ({ name, label: name.replace(/__c$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " "), type, ...extra });
const id = (): FieldSpec => f("Id", "id");
const ref = (name: string, to: string): FieldSpec => f(name, "reference", { referenceTo: [to], createable: true, updateable: true });

export const OBJECTS: ObjectSpec[] = [
  {
    name: "Account", label: "Account",
    fields: [
      id(), f("Name"), f("Industry", "picklist", { picklist: ["Technology", "Manufacturing", "Healthcare", "Transportation", "Banking", "Media", "Consumer Goods"] }),
      f("Type", "picklist", { picklist: ["Customer", "Prospect", "Partner"] }), f("Rating", "picklist", { picklist: ["Hot", "Warm", "Cold"] }),
      f("AnnualRevenue", "currency"), f("NumberOfEmployees", "int"), f("BillingCity"), f("BillingCountry"), f("Website", "url"), f("Phone", "phone"),
      ref("OwnerId", "User"), f("CreatedDate", "datetime"),
      f("Overdue_Invoices__c", "double"), f("Past_Due_Amount__c", "currency"), f("Tax_ID__c", "string"),
    ],
  },
  {
    name: "Contact", label: "Contact",
    fields: [id(), f("FirstName"), f("LastName"), f("Name"), f("Email", "email"), f("Phone", "phone"), f("Title"), f("Department"), ref("AccountId", "Account"), ref("OwnerId", "User"), f("National_ID__c", "string")],
  },
  {
    name: "Opportunity", label: "Opportunity",
    fields: [
      id(), f("Name"), ref("AccountId", "Account"),
      f("StageName", "picklist", { picklist: ["Prospecting", "Qualification", "Needs Analysis", "Proposal/Price Quote", "Negotiation/Review", "Closed Won", "Closed Lost"] }),
      f("Amount", "currency"), f("CloseDate", "date"), f("Probability", "percent"), f("IsClosed", "boolean"), f("IsWon", "boolean"), f("Type"), f("LeadSource"), f("NextStep"),
      f("ForecastCategoryName"), ref("OwnerId", "User"), f("LastModifiedDate", "datetime"), f("CreatedDate", "datetime"), f("Previous_Amount__c", "currency"),
    ],
  },
  {
    name: "Case", label: "Case",
    fields: [
      id(), f("CaseNumber"), f("Subject", "string", { createable: true, updateable: true }),
      f("Status", "picklist", { picklist: ["New", "Working", "Escalated", "On Hold", "Closed"], createable: true, updateable: true }),
      f("Priority", "picklist", { picklist: ["Low", "Medium", "High"], createable: true, updateable: true }),
      f("Origin", "picklist", { picklist: ["Phone", "Email", "Web"], createable: true, updateable: true }),
      f("Type", "picklist", { picklist: ["Problem", "Question", "Feature Request"], createable: true, updateable: true }),
      f("Description", "textarea", { createable: true, updateable: true }), ref("AccountId", "Account"), ref("ContactId", "Contact"), ref("OwnerId", "User"),
      f("IsClosed", "boolean"), f("IsEscalated", "boolean", { createable: true, updateable: true }), f("CreatedDate", "datetime"), f("ClosedDate", "datetime"),
    ],
  },
  { name: "User", label: "User", fields: [id(), f("Name"), f("Email", "email")] },
  { name: "Product2", label: "Product", fields: [id(), f("Name"), f("ProductCode"), f("Family")] },
  {
    name: "Quote", label: "Quote",
    fields: [id(), f("Name"), f("QuoteNumber"), ref("OpportunityId", "Opportunity"), ref("AccountId", "Account"), f("Status"), f("Subtotal", "currency"), f("Discount", "percent"), f("GrandTotal", "currency"), f("ExpirationDate", "date"), f("CreatedDate", "datetime")],
  },
  {
    name: "QuoteLineItem", label: "Quote Line Item",
    fields: [id(), ref("QuoteId", "Quote"), ref("Product2Id", "Product2"), f("Quantity", "double"), f("ListPrice", "currency"), f("UnitPrice", "currency"), f("Discount", "percent"), f("TotalPrice", "currency"), f("Description")],
  },
  { name: "Order", label: "Order", fields: [id(), f("OrderNumber"), ref("AccountId", "Account"), f("Status"), f("TotalAmount", "currency"), f("EffectiveDate", "date")] },
  { name: "Asset", label: "Asset", fields: [id(), f("Name"), ref("AccountId", "Account"), f("SerialNumber"), f("Status"), f("InstallDate", "date"), f("Quantity", "double"), f("Price", "currency")] },
  {
    name: "SBQQ__Subscription__c", label: "Subscription", custom: true,
    fields: [id(), ref("SBQQ__Account__c", "Account"), f("SBQQ__ProductName__c"), f("SBQQ__Quantity__c", "double"), f("SBQQ__NetPrice__c", "currency"), f("SBQQ__StartDate__c", "date"), f("SBQQ__EndDate__c", "date")],
  },
  { name: "Knowledge__kav", label: "Knowledge", custom: true, fields: [id(), f("Title"), f("UrlName"), f("Summary", "textarea"), f("Body__c", "html"), f("PublishStatus"), f("Language"), f("LastPublishedDate", "datetime")] },
];

export function toFieldDescribe(spec: FieldSpec, objectCreateable: boolean, objectUpdateable: boolean): FieldDescribe {
  const system = ["Id", "CreatedDate", "LastModifiedDate", "Name", "CaseNumber", "IsClosed", "ClosedDate", "QuoteNumber", "OrderNumber"].includes(spec.name);
  return {
    name: spec.name,
    label: spec.label,
    type: spec.type,
    createable: spec.createable ?? (objectCreateable && !system && spec.type !== "id"),
    updateable: spec.updateable ?? (objectUpdateable && !system && spec.type !== "id"),
    nillable: spec.name !== "Id",
    referenceTo: spec.referenceTo,
    picklistValues: spec.picklist?.map((v) => ({ value: v, label: v, active: true })),
  };
}
