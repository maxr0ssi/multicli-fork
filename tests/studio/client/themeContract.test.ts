import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const stylesDirectory = path.resolve('src/studio/client/styles');
const literalColor = /#[\da-f]{3,8}\b|\brgba?\(|\bhsla?\(|\b(?:linear|radial|conic)-gradient\(/i;

describe('Studio theme contract', () => {
  it('keeps every color literal and gradient out of component styles', () => {
    const violations = fs.readdirSync(stylesDirectory)
      .filter(file => file.endsWith('.css') && file !== 'theme.css')
      .filter(file => literalColor.test(fs.readFileSync(path.join(stylesDirectory, file), 'utf8')));

    expect(violations).toEqual([]);
  });

  it('declares the cascade and semantic light/dark tokens centrally', () => {
    const index = fs.readFileSync(path.join(stylesDirectory, 'index.css'), 'utf8');
    const theme = fs.readFileSync(path.join(stylesDirectory, 'theme.css'), 'utf8');

    expect(index).toContain('@layer reset, tokens, themes, base, components, utilities;');
    for (const token of [
      '--surface-canvas',
      '--text-primary',
      '--focus-ring',
      '--status-running-text',
      '--status-waiting-text',
      '--status-success-text',
      '--status-danger-text',
    ]) {
      expect(theme).toContain(token);
    }
    expect(theme).toContain("[data-theme='light']");
    expect(theme).toContain("[data-theme='dark']");
    expect(theme).not.toMatch(/\b(?:linear|radial|conic)-gradient\(/i);
  });

  it('keeps narrow layouts single-column and confines graph overflow', () => {
    const layout = fs.readFileSync(path.join(stylesDirectory, 'layout.css'), 'utf8');
    const components = fs.readFileSync(
      path.join(stylesDirectory, 'components.css'),
      'utf8',
    );

    expect(layout).toContain('@media (max-width: 50rem)');
    expect(layout).toMatch(/\.app-body\s*\{[^}]*grid-template-columns:\s*1fr;/s);
    expect(components).toMatch(/\.run-focus-menu\s*\{[^}]*grid-template-columns:\s*1fr;/s);
    expect(components).toMatch(/\.dag-scroll\s*\{[^}]*overflow:\s*auto;/s);
  });

  it('keeps the page fixed and moves deep work into full-screen focus surfaces', () => {
    const layout = fs.readFileSync(path.join(stylesDirectory, 'layout.css'), 'utf8');
    const components = fs.readFileSync(
      path.join(stylesDirectory, 'components.css'),
      'utf8',
    );
    const workspace = fs.readFileSync(
      path.resolve('src/studio/client/features/runs/RunWorkspace.tsx'),
      'utf8',
    );
    const inspector = fs.readFileSync(
      path.resolve('src/studio/client/features/inspector/NodeInspector.tsx'),
      'utf8',
    );

    expect(layout).toMatch(/\.app-shell\s*\{[^}]*height:\s*100vh;[^}]*overflow:\s*hidden;/s);
    expect(layout).toMatch(/\.run-workspace\s*\{[^}]*overflow:\s*hidden;/s);
    expect(components).toMatch(/\.focus-dialog\[open\]\s*\{[^}]*display:\s*grid;/s);
    expect(components).toMatch(/\.node-focus-panel\s*\{[^}]*overflow:\s*auto;/s);
    expect(components).toMatch(/\.dag-map-viewport\s*\{[^}]*overflow:\s*hidden;/s);
    expect(components).toMatch(/\.dag-map-viewport\s*\{[^}]*overscroll-behavior:\s*none;/s);
    expect(components).toMatch(/\.dag-map-viewport\s*\{[^}]*touch-action:\s*none;/s);
    expect(workspace).toContain('<RunFocusMenu view={view} onOpen={setFocus} />');
    expect(workspace).toContain('<WorkflowFocusDialog');
    expect(inspector).toContain("{ id: 'transcript', label: 'Transcript' }");
    expect(inspector).toContain("{ id: 'steer' as const, label: 'Steer' }");
  });

  it('keeps long run objectives at readable body scale instead of title scale', () => {
    const header = fs.readFileSync(
      path.resolve('src/studio/client/features/runs/RunHeader.tsx'),
      'utf8',
    );
    const components = fs.readFileSync(
      path.join(stylesDirectory, 'components.css'),
      'utf8',
    );

    expect(header).toContain('<h1>{view.workflow.name}</h1>');
    expect(header).toContain('class="run-objective"');
    expect(header).toContain("'Show full objective'");
    expect(header).toContain('aria-expanded={objectiveExpanded}');
    expect(components).toMatch(/\.run-objective\s*\{[^}]*font-size:\s*var\(--font-body\)/s);
    expect(components).toMatch(/\.run-objective\s*\{[^}]*overflow-wrap:\s*anywhere/s);
    expect(components).toMatch(/\.run-objective\[data-expanded='false'\][^{]*\{[^}]*-webkit-line-clamp:\s*4/s);
  });

  it('keeps draft sculpting in a bounded map with capability-backed controls', () => {
    const editorStyles = fs.readFileSync(path.join(stylesDirectory, 'editor.css'), 'utf8');
    const editor = fs.readFileSync(
      path.resolve('src/studio/client/features/editor/WorkflowDraftEditor.tsx'),
      'utf8',
    );
    const workbench = fs.readFileSync(
      path.resolve('src/studio/client/features/editor/NodeWorkbench.tsx'),
      'utf8',
    );
    const autosave = fs.readFileSync(
      path.resolve('src/studio/client/features/editor/useDraftAutosave.ts'),
      'utf8',
    );
    const confirmation = fs.readFileSync(
      path.resolve('src/studio/client/components/ConfirmationDialog.tsx'),
      'utf8',
    );
    const publishDialog = fs.readFileSync(
      path.resolve('src/studio/client/features/editor/DraftPublishDialog.tsx'),
      'utf8',
    );
    const modal = fs.readFileSync(
      path.resolve('src/studio/client/useModalDialog.ts'),
      'utf8',
    );

    expect(editorStyles).toMatch(/\.draft-editor-shell\s*\{[^}]*overflow:\s*hidden;/s);
    expect(editorStyles).toMatch(/\.draft-map-stage\s*\{[^}]*overflow:\s*hidden;/s);
    expect(editor).toContain('validateWorkflowRevision(definition)');
    expect(editor).toContain('await saveLatest()');
    expect(publishDialog).toContain('Publish and run');
    expect(editor).toContain('api.publishAndStartWorkflowDraft(');
    expect(editor).not.toContain('api.startRun(');
    expect(editor).toContain('<DraftPublishDialog');
    expect(editor).toContain('<DraftRecoveryDialog');
    expect(editor).not.toContain('role="alertdialog"');
    expect(autosave).toContain('saveWorkflowDraftConflictAsNewDraft');
    expect(workbench).toContain('WorkflowDraftProviderCapability');
    expect(workbench).toContain('providerCapabilities');
    expect(workbench).not.toContain('Automatic selection');
    expect(workbench).not.toContain('Maximum attempts');
    expect(autosave).toContain("addEventListener('beforeunload'");
    expect(confirmation).toContain('useModalDialog()');
    expect(confirmation).toContain('<dialog');
    expect(modal).toContain('showModal()');
    expect(modal).toContain('returnFocus.focus()');
  });

  it('uses the shared native modal for every destructive Studio confirmation', () => {
    for (const file of [
      'features/runs/RunHeader.tsx',
      'features/approvals/ApprovalDecision.tsx',
      'features/steering/GoalSessionComposer.tsx',
    ]) {
      const source = fs.readFileSync(path.resolve('src/studio/client', file), 'utf8');
      expect(source).toContain('<ConfirmationDialog');
      expect(source).not.toContain('role="alertdialog"');
    }
  });
});
