import type { DomainEvent } from '@ledgermind/domain';

export interface DomainEventSubscriber {
  on(event: DomainEvent): void;
}
