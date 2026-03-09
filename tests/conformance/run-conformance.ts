import { describe } from 'vitest';

import type {
  ArtifactStorePort,
  ContextProjectionPort,
  ConversationPort,
  LedgerAppendPort,
  LedgerReadPort,
  SummaryDagPort,
  UnitOfWorkPort,
} from '@ledgermind/application';
import type { ConversationId, EventId, SummaryNodeId } from '@ledgermind/domain';

import {
  registerArtifactStoreConformance,
  registerContextProjectionConformance,
  registerConversationConformance,
  registerLedgerAppendConformance,
  registerLedgerReadConformance,
  registerSummaryDagConformance,
  registerUnitOfWorkConformance,
} from './persistence';

export interface AdapterCapabilities {
  readonly fullTextSearch: boolean;
  readonly regexSearch: boolean;
  readonly recursiveCTE: boolean;
  readonly concurrentWrites: boolean;
}

export interface ConformanceCorruptionTools {
  readonly canInjectOrphanSummaryMessageEdge: boolean;
  injectOrphanSummaryMessageEdge(input: {
    readonly summaryId: SummaryNodeId;
    readonly missingMessageId: EventId;
  }): Promise<void>;
}

export interface ConformanceRuntime {
  readonly defaultConversationId: ConversationId;
  readonly unitOfWork: UnitOfWorkPort;
  readonly ledger: LedgerAppendPort & LedgerReadPort;
  readonly context: ContextProjectionPort;
  readonly dag: SummaryDagPort;
  readonly artifacts: ArtifactStorePort;
  readonly conversations: ConversationPort;
  readonly corruption: ConformanceCorruptionTools;
  destroy(): Promise<void>;
}

export interface ConformanceAdapterDefinition {
  readonly adapterName: string;
  readonly capabilities: AdapterCapabilities;
  createRuntime(): Promise<ConformanceRuntime>;
}

export const runConformance = (adapter: ConformanceAdapterDefinition): void => {
  describe(`contract & conformance (${adapter.adapterName})`, () => {
    registerLedgerAppendConformance(adapter);
    registerLedgerReadConformance(adapter);
    registerContextProjectionConformance(adapter);
    registerSummaryDagConformance(adapter);
    registerArtifactStoreConformance(adapter);
    registerConversationConformance(adapter);
    registerUnitOfWorkConformance(adapter);
  });
};
