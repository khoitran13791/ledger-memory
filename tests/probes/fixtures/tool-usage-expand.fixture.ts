import type { ToolUsageProbeFixture } from '../shared/probe-fixture';

export const toolUsageExpandFixture: ToolUsageProbeFixture = {
  name: 'tool-usage-expand-required',
  type: 'tool_usage',
  setup: [
    { role: 'system', content: 'Use memory tools when exact details are missing from compact summaries.' },
    { role: 'user', content: 'JWT secret rotation runs every 24h with overlap validation and dual-key checks.' },
    { role: 'assistant', content: 'Captured. I summarized the rotation approach at high level only.' },
    { role: 'user', content: 'If asked for exact logic, guide the caller toward memory.expand().' },
  ],
  question: 'What was the exact JWT secret rotation logic?',
  expectedBehavior:
    'Should recognize that the summary is insufficient and suggest using memory.expand(sum_xxx) to retrieve full details',
  gradingCriteria: 'appropriate_tool_suggestion',
  contextWindow: 220,
  softThreshold: 0.6,
  hardThreshold: 0.9,
  budgetTokens: 160,
  overheadTokens: 20,
  runCompactionTargetTokens: 80,
};
