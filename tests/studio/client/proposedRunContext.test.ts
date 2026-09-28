import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { formatProposedRunContext } from '../../../src/studio/client/features/editor/ProposedRunContextDialog.js';

describe('proposed run context preview', () => {
  it('shows every persisted input field without reducing it to the objective', () => {
    const input = {
      objective: 'Ship the editor',
      acceptanceCriteria: ['No fake data', 'Exact deep links'],
      constraints: { maxAgents: 5 },
      context: { issue: 'P1' },
      extra: ['preserved', { nested: true }],
    };

    expect(formatProposedRunContext(input)).toBe(JSON.stringify(input, null, 2));
  });

  it('keeps the exact context collapsed until the operator opens a focus surface', () => {
    const editor = fs.readFileSync(path.resolve(
      'src/studio/client/features/editor/WorkflowDraftEditor.tsx',
    ), 'utf8');
    const preview = fs.readFileSync(path.resolve(
      'src/studio/client/features/editor/ProposedRunContextDialog.tsx',
    ), 'utf8');

    expect(editor).toContain('const [runContextOpen, setRunContextOpen] = useState(false);');
    expect(editor).toContain('onClick={() => setRunContextOpen(true)}>Run context</button>');
    expect(editor).toContain('{runContextOpen && proposedRunInput !== undefined && (');
    expect(preview).toContain('<FocusDialog');
    expect(preview).toContain('read-only persisted input');
  });
});
