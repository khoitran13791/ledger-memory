import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadLongMemEvalDataset, normalizeLongMemEvalExample } from './dataset.js';

describe('normalizeLongMemEvalExample', () => {
  it('normalizes the official session-oriented dataset shape while preserving ids and metadata', () => {
    const normalized = normalizeLongMemEvalExample({
      question_id: 'q-001',
      question_type: 'multi-session',
      question: 'What instrument did I start practicing again after moving to Seattle?',
      answer: 'violin',
      question_date: '2024-03-10',
      haystack_session_ids: ['sess-100', 'sess-200'],
      haystack_dates: ['2024-02-01', '2024-03-01'],
      haystack_sessions: [
        [
          {
            role: 'user',
            content: 'After the move I picked violin back up and joined a small ensemble.',
            has_answer: true,
          },
          {
            role: 'assistant',
            content: 'That sounds like a great way to settle into Seattle.',
          },
        ],
        [
          {
            role: 'user',
            content: 'I am also looking for a new bike route to the office.',
          },
        ],
      ],
      answer_session_ids: ['sess-100'],
    });

    expect(normalized.exampleId).toBe('q-001');
    expect(normalized.question).toContain('instrument');
    expect(normalized.answer).toBe('violin');
    expect(normalized.goldEvidenceIds).toEqual(['sess-100']);
    expect(normalized.history).toHaveLength(2);
    expect(normalized.history[0]).toMatchObject({
      sessionId: 'sess-100',
      sessionDate: '2024-02-01',
      sourceIndex: 0,
    });
    expect(normalized.history[0]?.turns[0]).toMatchObject({
      turnId: 'sess-100#turn-0',
      role: 'user',
      content: 'After the move I picked violin back up and joined a small ensemble.',
      sourceIndex: 0,
      hasAnswer: true,
    });
    expect(normalized.metadata).toEqual({
      questionType: 'multi-session',
      questionDate: '2024-03-10',
      haystackSessionIds: ['sess-100', 'sess-200'],
      haystackDates: ['2024-02-01', '2024-03-01'],
    });
  });

  it('normalizes numeric answers from the official cleaned dataset into strings', () => {
    const normalized = normalizeLongMemEvalExample({
      question_id: 'q-001-numeric',
      question_type: 'multi-session',
      question: 'How many jackets do I need to return?',
      answer: 3,
      question_date: '2024-03-10',
      haystack_session_ids: ['sess-100'],
      haystack_dates: ['2024-02-01'],
      haystack_sessions: [
        [
          {
            role: 'user',
            content: 'I need to return three jackets after trying them on.',
            has_answer: true,
          },
        ],
      ],
      answer_session_ids: ['sess-100'],
    });

    expect(normalized.answer).toBe('3');
  });

  it('preserves empty turn content from the official cleaned dataset', () => {
    const normalized = normalizeLongMemEvalExample({
      question_id: 'q-001-empty-turn',
      question_type: 'multi-session',
      question: 'Did I need anything else after the trading chart answer?',
      answer: 'No',
      question_date: '2024-03-10',
      haystack_session_ids: ['sess-100'],
      haystack_dates: ['2024-02-01'],
      haystack_sessions: [
        [
          {
            role: 'assistant',
            content: 'Here is the full explanation.',
          },
          {
            role: 'user',
            content: '',
          },
          {
            role: 'assistant',
            content: 'Did you have a question or need further assistance?',
          },
        ],
      ],
      answer_session_ids: ['sess-100'],
    });

    expect(normalized.history[0]?.turns[1]?.content).toBe('');
  });

  it('rejects whitespace-only turn content while still allowing empty strings', () => {
    expect(() =>
      normalizeLongMemEvalExample({
        question_id: 'q-001-whitespace-turn',
        question_type: 'multi-session',
        question: 'Did I need anything else after the trading chart answer?',
        answer: 'No',
        question_date: '2024-03-10',
        haystack_session_ids: ['sess-100'],
        haystack_dates: ['2024-02-01'],
        haystack_sessions: [
          [
            {
              role: 'user',
              content: '   ',
            },
          ],
        ],
        answer_session_ids: ['sess-100'],
      }),
    ).toThrow('LongMemEval example q-001-whitespace-turn is missing required field haystack_sessions turn content at sess-100[0]');
  });

  it('loads jsonl files containing numeric answers and empty-string turns', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'longmemeval-dataset-'));
    const datasetPath = path.join(tempDir, 'dataset.jsonl');

    await writeFile(
      datasetPath,
      `${JSON.stringify({
        question_id: 'q-jsonl',
        question_type: 'multi-session',
        question: 'How many jackets do I need to return?',
        answer: 3,
        question_date: '2024-03-10',
        haystack_session_ids: ['sess-100'],
        haystack_dates: ['2024-02-01'],
        haystack_sessions: [[{ role: 'user', content: '' }]],
        answer_session_ids: ['sess-100'],
      })}\n`,
      'utf8',
    );

    try {
      const normalized = await loadLongMemEvalDataset(datasetPath);

      expect(normalized).toHaveLength(1);
      expect(normalized[0]?.answer).toBe('3');
      expect(normalized[0]?.history[0]?.turns[0]?.content).toBe('');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('fails clearly when required session arrays are misaligned', () => {
    expect(() =>
      normalizeLongMemEvalExample({
        question_id: 'q-002',
        question_type: 'single-session-user',
        question: 'What is my favorite tea?',
        answer: 'oolong',
        question_date: '2024-04-11',
        haystack_session_ids: ['sess-1'],
        haystack_dates: [],
        haystack_sessions: [[]],
      }),
    ).toThrow('LongMemEval example q-002 has mismatched haystack lengths');
  });
});
