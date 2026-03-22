import type { MemoryEngine } from '@ledgermind/application';
import { createCanonicalMemoryToolCatalog } from '@ledgermind/adapters';
import { createInMemoryMemoryEngine, createPostgresMemoryEngine } from '@ledgermind/sdk';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Implementation } from '@modelcontextprotocol/sdk/types.js';

import type { McpServerConfig } from './config';
import {
  authorizeMcpToolInvocation,
  canExposeMcpTool,
  toAuthorizationErrorResult,
} from './authorization';
import { createFileSessionBindingStore } from './file-session-binding-store';
import {
  applySessionBindingToToolArguments,
  readSessionBindingMetadata,
  resolveSessionBinding,
} from './session-binding';
import {
  createInMemorySessionBindingStore,
  type SessionBindingStore,
} from './session-binding-store';
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
  readonly sessionBindingStore: SessionBindingStore;
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
  const sessionBindingStore =
    config.bindingStorePath === undefined
      ? createInMemorySessionBindingStore()
      : createFileSessionBindingStore(config.bindingStorePath);
  const catalog = createCanonicalMemoryToolCatalog(engine);
  const catalogByName = new Map(catalog.map((definition) => [definition.name, definition]));
  const visibleCatalog = catalog.filter((definition) => canExposeMcpTool(definition, config));
  const registry = createMcpToolRegistry(visibleCatalog);
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
    const definition = catalogByName.get(request.params.name);
    if (definition === undefined) {
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

    const registration = registry.find((entry) => entry.tool.name === request.params.name);

    const metadata = readSessionBindingMetadata(request.params._meta);
    const resolvedArguments =
      metadata === undefined
        ? request.params.arguments
        : applySessionBindingToToolArguments(
            request.params.name,
            request.params.arguments,
            await resolveSessionBinding(sessionBindingStore, {
              runtime: metadata.runtime ?? config.defaultRuntime ?? 'mcp',
              runtimeSessionId: metadata.runtimeSessionId,
              userScope: metadata.userScope ?? config.defaultUserScope ?? 'local-user',
              workspaceScope: metadata.workspaceScope ?? config.defaultWorkspaceScope ?? 'local-workspace',
              ...(metadata.branchScope ?? config.defaultBranchScope) === undefined
                ? {}
                : { branchScope: metadata.branchScope ?? config.defaultBranchScope },
              ...(metadata.parentRuntimeSessionId === undefined
                ? {}
                : { parentRuntimeSessionId: metadata.parentRuntimeSessionId }),
            }),
            metadata,
          );

    const authorization = authorizeMcpToolInvocation({
      tool: definition,
      config,
      argumentsInput: resolvedArguments,
      metadata,
    });

    if (!authorization.allowed || registration === undefined) {
      return toAuthorizationErrorResult(
        request.params.name,
        authorization.reason ?? `${request.params.name} is not available in the current MCP server configuration.`,
      );
    }

    return registration.execute(resolvedArguments);
  });

  return {
    config,
    engine,
    registry,
    sessionBindingStore,
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
