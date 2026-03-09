import type { MessageRole } from '@ledgermind/domain';

export interface CoreUseCasesFixtureConversation {
  readonly modelName: string;
  readonly contextWindow: number;
  readonly thresholds: {
    readonly soft: number;
    readonly hard: number;
  };
}

export interface CoreUseCasesFixtureEvent {
  readonly role: MessageRole;
  readonly content: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface CoreUseCasesFixtureMaterializeAction {
  readonly type: 'materialize';
  readonly budgetTokens: number;
  readonly overheadTokens: number;
}

export interface CoreUseCasesFixtureRunCompactionAction {
  readonly type: 'runCompaction';
  readonly trigger: 'soft' | 'hard';
  readonly targetTokens?: number;
}

export interface CoreUseCasesFixtureCheckIntegrityAction {
  readonly type: 'checkIntegrity';
}

export type CoreUseCasesFixtureAction =
  | CoreUseCasesFixtureMaterializeAction
  | CoreUseCasesFixtureRunCompactionAction
  | CoreUseCasesFixtureCheckIntegrityAction;

export interface CoreUseCasesFixtureExpected {
  readonly dagNodeCount: number;
  readonly dagNodeKinds: readonly ('leaf' | 'condensed')[];
  readonly contextItemCount: number;
  readonly budgetUsedLessThan: number;
  readonly integrityPassed: boolean;
  readonly summaryIdPrefix: string;
  readonly expandRecoveryCount: number;
}

export interface CoreUseCasesFixture {
  readonly name: string;
  readonly conversation: CoreUseCasesFixtureConversation;
  readonly events: readonly CoreUseCasesFixtureEvent[];
  readonly actions: readonly CoreUseCasesFixtureAction[];
  readonly expected: CoreUseCasesFixtureExpected;
}
