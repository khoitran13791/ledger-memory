import { describe, expect, it } from 'vitest';

import { goldenReplayFixtures } from '../fixtures';
import { runGoldenScenario, type GoldenAdapterName } from '../shared/run-golden-scenario';

const adapters: readonly GoldenAdapterName[] = ['in-memory', 'postgres'];

describe.each(adapters)('golden scenario replay (%s)', (adapter) => {
  it.each(goldenReplayFixtures)('is replay-stable for $name', async (fixture) => {
    const first = await runGoldenScenario({ fixture, adapter });
    const second = await runGoldenScenario({ fixture, adapter });

    expect(second).toEqual(first);

    const summaryNodes = first.signature.summaryNodes;
    expect(summaryNodes).toHaveLength(fixture.expected.dagNodeCount);
    expect(summaryNodes.map((summaryNode) => summaryNode.kind)).toEqual(fixture.expected.dagNodeKinds);
    expect(summaryNodes.every((summaryNode) => summaryNode.id.startsWith(fixture.expected.summaryIdPrefix))).toBe(true);

    const contextItems = first.signature.contextItems;
    expect(contextItems).toHaveLength(fixture.expected.contextItemCount);
    expect(contextItems[0]?.ref.startsWith('summary:sum_')).toBe(true);

    const materializeStep = first.steps.find((step) => step.type === 'materialize');
    expect(materializeStep).toBeDefined();

    if (materializeStep !== undefined && materializeStep.type === 'materialize') {
      expect(materializeStep.output.budgetUsed).toBeLessThanOrEqual(fixture.expected.budgetUsedLessThan);
    }

    const integrityStep = first.steps.find((step) => step.type === 'checkIntegrity');
    expect(integrityStep).toBeDefined();

    if (integrityStep !== undefined && integrityStep.type === 'checkIntegrity') {
      expect(integrityStep.output.passed).toBe(fixture.expected.integrityPassed);
      expect(integrityStep.output.checks.every((check) => check.passed)).toBe(true);
    }

    const runCompactionStep = first.steps.find((step) => step.type === 'runCompaction');
    expect(runCompactionStep).toBeDefined();

    if (runCompactionStep !== undefined && runCompactionStep.type === 'runCompaction') {
      expect(runCompactionStep.output.nodesCreated).toHaveLength(fixture.expected.dagNodeCount);
    }

    const expandedSummaryIds = Object.keys(first.signature.expandedMessageIdsBySummary);
    expect(expandedSummaryIds.length).toBeGreaterThan(0);

    const rootSummaryId = summaryNodes[summaryNodes.length - 1]?.id;
    if (rootSummaryId !== undefined) {
      const expandedMessageIds = first.signature.expandedMessageIdsBySummary[rootSummaryId];
      expect(expandedMessageIds).toBeDefined();
      expect(expandedMessageIds?.length).toBe(fixture.expected.expandRecoveryCount);

      const expectedExpandedPrefix = first.signature.eventIds.slice(0, fixture.expected.expandRecoveryCount);
      expect(expandedMessageIds).toEqual(expectedExpandedPrefix);
    }

    expect(first.signature.summaryMessageEdges.length + first.signature.summaryParentEdges.length).toBeGreaterThan(0);
    expect(first.signature.integrity.passed).toBe(fixture.expected.integrityPassed);
  });
});
