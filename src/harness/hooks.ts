import type {
  ChangedSubject,
  NormalizedHookOperation,
  NormalizedHookPayload,
} from './types.js';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as UnknownRecord;
}

function firstString(record: UnknownRecord | undefined, keys: readonly string[]): string | undefined {
  if (record === undefined) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function firstDefined(record: UnknownRecord, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function toolNameFromPayload(payload: UnknownRecord): string | undefined {
  const direct = firstString(payload, ['tool_name', 'toolName', 'name']);
  if (direct !== undefined) return direct;
  return firstString(asRecord(payload.tool), ['name', 'tool_name', 'toolName']);
}

function operationForToolName(toolName: string): NormalizedHookOperation | undefined {
  const canonical = toolName.toLowerCase().replace(/[\s_-]/g, '');
  if (['edit', 'multiedit', 'notebookedit', 'strreplace'].includes(canonical)) return 'edit';
  if (canonical === 'write') return 'write';
  if (canonical === 'applypatch') return 'apply_patch';
  return undefined;
}

function addedTextFromInput(
  operation: 'edit' | 'write',
  input: UnknownRecord,
  fallback: UnknownRecord,
): string | undefined {
  const contentKeys = operation === 'edit'
    ? ['new_string', 'newString', 'new_source', 'newSource', 'new_str', 'newStr', 'replacement', 'content']
    : ['content', 'new_string', 'newString'];
  const direct = firstString(input, contentKeys) ?? firstString(fallback, contentKeys);
  if (direct !== undefined) return direct;

  const nested = firstDefined(input, ['edits', 'changes', 'replacements']);
  if (!Array.isArray(nested)) return undefined;
  const additions = nested
    .map(value => firstString(asRecord(value), contentKeys))
    .filter((value): value is string => value !== undefined);
  return additions.length > 0 ? additions.join('\n') : undefined;
}

function subjectFromEditOrWrite(
  operation: 'edit' | 'write',
  input: UnknownRecord,
  fallback: UnknownRecord,
): ChangedSubject | undefined {
  const path = firstString(input, [
    'file_path', 'filePath', 'notebook_path', 'notebookPath', 'path', 'file',
  ]) ?? firstString(fallback, [
    'file_path', 'filePath', 'notebook_path', 'notebookPath', 'path', 'file',
  ]);
  if (path === undefined || path.trim().length === 0) return undefined;
  const addedText = addedTextFromInput(operation, input, fallback);

  return Object.freeze({
    path,
    ...(addedText === undefined ? {} : { addedText }),
  });
}

function addPatchSubject(
  subjects: Map<string, { path: string; additions: string[] }>,
  path: string,
): { path: string; additions: string[] } | undefined {
  const trimmed = path.trim().replace(/^([ab])\//, '');
  if (trimmed.length === 0 || trimmed === '/dev/null') return undefined;
  const existing = subjects.get(trimmed);
  if (existing !== undefined) return existing;
  const created = { path: trimmed, additions: [] };
  subjects.set(trimmed, created);
  return created;
}

/**
 * Handles both Codex's `*** Begin Patch` syntax and normal unified diffs. The
 * parser deliberately extracts only paths and added text; it does not retain a
 * raw provider payload or attempt to apply a patch.
 */
export function changedSubjectsFromPatch(patch: string): readonly ChangedSubject[] {
  const subjects = new Map<string, { path: string; additions: string[] }>();
  let current: { path: string; additions: string[] } | undefined;

  for (const line of patch.split(/\r?\n/)) {
    const applyPatchTarget = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line);
    if (applyPatchTarget !== null) {
      current = addPatchSubject(subjects, applyPatchTarget[1]);
      continue;
    }

    const unifiedTarget = /^\+\+\+\s+(.+?)(?:\t.*)?$/.exec(line);
    if (unifiedTarget !== null) {
      current = addPatchSubject(subjects, unifiedTarget[1]);
      continue;
    }

    if (current !== undefined && line.startsWith('+') && !line.startsWith('+++')) {
      current.additions.push(line.slice(1));
    }
  }

  return Object.freeze(
    [...subjects.values()].map((subject) => Object.freeze({
      path: subject.path,
      ...(subject.additions.length === 0 ? {} : { addedText: subject.additions.join('\n') }),
    })),
  );
}

/**
 * Normalizes the write-shaped portion of a provider hook event. Unknown and
 * non-mutating events return undefined rather than pretending they were safe.
 */
export function normalizeHookPayload(
  provider: 'claude' | 'codex',
  payload: unknown,
): NormalizedHookPayload | undefined {
  const root = asRecord(payload);
  if (root === undefined) return undefined;

  const toolName = toolNameFromPayload(root);
  if (toolName === undefined) return undefined;
  const operation = operationForToolName(toolName);
  if (operation === undefined) return undefined;

  const rawInput = firstDefined(root, ['tool_input', 'toolInput', 'arguments', 'input']);
  const input = asRecord(rawInput) ?? root;
  let changes: readonly ChangedSubject[];

  if (operation === 'apply_patch') {
    const patch = typeof rawInput === 'string'
      ? rawInput
      : firstString(input, ['patch', 'diff', 'content']) ?? firstString(root, ['patch', 'diff', 'content']);
    if (patch === undefined) return undefined;
    changes = changedSubjectsFromPatch(patch);
    if (changes.length === 0) return undefined;
  } else {
    const subject = subjectFromEditOrWrite(operation, input, root);
    if (subject === undefined) return undefined;
    changes = Object.freeze([subject]);
  }

  return Object.freeze({
    provider,
    operation,
    toolName,
    changes,
  });
}

export function normalizeClaudeHookPayload(payload: unknown): NormalizedHookPayload | undefined {
  return normalizeHookPayload('claude', payload);
}

export function normalizeCodexHookPayload(payload: unknown): NormalizedHookPayload | undefined {
  return normalizeHookPayload('codex', payload);
}
