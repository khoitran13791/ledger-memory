#!/usr/bin/env node

import { access } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import type { PostToolUseHookContext } from '../context';
import { buildCommandRuntime, isDirectExecution, type ClaudeCommandOptions } from '../runtime';

const EDITING_TOOL_NAMES = new Set(['Write', 'Edit', 'MultiEdit']);

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

const normalizeWorkspacePath = (workspaceRoot: string, candidatePath: string): string | undefined => {
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

  if (!runtime.config.artifactIndexingEnabled || !EDITING_TOOL_NAMES.has(context.toolName)) {
    return;
  }

  const artifactPaths = [...new Set(collectCandidatePaths(context.toolInput))]
    .map((candidatePath) => normalizeWorkspacePath(context.workspaceRoot, candidatePath))
    .filter((candidatePath): candidatePath is string => candidatePath !== undefined);

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
