import { useMemo, useState } from 'preact/hooks';

import type { WorkflowDraftCapabilities } from '../../../../controlPlane/workflowDraftCapabilities.js';
import type {
  PublishedWorkflowDraftView,
  WorkflowDraftView,
} from '../../../../controlPlane/workflowDrafts.js';
import { validateWorkflowRevision } from '../../../../workflows/graph.js';
import type { StudioApi } from '../../api.js';
import { FocusDialog } from '../../components/FocusDialog.js';
import { DagCanvas } from '../graph/DagCanvas.js';
import { DraftPublishDialog } from './DraftPublishDialog.js';
import { DraftRecoveryDialog } from './DraftRecoveryDialog.js';
import { NodeWorkbench } from './NodeWorkbench.js';
import { ProposedRunContextDialog } from './ProposedRunContextDialog.js';
import { ValidationWorkbench } from './ValidationWorkbench.js';
import { WorkflowDetailsWorkbench } from './WorkflowDetailsWorkbench.js';
import {
  addAgentNode,
  duplicateAgentNode,
  removeAgentNode,
} from './draftEditorModel.js';
import { stableDraftRunKey } from './draftLaunchKey.js';
import { useDraftAutosave } from './useDraftAutosave.js';

type EditorPanel = 'details' | 'validation';

function proposedObjective(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const objective = (value as { objective?: unknown }).objective;
  return typeof objective === 'string' ? objective : '';
}

function withProposedObjective(value: unknown, objective: string): unknown {
  const current = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  if (objective.trim()) return { ...current, objective };
  const { objective: _removed, ...rest } = current;
  return rest;
}

interface WorkflowDraftEditorProps {
  readonly api: StudioApi;
  readonly initialDraft: WorkflowDraftView;
  readonly capabilities: WorkflowDraftCapabilities;
  readonly onDraftChanged: (draft: WorkflowDraftView) => void;
  readonly onPublished: (result: PublishedWorkflowDraftView) => void;
  readonly onRunStarted: (runId: string) => void;
  readonly onClose: () => void;
}

export function WorkflowDraftEditor({
  api,
  initialDraft,
  capabilities,
  onDraftChanged,
  onPublished,
  onRunStarted,
  onClose,
}: WorkflowDraftEditorProps) {
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [panel, setPanel] = useState<EditorPanel>();
  const [actionError, setActionError] = useState<string>();
  const [publishing, setPublishing] = useState(false);
  const [publishConfirmation, setPublishConfirmation] = useState(false);
  const [runContextOpen, setRunContextOpen] = useState(false);
  const [discardConfirmation, setDiscardConfirmation] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [launchRunId, setLaunchRunId] = useState<string>();
  const autosave = useDraftAutosave(api, initialDraft, onDraftChanged);
  const {
    draft,
    definition,
    proposedRunInput,
    dirty,
    saving,
    saveError,
    saveConflict,
    saveLatest,
    saveAsNewDraft,
  } = autosave;
  const published = Boolean(draft.publishedRevisionId);
  const structuralValidation = useMemo(() => validateWorkflowRevision(definition), [definition]);
  const validation = dirty ? structuralValidation : draft.validation;
  const selectedNode = definition.nodes.find(node => node.id === selectedNodeId);
  const graph = useMemo(() => ({
    key: draft.id,
    nodes: definition.nodes,
    edges: definition.edges,
    profiles: Object.fromEntries(definition.profiles.map(profile => [profile.id, profile])),
  }), [definition.edges, definition.nodes, definition.profiles, draft.id]);

  const replaceDraft = (next: WorkflowDraftView) => {
    autosave.replaceDraft(next);
    setSelectedNodeId(undefined);
    setPanel(undefined);
    setActionError(undefined);
    setLaunchRunId(undefined);
  };
  const changeDefinition: typeof autosave.changeDefinition = next => {
    if (!publishing && !published) autosave.changeDefinition(next);
  };
  const changeProposedRunInput = (next: unknown) => {
    if (!publishing && !published) autosave.changeProposedRunInput(next);
  };

  const publish = async (startRun: boolean) => {
    setPublishing(true);
    setActionError(undefined);
    try {
      const saved = await saveLatest();
      if (!saved.validation.valid) {
        setPanel('validation');
        return;
      }
      if (startRun) {
        const runInput = saved.proposedRunInput;
        const objective = proposedObjective(runInput);
        if (!objective) throw new Error('A run objective is required');
        const runId = launchRunId ?? stableDraftRunKey(saved.id, saved.version);
        if (!launchRunId) setLaunchRunId(runId);
        const result = await api.publishAndStartWorkflowDraft(
          saved.id,
          saved.version,
          runId,
          runInput,
        );
        replaceDraft(result.draft);
        setPublishConfirmation(false);
        onPublished(result);
        onRunStarted(result.run.run.id);
      } else {
        const result = await api.publishWorkflowDraft(saved.id, saved.version);
        replaceDraft(result.draft);
        setPublishConfirmation(false);
        onPublished(result);
      }
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPublishing(false);
    }
  };
  const preserveConflictAsNewDraft = async () => {
    setRecovering(true);
    setActionError(undefined);
    try {
      await saveAsNewDraft();
      setSelectedNodeId(undefined);
      setPanel(undefined);
      setDiscardConfirmation(false);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRecovering(false);
    }
  };

  const openNewDraft = async () => {
    if (!draft.publishedRevisionId) return;
    setPublishing(true);
    setActionError(undefined);
    try {
      const result = await api.updateWorkflowDraft(
        draft.id,
        draft.version,
        draft.definition,
        draft.proposedRunInput,
      );
      replaceDraft(result.draft);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPublishing(false);
    }
  };
  const issueCountFor = (nodeId: string) => (
    validation.issues.filter(issue => issue.nodeId === nodeId).length
  );
  const objective = proposedObjective(proposedRunInput);
  const unavailableAgents = definition.nodes.filter(node => {
    if (node.kind !== 'agent') return false;
    const profile = definition.profiles.find(candidate => candidate.id === node.profileId);
    return capabilities.providers.find(provider => provider.id === profile?.provider)?.availability
      === 'unavailable';
  }).length;

  return (
    <>
      <FocusDialog
      titleId="draft-editor-title"
      title={definition.name || 'Untitled workflow'}
      context={`Proposed workflow · draft version ${draft.version}`}
      className="draft-editor-dialog"
      closeDisabled={dirty || saving || publishing || recovering}
      onClose={onClose}
      actions={(
        <>
          <output class="draft-save-status" data-state={saveError ? 'failed' : saving || dirty ? 'running' : 'succeeded'}>
            {saveError ? 'Draft not saved' : saving ? 'Autosaving…' : dirty ? 'Waiting to save…' : `Saved · version ${draft.version}`}
          </output>
          {saveError && (
            <>
              {!saveConflict && (
                <button class="button" type="button" onClick={() => void saveLatest().catch(() => undefined)}>
                  Retry save
                </button>
              )}
              <button class="button" type="button" onClick={() => setDiscardConfirmation(true)}>
                {saveConflict ? 'Resolve save conflict' : 'Discard or reload'}
              </button>
            </>
          )}
          <button class="button" type="button" onClick={() => setPanel('validation')}>
            {validation.valid ? 'Ready to publish' : `${validation.issues.length} issues`}
          </button>
          {published ? (
            <button class="button button-primary" type="button" disabled={publishing} onClick={() => void openNewDraft()}>
              Edit as new draft
            </button>
          ) : (
            <button
              class="button button-primary"
              type="button"
              disabled={!validation.valid || publishing || Boolean(saveError)}
              onClick={() => setPublishConfirmation(true)}
            >Publish revision</button>
          )}
        </>
      )}
    >
      <div class="draft-editor-shell" data-workbench={Boolean(selectedNode || panel)}>
        <div class="draft-map-stage">
          {(actionError || saveError) && (
            <p class="notice notice-danger draft-action-error" role="alert">{actionError ?? saveError}</p>
          )}
          <div class="draft-map-actions" aria-label="Workflow draft controls">
            <button class="button" type="button" disabled={published} onClick={() => setPanel('details')}>Workflow details</button>
            {proposedRunInput !== undefined && (
              <button class="button" type="button" onClick={() => setRunContextOpen(true)}>Run context</button>
            )}
            <button
              class="button"
              type="button"
              disabled={!selectedNode || published}
              title={selectedNode ? 'Insert an agent after the selected node' : 'Select a node first'}
              onClick={() => {
                if (!selectedNode) return;
                const result = addAgentNode(definition, selectedNode.id);
                changeDefinition(result.definition);
                setSelectedNodeId(result.selectedNodeId);
                setPanel(undefined);
              }}
            >Insert agent after selection</button>
            <span>{definition.nodes.filter(node => node.kind === 'agent').length} agents</span>
          </div>
          <DagCanvas
            graph={graph}
            selectedNodeId={selectedNodeId}
            onSelect={nodeId => {
              if (published) return;
              setSelectedNodeId(nodeId);
              setPanel(undefined);
            }}
            showHeading={false}
            nodePresentation={node => {
              const issueCount = issueCountFor(node.id);
              return {
                state: issueCount > 0 ? 'invalid' : 'draft',
                statusLabel: issueCount > 0 ? `${issueCount} issue${issueCount === 1 ? '' : 's'}` : 'Draft',
              };
            }}
          />
        </div>
        {panel === 'details' && (
          <WorkflowDetailsWorkbench definition={definition} onChange={changeDefinition} onClose={() => setPanel(undefined)} />
        )}
        {panel === 'validation' && (
          <ValidationWorkbench
            validation={validation}
            onSelectNode={nodeId => { setSelectedNodeId(nodeId); setPanel(undefined); }}
            onClose={() => setPanel(undefined)}
          />
        )}
        {!panel && selectedNode && (
          <NodeWorkbench
            definition={definition}
            node={selectedNode}
            providerCapabilities={capabilities.providers}
            onChange={changeDefinition}
            onClose={() => setSelectedNodeId(undefined)}
            duplicateAllowed={definition.edges.some(edge => edge.to === selectedNode.id)}
            onDuplicateAgent={() => {
              const result = duplicateAgentNode(definition, selectedNode.id);
              if (!result) return;
              changeDefinition(result.definition);
              setSelectedNodeId(result.selectedNodeId);
            }}
            onRemoveAgent={() => {
              changeDefinition(removeAgentNode(definition, selectedNode.id));
              setSelectedNodeId(undefined);
            }}
          />
        )}
      </div>
      </FocusDialog>
      {runContextOpen && proposedRunInput !== undefined && (
        <ProposedRunContextDialog
          workflowName={definition.name || 'Untitled workflow'}
          value={proposedRunInput}
          onClose={() => setRunContextOpen(false)}
        />
      )}
      {publishConfirmation && (
        <DraftPublishDialog
          objective={objective}
          unavailableAgents={unavailableAgents}
          busy={publishing}
          error={actionError}
          onObjectiveChange={value => changeProposedRunInput(withProposedObjective(
            proposedRunInput,
            value,
          ))}
          onPublish={() => void publish(false)}
          onPublishAndRun={() => void publish(true)}
          onClose={() => setPublishConfirmation(false)}
        />
      )}
      {discardConfirmation && (
        <DraftRecoveryDialog
          busy={saving || recovering}
          conflict={Boolean(saveConflict)}
          error={actionError ?? saveError}
          onSaveAsNewDraft={() => void preserveConflictAsNewDraft()}
          onReload={() => {
            setRecovering(true);
            void api.workflowDraft(draft.id)
              .then(next => { replaceDraft(next); setDiscardConfirmation(false); })
              .catch(reason => setActionError(reason instanceof Error ? reason.message : String(reason)))
              .finally(() => setRecovering(false));
          }}
          onCloseWithoutSaving={onClose}
          onClose={() => setDiscardConfirmation(false)}
        />
      )}
    </>
  );
}
