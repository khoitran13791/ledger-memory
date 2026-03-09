import type { UnitOfWork, UnitOfWorkPort } from '@ledgermind/application';
import { type InMemoryPersistenceState } from './state';
export declare class InMemoryUnitOfWork implements UnitOfWorkPort {
    private readonly state;
    constructor(state?: InMemoryPersistenceState);
    execute<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T>;
}
//# sourceMappingURL=in-memory-unit-of-work.d.ts.map