import type { MemoryEngine } from '@ledgermind/application';
import { createCanonicalMemoryToolCatalog } from '@ledgermind/adapters';
import { createInMemoryMemoryEngine, createPostgresMemoryEngine } from '@ledgermind/sdk';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Implementation } from '@modelcontextprotocol/sdk/types.js';

import type { McpServerConfig } from './config';
import { createMcpToolRegistry, type McpToolRegistration } from './tool-registry';

const SERVER_INFO: Implementation = {
  name: 'ledgermind-mcp-server',
  version: '0.0.0',
};

export interface CreateLedgermindMcpServerOptions {
  readonly config: McpServerConfig;
  readonly engine?: MemoryEngine;
}

export interface LedgermindMcpServerRuntime {
  readonly config: McpServerConfig;
  readonly engine: MemoryEngine;
  readonly registry: readonly McpToolRegistration[];
  readonly server: Server;
}

const createEngineFromConfig = (config: McpServerConfig): MemoryEngine =>
  config.storage.type === 'postgres'
    ? createPostgresMemoryEngine({
        connectionString: config.storage.connectionString,
      })
    : createInMemoryMemoryEngine();

export const createLedgermindMcpServer = ({
  config,
  engine = createEngineFromConfig(config),
}: CreateLedgermindMcpServerOptions): LedgermindMcpServerRuntime => {
  const catalog = createCanonicalMemoryToolCatalog(engine);
  const registry = createMcpToolRegistry(catalog);
  const server = new Server(SERVER_INFO, {
    capabilities: {
      tools: {
        listChanged: false,
      },
    },
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: registry.map((entry) => entry.tool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const registration = registry.find((entry) => entry.tool.name === request.params.name);
    if (registration === undefined) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Unknown LedgerMind MCP tool: ${request.params.name}`,
          },
        ],
        isError: true,
      };
    }

    return registration.execute(request.params.arguments);
  });

  return {
    config,
    engine,
    registry,
    server,
  };
};

export const startLedgermindMcpServer = async (
  options: CreateLedgermindMcpServerOptions,
): Promise<LedgermindMcpServerRuntime> => {
  const runtime = createLedgermindMcpServer(options);
  await runtime.server.connect(new StdioServerTransport());
  return runtime;
};
