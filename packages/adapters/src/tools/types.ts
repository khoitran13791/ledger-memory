export interface ToolReferences {
  readonly summaryIds?: readonly string[];
  readonly artifactIds?: readonly string[];
  readonly eventIds?: readonly string[];
}

export interface ToolSuccessEnvelope<TData = Record<string, unknown>> {
  readonly ok: true;
  readonly data: TData;
  readonly references?: ToolReferences;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface ToolErrorPayload {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface ToolErrorEnvelope {
  readonly ok: false;
  readonly error: ToolErrorPayload;
  readonly references?: ToolReferences;
}

export type ToolResponseEnvelope<TData = Record<string, unknown>> =
  | ToolSuccessEnvelope<TData>
  | ToolErrorEnvelope;
