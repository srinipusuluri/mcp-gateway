import { ToolRegistry } from "@sfcm/tool-registry";
import { salesTools } from "./tools/sales";
import { serviceTools } from "./tools/service";
import { cpqTools } from "./tools/cpq";
import { metadataTools } from "./tools/metadata";
import { agentforceTools, dataCloudTools, externalTools } from "./tools/integrations";

export * from "./adapters/types";
export { createMockAdapters, MockDataCloud, MockAgentforce, MockNetSuite } from "./adapters/mock";
export * from "./helpers";
export { salesTools, serviceTools, cpqTools, metadataTools, dataCloudTools, agentforceTools, externalTools };

/** Build the full registry. Extend by passing extra modules (see docs/tool-registry.md). */
export function createSalesforceRegistry(extra: Parameters<ToolRegistry["register"]> = [] as never): ToolRegistry {
  return new ToolRegistry().register(...salesTools, ...serviceTools, ...cpqTools, ...dataCloudTools, ...metadataTools, ...agentforceTools, ...externalTools, ...extra);
}
export * from "./direct-server";
export * from "./workflows";
