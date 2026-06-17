/**
 * MCP server integration for CodeMode.
 *
 * This module provides helpers for integrating CodeMode with
 * `@modelcontextprotocol/sdk`. Import from `codemode/mcp`.
 *
 * @example
 * ```ts
 * import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
 * import { CodeMode } from 'codemode';
 * import { registerTools } from 'codemode/mcp';
 *
 * const codemode = new CodeMode({ spec, request: app.request.bind(app) });
 * const server = new McpServer({ name: 'my-api', version: '1.0.0' });
 *
 * registerTools(codemode, server);
 * ```
 */

import type { CodeMode } from "./codemode.js";
import { DEFAULT_MAX_CODE_BYTES } from "./limits.js";
import { z } from "zod";

/**
 * Register CodeMode's search and execute tools on an MCP server.
 *
 * Uses the `McpServer.registerTool()` API from `@modelcontextprotocol/sdk`.
 */
export function registerTools(
  codemode: CodeMode,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server: { registerTool: (...args: any[]) => any },
): void {
  const toolDefs = codemode.tools();

  for (const def of toolDefs) {
    server.registerTool(
      def.name,
      {
        description: def.description,
        inputSchema: {
          code: z.string().max(DEFAULT_MAX_CODE_BYTES).describe("JavaScript code to execute"),
        },
      },
      async (args: { code: string }) => {
        return codemode.callTool(def.name, { code: args.code });
      },
    );
  }
}
