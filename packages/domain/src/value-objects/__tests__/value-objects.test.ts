import { describe, expect, it } from 'vitest';

import {
  BudgetExceededError,
  InvariantViolationError,
  NonMonotonicSequenceError,
} from '../../errors/domain-errors';
import { createCompactionThresholds } from '../compaction-thresholds';
import { createContextVersion } from '../context-version';
import {
  createArtifactId,
  createConversationId,
  createEventId,
  createSequenceNumber,
  createSummaryNodeId,
} from '../ids';
import { isMessageRole } from '../message-role';
import { createMimeType } from '../mime-type';
import { createTimestamp } from '../timestamp';
import { createTokenBudget } from '../token-budget';
import { createTokenCount } from '../token-count';

describe('ids value objects', () => {
  it('creates branded IDs from non-empty strings', () => {
    expect(createConversationId('conv_1')).toBe('conv_1');
    expect(createEventId('evt_1')).toBe('evt_1');
    expect(createSummaryNodeId('sum_1')).toBe('sum_1');
    expect(createArtifactId('file_1')).toBe('file_1');
  });

  it('rejects empty IDs', () => {
    expect(() => createConversationId('   ')).toThrow(InvariantViolationError);
    expect(() => createEventId('')).toThrow(InvariantViolationError);
  });

  it('creates positive sequence number', () => {
    expect(createSequenceNumber(1)).toBe(1);
  });

  it('rejects non-positive or non-integer sequence numbers', () => {
    expect(() => createSequenceNumber(0)).toThrow(NonMonotonicSequenceError);
    expect(() => createSequenceNumber(-1)).toThrow(NonMonotonicSequenceError);
    expect(() => createSequenceNumber(1.1)).toThrow(NonMonotonicSequenceError);
  });
});

describe('token value objects', () => {
  it('creates non-negative token counts', () => {
    expect(createTokenCount(0).value).toBe(0);
    expect(createTokenCount(42).value).toBe(42);
  });

  it('rejects negative token counts', () => {
    expect(() => createTokenCount(-1)).toThrow(InvariantViolationError);
  });

  it('creates valid compaction thresholds', () => {
    const thresholds = createCompactionThresholds(0.6, 1);
    expect(thresholds.soft).toBe(0.6);
    expect(thresholds.hard).toBe(1);
  });

  it('rejects invalid compaction thresholds', () => {
    expect(() => createCompactionThresholds(0, 1)).toThrow(InvariantViolationError);
    expect(() => createCompactionThresholds(1, 1)).toThrow(InvariantViolationError);
    expect(() => createCompactionThresholds(1.1, 1)).toThrow(InvariantViolationError);
  });

  it('creates token budget with computed available tokens', () => {
    const budget = createTokenBudget({
      contextWindow: createTokenCount(100),
      overhead: createTokenCount(10),
      reserve: createTokenCount(20),
    });

    expect(budget.available.value).toBe(70);
  });

  it('rejects token budget when available is negative', () => {
    expect(() =>
      createTokenBudget({
        contextWindow: createTokenCount(10),
        overhead: createTokenCount(8),
        reserve: createTokenCount(3),
      }),
    ).toThrow(BudgetExceededError);
  });

  it('rejects token budget with inconsistent provided available value', () => {
    expect(() =>
      createTokenBudget({
        contextWindow: createTokenCount(100),
        overhead: createTokenCount(10),
        reserve: createTokenCount(20),
        available: createTokenCount(99),
      }),
    ).toThrow(InvariantViolationError);
  });
});

describe('miscellaneous value objects', () => {
  it('creates and validates context version', () => {
    expect(createContextVersion(0)).toBe(0);
    expect(createContextVersion(2)).toBe(2);
    expect(() => createContextVersion(-1)).toThrow(InvariantViolationError);
  });

  it('validates message roles', () => {
    expect(isMessageRole('system')).toBe(true);
    expect(isMessageRole('assistant')).toBe(true);
    expect(isMessageRole('unknown')).toBe(false);
  });

  it('creates mime type and rejects empty value', () => {
    expect(createMimeType('application/json')).toBe('application/json');
    expect(() => createMimeType('')).toThrow(InvariantViolationError);
  });

  it('creates timestamp and rejects invalid date', () => {
    const value = createTimestamp(new Date('2026-02-27T00:00:00.000Z'));
    expect(value.getTime()).toBe(new Date('2026-02-27T00:00:00.000Z').getTime());

    expect(() => createTimestamp(new Date('not-a-date'))).toThrow(InvariantViolationError);
  });
});
