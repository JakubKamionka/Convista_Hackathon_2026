#!/usr/bin/env node
import {
  McpServer,
  fromJsonSchema,
  type CallToolResult,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import path from "path";
import dotenv from "dotenv";

// Import handler functions
import { handleGetProgram } from "./handlers/handleGetProgram";
import { handleGetClass } from "./handlers/handleGetClass";
import { handleGetFunctionGroup } from "./handlers/handleGetFunctionGroup";
import { handleGetFunction } from "./handlers/handleGetFunction";
import { handleGetTable } from "./handlers/handleGetTable";
import { handleGetStructure } from "./handlers/handleGetStructure";
import { handleGetTableContents } from "./handlers/handleGetTableContents";
import { handleGetPackage } from "./handlers/handleGetPackage";
import { handleGetInclude } from "./handlers/handleGetInclude";
import { handleGetTypeInfo } from "./handlers/handleGetTypeInfo";
import { handleGetInterface } from "./handlers/handleGetInterface";
import { handleGetTransaction } from "./handlers/handleGetTransaction";
import { handleSearchObject } from "./handlers/handleSearchObject";
import { handleGetCDSView } from "./handlers/handleGetCDSView";
import { handleGetBehaviorDefinition } from "./handlers/handleGetBehaviorDefinition";
import { handleGetServiceDefinition } from "./handlers/handleGetServiceDefinition";
import {
  handleCreateBusinessPartner,
  writesEnabled,
} from "./handlers/handleCreateBusinessPartner";
import {
  handleCreateObject,
  CREATE_OBJECT_TYPES,
} from "./handlers/handleCreateObject";
import {
  handleInsertTableRows,
  MAX_INSERT_ROWS,
} from "./handlers/handleInsertTableRows";

// Import shared utility functions and types
import { MAX_PAGE_LINES, cleanup } from "./lib/utils";
import { withRequestSignal } from "./lib/network";

export { getConfig } from "./config";
export type { SapConfig } from "./config";

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, "../.env") });

// Shared schema fragments for every tool whose textual result is protected by
// the response byte cap. Runtime validation in lib/utils.ts matches these bounds.
export const PAGING_START_LINE = {
  type: "integer",
  minimum: 1,
  description:
    "1-based line number to start from (default 1). Beyond EOF returns an empty page with hasMore=false.",
};
export const PAGING_MAX_LINES = {
  type: "integer",
  minimum: 1,
  maximum: MAX_PAGE_LINES,
  description: `Maximum lines to return (1-${MAX_PAGE_LINES}). Omit to request the rest; the byte cap may return fewer lines.`,
};

export const PAGED_TEXT_TOOL_NAMES = [
  "GetProgram",
  "GetClass",
  "GetFunctionGroup",
  "GetFunction",
  "GetStructure",
  "GetTable",
  "GetTableContents",
  "GetPackage",
  "GetTypeInfo",
  "GetInclude",
  "SearchObject",
  "GetTransaction",
  "GetCDSView",
  "GetInterface",
  "GetBehaviorDefinition",
  "GetServiceDefinition",
] as const;

const PAGED_TEXT_TOOL_SET = new Set<string>(PAGED_TEXT_TOOL_NAMES);

export function addPagingSchemas(tools: any[]) {
  return tools.map((tool) => {
    if (!PAGED_TEXT_TOOL_SET.has(tool.name)) {
      return tool;
    }
    return {
      ...tool,
      inputSchema: {
        ...tool.inputSchema,
        properties: {
          ...tool.inputSchema.properties,
          startLine: PAGING_START_LINE,
          maxLines: PAGING_MAX_LINES,
        },
      },
    };
  });
}

const TOOL_DEFINITIONS = [
  // Define available tools
  {
    name: "GetProgram",
    description:
      "Retrieve ABAP program source code. For large programs, use startLine/maxLines to page through the source instead of retrieving it all at once.",
    inputSchema: {
      type: "object",
      properties: {
        program_name: {
          type: "string",
          description: "Name of the ABAP program",
        },
        startLine: PAGING_START_LINE,
        maxLines: PAGING_MAX_LINES,
      },
      required: ["program_name"],
    },
  },
  {
    name: "GetClass",
    description:
      "Retrieve ABAP class source code. For large classes, use startLine/maxLines to page through the source instead of retrieving it all at once.",
    inputSchema: {
      type: "object",
      properties: {
        class_name: {
          type: "string",
          description: "Name of the ABAP class",
        },
        startLine: PAGING_START_LINE,
        maxLines: PAGING_MAX_LINES,
      },
      required: ["class_name"],
    },
  },
  {
    name: "GetFunctionGroup",
    description:
      "Retrieve ABAP Function Group source code. For large function groups, use startLine/maxLines to page through the source instead of retrieving it all at once.",
    inputSchema: {
      type: "object",
      properties: {
        function_group: {
          type: "string",
          description: "Name of the function module",
        },
        startLine: PAGING_START_LINE,
        maxLines: PAGING_MAX_LINES,
      },
      required: ["function_group"],
    },
  },
  {
    name: "GetFunction",
    description:
      "Retrieve ABAP Function Module source code. For large function modules, use startLine/maxLines to page through the source instead of retrieving it all at once.",
    inputSchema: {
      type: "object",
      properties: {
        function_name: {
          type: "string",
          description: "Name of the function module",
        },
        function_group: {
          type: "string",
          description: "Name of the function group",
        },
        startLine: PAGING_START_LINE,
        maxLines: PAGING_MAX_LINES,
      },
      required: ["function_name", "function_group"],
    },
  },
  {
    name: "GetStructure",
    description:
      "Retrieve ABAP Structure. For large structures, use startLine/maxLines to page through the result instead of retrieving it all at once.",
    inputSchema: {
      type: "object",
      properties: {
        structure_name: {
          type: "string",
          description: "Name of the ABAP Structure",
        },
        startLine: PAGING_START_LINE,
        maxLines: PAGING_MAX_LINES,
      },
      required: ["structure_name"],
    },
  },
  {
    name: "GetTable",
    description:
      "Retrieve ABAP table structure. For large tables, use startLine/maxLines to page through the result instead of retrieving it all at once.",
    inputSchema: {
      type: "object",
      properties: {
        table_name: {
          type: "string",
          description: "Name of the ABAP table",
        },
        startLine: PAGING_START_LINE,
        maxLines: PAGING_MAX_LINES,
      },
      required: ["table_name"],
    },
  },
  {
    name: "GetTableContents",
    description:
      "Retrieve contents of an ABAP table. max_rows limits SAP rows; startLine/maxLines page the returned textual XML when its serialized size is still large.",
    inputSchema: {
      type: "object",
      properties: {
        table_name: {
          type: "string",
          description: "Name of the ABAP table",
        },
        max_rows: {
          type: "number",
          description: "Maximum number of rows to retrieve",
          default: 100,
        },
      },
      required: ["table_name"],
    },
  },
  {
    name: "GetPackage",
    description:
      "Retrieve ABAP package details. Use startLine/maxLines to page large serialized package listings.",
    inputSchema: {
      type: "object",
      properties: {
        package_name: {
          type: "string",
          description: "Name of the ABAP package",
        },
      },
      required: ["package_name"],
    },
  },
  {
    name: "GetTypeInfo",
    description:
      "Retrieve ABAP type information. For large results, use startLine/maxLines to page through it instead of retrieving it all at once.",
    inputSchema: {
      type: "object",
      properties: {
        type_name: {
          type: "string",
          description: "Name of the ABAP type",
        },
        startLine: PAGING_START_LINE,
        maxLines: PAGING_MAX_LINES,
      },
      required: ["type_name"],
    },
  },
  {
    name: "GetInclude",
    description:
      "Retrieve ABAP Include Source Code. For large includes, use startLine/maxLines to page through the source instead of retrieving it all at once.",
    inputSchema: {
      type: "object",
      properties: {
        include_name: {
          type: "string",
          description: "Name of the ABAP Include",
        },
        startLine: PAGING_START_LINE,
        maxLines: PAGING_MAX_LINES,
      },
      required: ["include_name"],
    },
  },
  {
    name: "SearchObject",
    description:
      "Search for ABAP objects using quick search. maxResults limits matches; startLine/maxLines page the returned textual XML when its serialized size is still large.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query string (use * wildcard for partial match)",
        },
        maxResults: {
          type: "number",
          description: "Maximum number of results to return",
          default: 100,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "GetTransaction",
    description:
      "Retrieve ABAP transaction details. For large results, use startLine/maxLines to page through it instead of retrieving it all at once.",
    inputSchema: {
      type: "object",
      properties: {
        transaction_name: {
          type: "string",
          description: "Name of the ABAP transaction",
        },
        startLine: PAGING_START_LINE,
        maxLines: PAGING_MAX_LINES,
      },
      required: ["transaction_name"],
    },
  },
  {
    name: "GetCDSView",
    description:
      "Retrieve CDS view (DDL source) source code. For large views, use startLine/maxLines to page through the source instead of retrieving it all at once.",
    inputSchema: {
      type: "object",
      properties: {
        cds_view_name: {
          type: "string",
          description:
            "Name of the CDS view (DDL source name, e.g. I_CURRENCY)",
        },
        startLine: PAGING_START_LINE,
        maxLines: PAGING_MAX_LINES,
      },
      required: ["cds_view_name"],
    },
  },
  {
    name: "GetInterface",
    description:
      "Retrieve ABAP interface source code. For large interfaces, use startLine/maxLines to page through the source instead of retrieving it all at once.",
    inputSchema: {
      type: "object",
      properties: {
        interface_name: {
          type: "string",
          description: "Name of the ABAP interface",
        },
        startLine: PAGING_START_LINE,
        maxLines: PAGING_MAX_LINES,
      },
      required: ["interface_name"],
    },
  },
  {
    name: "GetBehaviorDefinition",
    description:
      "Retrieve RAP Behavior Definition (BDEF) source code (requires ~NW 7.54 / S/4HANA). For large definitions, use startLine/maxLines to page through the source instead of retrieving it all at once.",
    inputSchema: {
      type: "object",
      properties: {
        behavior_definition_name: {
          type: "string",
          description: "Name of the RAP Behavior Definition (e.g. I_MY_ENTITY)",
        },
        startLine: PAGING_START_LINE,
        maxLines: PAGING_MAX_LINES,
      },
      required: ["behavior_definition_name"],
    },
  },
  {
    name: "GetServiceDefinition",
    description:
      "Retrieve RAP Service Definition (SRVD) source code (requires ~NW 7.54 / S/4HANA). For large definitions, use startLine/maxLines to page through the source instead of retrieving it all at once.",
    inputSchema: {
      type: "object",
      properties: {
        service_definition_name: {
          type: "string",
          description: "Name of the RAP Service Definition (e.g. Z_MY_SERVICE)",
        },
        startLine: PAGING_START_LINE,
        maxLines: PAGING_MAX_LINES,
      },
      required: ["service_definition_name"],
    },
  },
];

// Write tools are registered only when SAP_ALLOW_WRITES=1, so the default
// server stays read-only.
const WRITE_TOOL_DEFINITIONS = [
  {
    name: "CreateBusinessPartner",
    write: true,
    description:
      "Create a new business partner (person or organization) in SAP through the API_BUSINESS_PARTNER OData service. Requires SAP_ALLOW_WRITES=1 and an activated service. Returns the created entity, including the assigned BusinessPartner number.",
    inputSchema: {
      type: "object",
      properties: {
        business_partner_category: {
          type: "string",
          enum: ["1", "2"],
          description: '"1" = person, "2" = organization',
        },
        business_partner_grouping: {
          type: "string",
          description:
            "Business partner grouping (system-specific, see table TB001; e.g. 0001), determines number range and required fields",
        },
        first_name: {
          type: "string",
          description: "First name (persons only, optional)",
        },
        last_name: {
          type: "string",
          description: "Last name (required for persons)",
        },
        organization_name: {
          type: "string",
          description: "Organization name (required for organizations)",
        },
      },
      required: ["business_partner_category", "business_partner_grouping"],
    },
  },
  {
    name: "CreateObject",
    write: true,
    description:
      "Create a new ABAP repository object in the local package $TMP (no transport) through ADT: create, optionally write the given source, then activate. Requires SAP_ALLOW_WRITES=1. Never overwrites: fails if the name already exists. Returns created/sourceWritten/activated plus activation messages; if a later step fails, the object still exists and the result says so.",
    inputSchema: {
      type: "object",
      properties: {
        object_type: {
          type: "string",
          enum: CREATE_OBJECT_TYPES,
          description:
            "Kind of object. function_group and package take no source; package creates a local sub-package of $TMP. table (max. 16 chars) and structure use DDIC source syntax (define table / define structure).",
        },
        name: {
          type: "string",
          description:
            "Object name in customer namespace (Z* or Y*); for package a local name starting with $ (e.g. $ZDEMO). For behavior_definition use the root CDS entity name.",
        },
        description: {
          type: "string",
          description: "Short description (max. 60 characters)",
        },
        source: {
          type: "string",
          description:
            "Full source code to write before activation (must declare the same name). Omit to keep SAP's generated skeleton.",
          maxLength: 500_000,
        },
        function_group: {
          type: "string",
          description:
            "Existing function group in a local $ package (required for function_module)",
        },
      },
      required: ["object_type", "name", "description"],
    },
  },
  {
    name: "InsertTableRows",
    write: true,
    description:
      "Insert rows into a Z/Y transparent table in a local $ package. Generates a temporary $TMP class, runs it through ADT classrun (one INSERT ... ACCEPTING DUPLICATE KEYS plus COMMIT) and deletes it again. Insert only: rows whose key already exists are skipped, never updated. The client field is filled automatically; values follow ABAP conversion rules (e.g. dates as YYYYMMDD). Requires SAP_ALLOW_WRITES=1. Returns inserted and skippedDuplicates.",
    inputSchema: {
      type: "object",
      properties: {
        table_name: {
          type: "string",
          description:
            "Table name in customer namespace (Z* or Y*, max. 16 characters)",
        },
        rows: {
          type: "array",
          minItems: 1,
          maxItems: MAX_INSERT_ROWS,
          description:
            'Rows as objects of field name to value (string, number or null), e.g. [{"book_id": "000001", "title": "Clean Code"}]. All key fields except the client are required.',
          items: { type: "object" },
        },
      },
      required: ["table_name", "rows"],
    },
  },
];

const HANDLERS: Record<string, (args: any) => Promise<any>> = {
  CreateBusinessPartner: handleCreateBusinessPartner,
  CreateObject: handleCreateObject,
  InsertTableRows: handleInsertTableRows,
  GetProgram: handleGetProgram,
  GetClass: handleGetClass,
  GetFunction: handleGetFunction,
  GetFunctionGroup: handleGetFunctionGroup,
  GetStructure: handleGetStructure,
  GetTable: handleGetTable,
  GetTableContents: handleGetTableContents,
  GetPackage: handleGetPackage,
  GetTypeInfo: handleGetTypeInfo,
  GetInclude: handleGetInclude,
  SearchObject: handleSearchObject,
  GetInterface: handleGetInterface,
  GetTransaction: handleGetTransaction,
  GetCDSView: handleGetCDSView,
  GetBehaviorDefinition: handleGetBehaviorDefinition,
  GetServiceDefinition: handleGetServiceDefinition,
};

export function createServer(): McpServer {
  const server = new McpServer({
    name: "mcp-abap-adt",
    version: require("../package.json").version,
  });
  const tools = [
    ...addPagingSchemas(TOOL_DEFINITIONS),
    ...(writesEnabled() ? WRITE_TOOL_DEFINITIONS : []),
  ];
  for (const tool of tools) {
    const properties = tool.inputSchema.properties;
    for (const value of Object.values(properties) as any[]) {
      if (value.type === "string") {
        value.minLength = 1;
        value.maxLength ??= 1024;
      }
    }
    for (const name of ["max_rows", "maxResults"]) {
      if (properties[name])
        Object.assign(properties[name], {
          type: "integer",
          minimum: 1,
          maximum: 10000,
        });
    }
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: fromJsonSchema<Record<string, unknown>>({
          ...tool.inputSchema,
          additionalProperties: false,
        }),
        annotations: {
          readOnlyHint: !("write" in tool),
          destructiveHint: false,
          idempotentHint: !("write" in tool),
          openWorldHint: true,
        },
      },
      async (args, ctx) =>
        withRequestSignal(
          ctx.mcpReq.signal,
          async () => (await HANDLERS[tool.name](args)) as CallToolResult,
        ),
    );
  }
  return server;
}

export class mcp_abap_adt_server {
  async run() {
    const handle = serveStdio(() => createServer());
    const stop = async () => {
      await handle.close();
      cleanup();
    };
    process.once("SIGINT", () => {
      void stop();
    });
    process.once("SIGTERM", () => {
      void stop();
    });
    process.stdin.once("end", cleanup);
  }
}

if (require.main === module) {
  new mcp_abap_adt_server().run().catch(() => {
    console.error("Unable to start mcp-abap-adt");
    process.exitCode = 1;
  });
}
