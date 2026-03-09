export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

const MESSAGE_ROLES: readonly MessageRole[] = ['system', 'user', 'assistant', 'tool'];

export const isMessageRole = (value: string): value is MessageRole => {
  return MESSAGE_ROLES.includes(value as MessageRole);
};
