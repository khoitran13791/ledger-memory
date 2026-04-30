#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import type { PostToolUseHookContext } from '../context';
import { buildCommandRuntime, isDirectExecution, type ClaudeCommandOptions } from '../runtime';

const EDITING_TOOL_NAMES = new Set(['Write', 'Edit', 'MultiEdit']);
const READ_SEARCH_TOOL_NAMES = new Set(['Read', 'Grep', 'Glob', 'LS']);
const DELEGATION_TOOL_NAMES = new Set(['Task']);
const VERIFICATION_COMMAND_PATTERN = /\b(test|typecheck|lint|build|vitest|tsc)\b/u;
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]+/gu,
  /ghp_[A-Za-z0-9_]+/gu,
  /postgres:\/\/[^\s]+/gu,
  /mongodb(\+srv)?:\/\/[^\s]+/gu,
  /AKIA[0-9A-Z]{16}/gu,
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const collectCandidatePaths = (toolInput: Record<string, unknown>): readonly string[] => {
  const paths: string[] = [];

  const addPath = (value: unknown): void => {
    if (typeof value === 'string' && value.trim().length > 0) {
      paths.push(value);
      return;
    }

    if (Array.isArray(value)) {
      value.forEach(addPath);
      return;
    }

    if (isRecord(value)) {
      if ('file_path' in value) {
        addPath(value.file_path);
      }
      if ('path' in value) {
        addPath(value.path);
      }
    }
  };

  addPath(toolInput.file_path);
  addPath(toolInput.path);
  addPath(toolInput.paths);
  addPath(toolInput.edits);
  addPath(toolInput.files);

  return paths;
};

const stringifySummary = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }

  if (value === undefined) {
    return '';
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const redactSecrets = (value: string): string =>
  SECRET_PATTERNS.reduce((current, pattern) => current.replace(pattern, '[REDACTED]'), value);

const stableEvidenceKeyPart = (value: unknown): string =>
  createHash('sha256').update(stringifySummary(value)).digest('hex').slice(0, 16);

const summarizeToolResponse = (value: unknown, budgetChars: number): string => {
  const redacted = redactSecrets(stringifySummary(value)).trim();
  if (redacted.length <= budgetChars) {
    return redacted;
  }

  return `${redacted.slice(0, Math.max(0, budgetChars - 3)).trimEnd()}...`;
};

const isFailedToolResponse = (value: unknown): boolean => {
  if (!isRecord(value)) {
    return false;
  }

  if (value.success === false || value.ok === false || value.isError === true) {
    return true;
  }

  const exitCode = value.exit_code ?? value.exitCode;
  return typeof exitCode === 'number' && exitCode !== 0;
};

const normalizeWorkspacePath = (
  workspaceRoot: string,
  candidatePath: string,
): string | undefined => {
  const absoluteWorkspaceRoot = resolve(workspaceRoot);
  const absoluteCandidate = candidatePath.startsWith('/')
    ? resolve(candidatePath)
    : resolve(absoluteWorkspaceRoot, candidatePath);
  const workspaceRelativePath = relative(absoluteWorkspaceRoot, absoluteCandidate);

  if (
    workspaceRelativePath.length === 0 ||
    (!workspaceRelativePath.startsWith('..') && !workspaceRelativePath.startsWith('../'))
  ) {
    return absoluteCandidate;
  }

  return undefined;
};

export const runPostToolUseCommand = async (options: ClaudeCommandOptions = {}): Promise<void> => {
  const runtime = await buildCommandRuntime(options);
  const context = runtime.expectHookContext('PostToolUse') as PostToolUseHookContext;
  const candidatePaths = [...new Set(collectCandidatePaths(context.toolInput))];
  const normalizedArtifactPaths = candidatePaths
    .map((candidatePath) => normalizeWorkspacePath(context.workspaceRoot, candidatePath))
    .filter((candidatePath): candidatePath is string => candidatePath !== undefined);

  if (runtime.config.toolEvidenceEnabled) {
    const binding = await runtime.resolveBinding(context);
    const redactedCommand =
      typeof context.toolInput.command === 'string'
        ? redactSecrets(context.toolInput.command)
        : undefined;
    const provenance = {
      ...(context.toolUseId === undefined ? {} : { toolUseId: context.toolUseId }),
      ...(redactedCommand === undefined ? {} : { command: redactedCommand }),
    };
    const outputSummary = summarizeToolResponse(
      context.toolResponse,
      runtime.config.toolOutputBudgetChars,
    );
    const evidenceKeySuffix =
      context.toolUseId ??
      stableEvidenceKeyPart({
        toolName: context.toolName,
        command: redactedCommand,
        paths: normalizedArtifactPaths.map((artifactPath) =>
          relative(resolve(context.workspaceRoot), artifactPath),
        ),
        response: outputSummary,
      });

    if (isFailedToolResponse(context.toolResponse)) {
      await runtime.engine.recordContinuity({
        conversationId: binding.conversationId,
        kind: 'failure',
        title: `${context.toolName} failed`,
        content: outputSummary.length === 0 ? `${context.toolName} failed.` : outputSummary,
        provenance,
        idempotencyKey: `claude-tool-evidence:${context.sessionId}:${evidenceKeySuffix}:failure`,
      });
      return;
    }

    if (
      context.toolName === 'Bash' &&
      typeof context.toolInput.command === 'string' &&
      VERIFICATION_COMMAND_PATTERN.test(context.toolInput.command)
    ) {
      await runtime.engine.recordContinuity({
        conversationId: binding.conversationId,
        kind: 'verification',
        title: `Bash verification: ${redactedCommand ?? context.toolName}`,
        content:
          outputSummary.length === 0
            ? `Command completed: ${redactedCommand ?? context.toolName}`
            : outputSummary,
        provenance,
        idempotencyKey: `claude-tool-evidence:${context.sessionId}:${evidenceKeySuffix}:verification`,
      });
    }

    if (EDITING_TOOL_NAMES.has(context.toolName) && normalizedArtifactPaths.length > 0) {
      const relativePaths = normalizedArtifactPaths.map((artifactPath) =>
        relative(resolve(context.workspaceRoot), artifactPath),
      );
      await runtime.engine.recordContinuity({
        conversationId: binding.conversationId,
        kind: 'artifact_change',
        title: `${context.toolName} changed ${relativePaths.length} workspace ${relativePaths.length === 1 ? 'file' : 'files'}`,
        content: ['Changed files:', ...relativePaths.map((path) => `- ${path}`)].join('\n'),
        provenance,
        idempotencyKey: `claude-tool-evidence:${context.sessionId}:${evidenceKeySuffix}:artifact-change`,
      });
    }

    if (
      READ_SEARCH_TOOL_NAMES.has(context.toolName) ||
      DELEGATION_TOOL_NAMES.has(context.toolName)
    ) {
      // These tool classes are intentionally classified for failure evidence above.
    }
  }

  if (!runtime.config.artifactIndexingEnabled || !EDITING_TOOL_NAMES.has(context.toolName)) {
    return;
  }

  const artifactPaths = normalizedArtifactPaths;

  if (artifactPaths.length === 0) {
    return;
  }

  const binding = await runtime.resolveBinding(context);
  for (const artifactPath of artifactPaths) {
    try {
      await access(artifactPath);
      await runtime.engine.storeArtifact({
        conversationId: binding.conversationId,
        source: {
          kind: 'path',
          path: artifactPath,
        },
      });
    } catch {
      runtime.warn(`Skipped artifact indexing for missing or unreadable path: ${artifactPath}`);
    }
  }
};

if (isDirectExecution(import.meta.url)) {
  await runPostToolUseCommand();
}
