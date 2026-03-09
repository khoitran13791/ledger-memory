import type { DomainEvent } from '@ledgermind/domain';

export interface EventPublisherPort {
  publish(event: DomainEvent): void;
}
