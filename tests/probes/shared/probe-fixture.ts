import type { MessageRole } from '@ledgermind/domain';
import type {
  ContinuityImportance,
  ContinuityRecordKind,
  ContinuityRecordStatus,
  ContinuityProvenance,
  CreateHandoffInput,
} from '@ledgermind/application';

export type ProbeType =
  | 'recall'
  | 'artifact'
  | 'continuation'
  | 'decision'
  | 'tool_usage'
  | 'handoff'
  | 'staleness'
  | 'verification';

export type ProbeGradingCriteria =
  | 'exact_value'
  | 'correct_next_step'
  | 'constraint_adherence'
  | 'appropriate_tool_suggestion'
  | 'handoff_recovery'
  | 'stale_record_suppression'
  | 'blocking_evidence';

export interface ProbeEventFixture {
  readonly role: MessageRole;
  readonly content: string;
}

export interface ProbeArtifactFixture {
  readonly path: string;
  readonly content: string;
  readonly mimeType?: string;
}

export interface ProbeContinuityRecordFixture {
  readonly kind: ContinuityRecordKind;
  readonly title: string;
  readonly content: string;
  readonly importance?: ContinuityImportance;
  readonly status?: ContinuityRecordStatus;
  readonly provenance?: ContinuityProvenance;
  readonly relatedRecordIds?: readonly string[];
  readonly supersedesRecordIds?: readonly string[];
  readonly supersededByRecordId?: string;
  readonly idempotencyKey?: string;
}

export type ProbeHandoffFixture = Omit<CreateHandoffInput, 'conversationId'>;

export interface ProbeStructuredSetup {
  readonly events: readonly ProbeEventFixture[];
  readonly artifacts?: readonly ProbeArtifactFixture[];
  readonly continuityRecords?: readonly ProbeContinuityRecordFixture[];
}

export interface ProbeTwoSessionSetup {
  readonly sessionA: ProbeStructuredSetup & {
    readonly stopHandoff?: ProbeHandoffFixture;
  };
  readonly sessionB: {
    readonly question: string;
  };
}

export type ProbeSetup = ProbeStructuredSetup | ProbeTwoSessionSetup | readonly ProbeEventFixture[];

export interface ProbeBaseFixture {
  readonly name: string;
  readonly type: ProbeType;
  readonly setup: ProbeSetup;
  readonly question: string;
  readonly contextWindow: number;
  readonly softThreshold: number;
  readonly hardThreshold: number;
  readonly budgetTokens: number;
  readonly overheadTokens: number;
  readonly runCompactionTargetTokens?: number;
}

export interface RecallProbeFixture extends ProbeBaseFixture {
  readonly type: 'recall';
  readonly expectedAnswer: string;
  readonly gradingCriteria: 'exact_value';
}

export interface ArtifactProbeFixture extends ProbeBaseFixture {
  readonly type: 'artifact';
  readonly expectedAnswer: string;
  readonly requiresArtifactReference: boolean;
}

export interface ContinuationProbeFixture extends ProbeBaseFixture {
  readonly type: 'continuation';
  readonly expectedAnswer: string;
  readonly gradingCriteria: 'correct_next_step';
}

export interface DecisionProbeFixture extends ProbeBaseFixture {
  readonly type: 'decision';
  readonly expectedAnswer: string;
  readonly gradingCriteria: 'constraint_adherence';
}

export interface ToolUsageProbeFixture extends ProbeBaseFixture {
  readonly type: 'tool_usage';
  readonly expectedBehavior: string;
  readonly gradingCriteria: 'appropriate_tool_suggestion';
}

export interface HandoffProbeFixture extends ProbeBaseFixture {
  readonly type: 'handoff';
  readonly expectedAnswer: string;
  readonly gradingCriteria: 'handoff_recovery';
}

export interface StalenessProbeFixture extends ProbeBaseFixture {
  readonly type: 'staleness';
  readonly expectedAnswer: string;
  readonly gradingCriteria: 'stale_record_suppression';
}

export interface VerificationProbeFixture extends ProbeBaseFixture {
  readonly type: 'verification';
  readonly expectedAnswer: string;
  readonly gradingCriteria: 'blocking_evidence';
}

export type ProbeFixture =
  | RecallProbeFixture
  | ArtifactProbeFixture
  | ContinuationProbeFixture
  | DecisionProbeFixture
  | ToolUsageProbeFixture
  | HandoffProbeFixture
  | StalenessProbeFixture
  | VerificationProbeFixture;

export interface ProbeExecutionResult {
  readonly fixtureName: string;
  readonly probeType: ProbeType;
  readonly question: string;
  readonly answer: string;
  readonly passed: boolean;
  readonly score: number;
  readonly maxScore: number;
  readonly reasons: readonly string[];
  readonly summaryIds: readonly string[];
  readonly artifactIds: readonly string[];
  readonly modelMessageCount: number;
  readonly materializedBudgetUsed: number;
}

const ensureWithinRange = (value: number, min: number, max: number, label: string): void => {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
};

const ensurePositiveInteger = (value: number, label: string): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
};

const isStructuredSetup = (setup: ProbeSetup): setup is ProbeStructuredSetup => {
  return !Array.isArray(setup) && typeof setup === 'object' && setup !== null && 'events' in setup;
};

export const isTwoSessionSetup = (setup: ProbeSetup): setup is ProbeTwoSessionSetup => {
  return (
    !Array.isArray(setup) && typeof setup === 'object' && setup !== null && 'sessionA' in setup
  );
};

const normalizeSetup = (
  setup: ProbeSetup,
): {
  readonly events: readonly ProbeEventFixture[];
  readonly artifacts: readonly ProbeArtifactFixture[];
  readonly continuityRecords: readonly ProbeContinuityRecordFixture[];
} => {
  if (isTwoSessionSetup(setup)) {
    return {
      events: setup.sessionA.events,
      artifacts: setup.sessionA.artifacts ?? [],
      continuityRecords: setup.sessionA.continuityRecords ?? [],
    };
  }

  if (!isStructuredSetup(setup)) {
    return {
      events: setup,
      artifacts: [],
      continuityRecords: [],
    };
  }

  return {
    events: setup.events,
    artifacts: setup.artifacts ?? [],
    continuityRecords: setup.continuityRecords ?? [],
  };
};

export const getProbeEvents = (fixture: ProbeFixture): readonly ProbeEventFixture[] => {
  return normalizeSetup(fixture.setup).events;
};

export const getProbeArtifacts = (fixture: ProbeFixture): readonly ProbeArtifactFixture[] => {
  return normalizeSetup(fixture.setup).artifacts;
};

export const getProbeContinuityRecords = (
  fixture: ProbeFixture,
): readonly ProbeContinuityRecordFixture[] => {
  return normalizeSetup(fixture.setup).continuityRecords;
};

export const getProbeQuestion = (fixture: ProbeFixture): string => {
  return isTwoSessionSetup(fixture.setup) ? fixture.setup.sessionB.question : fixture.question;
};

export const validateProbeFixture = (fixture: ProbeFixture): void => {
  if (fixture.name.trim().length === 0) {
    throw new Error('Probe fixture name must be non-empty.');
  }

  if (getProbeQuestion(fixture).trim().length === 0) {
    throw new Error(`Probe fixture (${fixture.name}) question must be non-empty.`);
  }

  ensurePositiveInteger(fixture.contextWindow, `Probe fixture (${fixture.name}) contextWindow`);
  ensureWithinRange(fixture.softThreshold, 0, 1, `Probe fixture (${fixture.name}) softThreshold`);
  ensureWithinRange(fixture.hardThreshold, 0, 1, `Probe fixture (${fixture.name}) hardThreshold`);

  if (fixture.softThreshold >= fixture.hardThreshold) {
    throw new Error(
      `Probe fixture (${fixture.name}) softThreshold must be lower than hardThreshold.`,
    );
  }

  ensurePositiveInteger(fixture.budgetTokens, `Probe fixture (${fixture.name}) budgetTokens`);

  if (!Number.isSafeInteger(fixture.overheadTokens) || fixture.overheadTokens < 0) {
    throw new Error(
      `Probe fixture (${fixture.name}) overheadTokens must be a non-negative safe integer.`,
    );
  }

  if (fixture.overheadTokens >= fixture.budgetTokens) {
    throw new Error(
      `Probe fixture (${fixture.name}) overheadTokens must be lower than budgetTokens.`,
    );
  }

  if (fixture.runCompactionTargetTokens !== undefined) {
    ensurePositiveInteger(
      fixture.runCompactionTargetTokens,
      `Probe fixture (${fixture.name}) runCompactionTargetTokens`,
    );
  }

  const events = getProbeEvents(fixture);
  if (events.length === 0) {
    throw new Error(`Probe fixture (${fixture.name}) must provide at least one setup event.`);
  }

  for (const event of events) {
    if (event.content.trim().length === 0) {
      throw new Error(`Probe fixture (${fixture.name}) event content must be non-empty.`);
    }
  }

  const artifacts = getProbeArtifacts(fixture);
  for (const artifact of artifacts) {
    if (artifact.path.trim().length === 0) {
      throw new Error(`Probe fixture (${fixture.name}) artifact path must be non-empty.`);
    }
    if (artifact.content.trim().length === 0) {
      throw new Error(`Probe fixture (${fixture.name}) artifact content must be non-empty.`);
    }
  }

  const continuityRecords = getProbeContinuityRecords(fixture);
  for (const record of continuityRecords) {
    if (record.title.trim().length === 0) {
      throw new Error(`Probe fixture (${fixture.name}) continuity record title must be non-empty.`);
    }
    if (record.content.trim().length === 0) {
      throw new Error(
        `Probe fixture (${fixture.name}) continuity record content must be non-empty.`,
      );
    }
  }

  if (isTwoSessionSetup(fixture.setup) && fixture.setup.sessionA.stopHandoff !== undefined) {
    if (fixture.setup.sessionA.stopHandoff.goal.trim().length === 0) {
      throw new Error(`Probe fixture (${fixture.name}) handoff goal must be non-empty.`);
    }
    if (fixture.setup.sessionA.stopHandoff.nextSteps.length === 0) {
      throw new Error(
        `Probe fixture (${fixture.name}) handoff must include at least one next step.`,
      );
    }
  }

  if ('expectedAnswer' in fixture && fixture.expectedAnswer.trim().length === 0) {
    throw new Error(`Probe fixture (${fixture.name}) expectedAnswer must be non-empty.`);
  }

  if ('expectedBehavior' in fixture && fixture.expectedBehavior.trim().length === 0) {
    throw new Error(`Probe fixture (${fixture.name}) expectedBehavior must be non-empty.`);
  }
};
