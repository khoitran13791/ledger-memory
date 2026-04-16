import type { OperatorFailureMetadata } from '../../driving/operator-execution.port';

export interface StructuredGenerationInput {
  readonly item: unknown;
  readonly prompt: string;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly timeoutSeconds: number;
}

export type StructuredGenerationResult =
  | {
      readonly status: 'succeeded';
      readonly output: unknown;
    }
  | {
      readonly status: 'failed';
      readonly failure: OperatorFailureMetadata;
    };

export interface StructuredGenerationPort {
  generate(input: StructuredGenerationInput): Promise<StructuredGenerationResult>;
}
