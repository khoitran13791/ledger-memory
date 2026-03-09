import type { AuthorizationPort, CallerContext } from '@ledgermind/application';

/**
 * Phase 1 authorization policy:
 * only sub-agents can call expand().
 */
export class SubAgentAuthorizationAdapter implements AuthorizationPort {
  canExpand(caller: CallerContext): boolean {
    return caller.isSubAgent;
  }
}
