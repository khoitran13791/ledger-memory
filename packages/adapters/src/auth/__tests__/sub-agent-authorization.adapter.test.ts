import { describe, expect, it } from 'vitest';

import { SubAgentAuthorizationAdapter } from '@ledgermind/adapters';
import { createConversationId } from '@ledgermind/domain';

describe('SubAgentAuthorizationAdapter', () => {
  const adapter = new SubAgentAuthorizationAdapter();
  const conversationId = createConversationId('conv_auth_adapter');

  it('allows expand for sub-agents', () => {
    expect(
      adapter.canExpand({
        conversationId,
        isSubAgent: true,
      }),
    ).toBe(true);
  });

  it('denies expand for non-sub-agents', () => {
    expect(
      adapter.canExpand({
        conversationId,
        isSubAgent: false,
      }),
    ).toBe(false);
  });
});
