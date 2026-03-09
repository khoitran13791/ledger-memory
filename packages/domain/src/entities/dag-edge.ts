import { InvalidDagEdgeError } from '../errors/domain-errors';
import type { EventId, SummaryNodeId } from '../value-objects/ids';

export interface LeafDagEdge {
  readonly summaryId: SummaryNodeId;
  readonly messageId: EventId;
  readonly order: number;
}

export interface CondensedDagEdge {
  readonly summaryId: SummaryNodeId;
  readonly parentSummaryId: SummaryNodeId;
  readonly order: number;
}

export type DagEdge = LeafDagEdge | CondensedDagEdge;

export interface CreateLeafDagEdgeInput {
  readonly summaryId: SummaryNodeId;
  readonly messageId: EventId;
  readonly order: number;
}

export interface CreateCondensedDagEdgeInput {
  readonly summaryId: SummaryNodeId;
  readonly parentSummaryId: SummaryNodeId;
  readonly order: number;
}

const assertValidOrder = (order: number): void => {
  if (!Number.isSafeInteger(order) || order < 0) {
    throw new InvalidDagEdgeError('DagEdge.order must be a non-negative safe integer.');
  }
};

export const createLeafDagEdge = (input: CreateLeafDagEdgeInput): LeafDagEdge => {
  assertValidOrder(input.order);

  return Object.freeze({
    summaryId: input.summaryId,
    messageId: input.messageId,
    order: input.order,
  });
};

export const createCondensedDagEdge = (
  input: CreateCondensedDagEdgeInput,
): CondensedDagEdge => {
  assertValidOrder(input.order);

  return Object.freeze({
    summaryId: input.summaryId,
    parentSummaryId: input.parentSummaryId,
    order: input.order,
  });
};

export const isLeafDagEdge = (edge: DagEdge): edge is LeafDagEdge => {
  return 'messageId' in edge;
};

export const isCondensedDagEdge = (edge: DagEdge): edge is CondensedDagEdge => {
  return 'parentSummaryId' in edge;
};

export const assertContiguousDagEdgeOrders = (edges: readonly DagEdge[]): void => {
  const sortedOrders = [...edges].map((edge) => edge.order).sort((left, right) => left - right);

  for (let index = 0; index < sortedOrders.length; index += 1) {
    if (sortedOrders[index] !== index) {
      throw new InvalidDagEdgeError('DagEdge orders must be contiguous and start at zero.');
    }
  }
};
