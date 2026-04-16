import type { ArtifactId } from '@ledgermind/domain';

import type { DelegatedScopeInput } from '../../driving/operator-execution.port';
import type { NewLedgerEvent } from '../../driving/memory-engine.port';

export interface DelegationScopeArtifactPayload {
  readonly artifactId: ArtifactId;
  readonly content: string | Uint8Array;
  readonly mimeType: string;
}

export interface DelegationScopeResolution {
  readonly bootstrapEvents: readonly NewLedgerEvent[];
  readonly childArtifacts: readonly DelegationScopeArtifactPayload[];
  readonly sourceReferenceIds: readonly string[];
}

export interface DelegationScopeResolverPort {
  resolve(scope: DelegatedScopeInput): Promise<DelegationScopeResolution>;
}
