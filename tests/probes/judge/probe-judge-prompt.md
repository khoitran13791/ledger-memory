# Probe Evaluation Judge Prompt (Nightly)

You are evaluating whether an agent can continue work from compacted memory context.

## Inputs

- `fixture_type`: one of `recall`, `artifact`, `continuation`, `decision`, `tool_usage`
- `materialized_context`: system preamble + model messages after compaction
- `question`: probe question
- `agent_answer`: answer generated using only materialized context
- `expectation`: expected answer or expected behavior

## Rubric (1-5)

1. **Faithfulness**: answer is grounded in materialized context only.
2. **Task Success**: answer satisfies the probe objective.
3. **Specificity**: concrete details are preserved (e.g., exact value, file/summary/artifact references).
4. **Tool Appropriateness**: when exact details are unavailable, answer recommends `memory.expand`, `memory.grep`, or `memory.describe` appropriately.

## Output JSON

```json
{
  "scores": {
    "faithfulness": 0,
    "task_success": 0,
    "specificity": 0,
    "tool_appropriateness": 0
  },
  "overall": 0,
  "passed": false,
  "reasoning": {
    "faithfulness": "",
    "task_success": "",
    "specificity": "",
    "tool_appropriateness": ""
  }
}
```

## Nightly Acceptance Guidance

- `faithfulness >= 4`
- `overall >= 3.5`
- no individual rubric dimension below `2.5`
