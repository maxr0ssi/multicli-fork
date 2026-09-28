import { describe, expect, it } from 'vitest';

import {
  normalizeClaudeHookPayload,
  normalizeCodexHookPayload,
  runImmutableSafetyChecks,
  type HarnessRequest,
} from '../../src/harness/index.js';

describe('Claude and Codex hook normalization', () => {
  it('normalizes Claude Edit payloads into the shared changed-subject shape', () => {
    const normalized = normalizeClaudeHookPayload({
      tool_name: 'Edit',
      tool_input: {
        file_path: 'src/example.ts',
        old_string: 'const answer = 41;',
        new_string: 'const answer = 42;',
      },
    });

    expect(normalized).toEqual({
      provider: 'claude',
      operation: 'edit',
      toolName: 'Edit',
      changes: [{ path: 'src/example.ts', addedText: 'const answer = 42;' }],
    });
  });

  it('normalizes Codex apply_patch payloads into the identical changed-subject shape', () => {
    const normalized = normalizeCodexHookPayload({
      toolName: 'apply_patch',
      arguments: {
        patch: [
          '*** Begin Patch',
          '*** Update File: src/example.ts',
          '@@',
          '-const answer = 41;',
          '+const answer = 42;',
          '*** End Patch',
        ].join('\n'),
      },
    });

    expect(normalized).toEqual({
      provider: 'codex',
      operation: 'apply_patch',
      toolName: 'apply_patch',
      changes: [{ path: 'src/example.ts', addedText: 'const answer = 42;' }],
    });
  });

  it('accepts camelCase Write variants and ignores unknown hooks', () => {
    expect(normalizeCodexHookPayload({
      toolName: 'Write',
      arguments: { filePath: 'src/new.ts', content: '' },
    })).toEqual({
      provider: 'codex',
      operation: 'write',
      toolName: 'Write',
      changes: [{ path: 'src/new.ts', addedText: '' }],
    });
    expect(normalizeClaudeHookPayload({ tool_name: 'Bash', tool_input: { command: 'pwd' } })).toBeUndefined();
    expect(normalizeCodexHookPayload({ toolName: 'apply_patch', arguments: { patch: 'not a patch' } })).toBeUndefined();
  });

  it('normalizes provider mutation variants instead of failing open', () => {
    expect(normalizeClaudeHookPayload({
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: 'src/multi.ts',
        edits: [{ old_string: 'one', new_string: 'two' }, { old_string: 'three', new_string: 'four' }],
      },
    })).toMatchObject({
      operation: 'edit',
      changes: [{ path: 'src/multi.ts', addedText: 'two\nfour' }],
    });
    expect(normalizeClaudeHookPayload({
      tool_name: 'NotebookEdit',
      tool_input: { notebook_path: 'analysis.ipynb', new_source: 'print("safe")' },
    })).toMatchObject({
      operation: 'edit',
      changes: [{ path: 'analysis.ipynb', addedText: 'print("safe")' }],
    });
    expect(normalizeCodexHookPayload({
      toolName: 'str_replace',
      arguments: { path: 'src/replace.ts', new_str: 'const safe = true;' },
    })).toMatchObject({
      operation: 'edit',
      changes: [{ path: 'src/replace.ts', addedText: 'const safe = true;' }],
    });
  });

  it('checks normalized hook content without retaining the raw patch in findings', () => {
    const request: HarnessRequest = {
      trigger: 'post_edit',
      actor: { kind: 'codex' },
      workspace: '/workspace/project',
      changes: [],
      profileRevision: 'r1',
      hookPayload: {
        tool_name: 'apply_patch',
        tool_input: {
          patch: [
            '*** Begin Patch',
            '*** Add File: src/config.ts',
            '+export const token = "sk-cccccccccccccccc";',
            '*** End Patch',
          ].join('\n'),
        },
      },
    };
    const findings = runImmutableSafetyChecks(request);

    expect(findings).toContainEqual(expect.objectContaining({
      ruleId: 'secrets.detected',
      path: 'src/config.ts',
      required: true,
      waivable: false,
    }));
    expect(JSON.stringify(findings)).not.toContain('sk-cccc');
  });
});
