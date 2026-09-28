import { useEffect, useState } from 'preact/hooks';
import type { WorkflowNode } from '../../../../workflows/domain.js';

import type { StudioApi } from '../../api.js';
import { FocusDialog } from '../../components/FocusDialog.js';
import { readableState } from '../../format.js';
import type { StudioRunView } from '../../types.js';
import { ArtifactList } from '../artifacts/ArtifactList.js';
import { GoalSessionComposer } from '../steering/GoalSessionComposer.js';
import { OpenGoalSession } from '../steering/OpenGoalSession.js';
import { AttemptList } from './AttemptList.js';
import { NodeTranscript } from './NodeTranscript.js';

type NodeTab = 'transcript' | 'details' | 'outputs' | 'steer';

interface NodeInspectorProps {
  readonly api: StudioApi;
  readonly view: StudioRunView;
  readonly selectedNodeId?: string;
  readonly onClose: () => void;
  readonly onGoalInstruction: (sessionId: string, instruction: string) => Promise<void>;
  readonly onCloseGoalSession: (sessionId: string) => Promise<void>;
  readonly onOpenGoalSession: (profileId: string, goal: string) => Promise<void>;
}

function nodePrompt(node: WorkflowNode): string | undefined {
  if (node.kind === 'agent' || node.kind === 'gate') return node.prompt;
  return undefined;
}

export function NodeInspector({
  api,
  view,
  selectedNodeId,
  onClose,
  onGoalInstruction,
  onCloseGoalSession,
  onOpenGoalSession,
}: NodeInspectorProps) {
  const [tab, setTab] = useState<NodeTab>('transcript');
  useEffect(() => setTab('transcript'), [selectedNodeId]);
  if (!selectedNodeId) return null;
  const node = view.workflow.nodes.find(candidate => candidate.id === selectedNodeId);
  if (!node) return null;
  const execution = view.execution.nodes[node.id];
  const profile = node.kind === 'agent' ? view.workflow.profiles[node.profileId] : undefined;
  const predecessors = view.workflow.edges.filter(edge => edge.to === node.id);
  const successors = view.workflow.edges.filter(edge => edge.from === node.id);
  const prompt = nodePrompt(node);
  const relatedArtifacts = view.artifacts.filter(artifact => (
    execution?.artifactIds.includes(artifact.id)
  ));
  const relatedGoals = profile
    ? view.goalSessions.filter(session => session.profileId === profile.id)
    : [];
  const canOpenGoal = profile
    && (profile.provider === 'codex' || profile.provider === 'claude')
    && view.run.allowedActions.openGoalSession.allowed;
  const tabs: Array<{ id: NodeTab; label: string }> = [
    { id: 'transcript', label: 'Transcript' },
    { id: 'details', label: 'Details' },
    ...(relatedArtifacts.length ? [{ id: 'outputs' as const, label: 'Outputs' }] : []),
    ...(canOpenGoal || relatedGoals.length
      ? [{ id: 'steer' as const, label: 'Steer' }]
      : []),
  ];
  const panelId = `node-panel-${node.id}`;

  return (
    <FocusDialog
      titleId="node-focus-title"
      title={node.label}
      context={`${node.kind} · ${readableState(execution?.status ?? 'pending')}`}
      className="node-focus-dialog"
      onClose={onClose}
    >
      <div class="focus-tabs" role="tablist" aria-label={`${node.label} views`}>
        {tabs.map(candidate => (
          <button
            type="button"
            role="tab"
            class="focus-tab"
            aria-selected={tab === candidate.id}
            aria-controls={panelId}
            onClick={() => setTab(candidate.id)}
            key={candidate.id}
          >
            {candidate.label}
          </button>
        ))}
      </div>
      <div class="node-focus-panel" id={panelId} role="tabpanel">
        {tab === 'transcript' && (
          <NodeTranscript
            api={api}
            view={view}
            node={node}
            execution={execution}
            profile={profile}
            artifacts={relatedArtifacts}
            prompt={prompt}
          />
        )}
        {tab === 'details' && (
          <div class="node-details">
            <section class="inspector-section" aria-labelledby="node-overview-title">
              <h3 id="node-overview-title">Overview</h3>
              <dl class="fact-list">
                <div><dt>Status</dt><dd class="status-text" data-state={execution?.status ?? 'pending'}>{readableState(execution?.status ?? 'pending')}</dd></div>
                {profile && <div><dt>Profile</dt><dd>{profile.label}</dd></div>}
                {profile && <div><dt>Model</dt><dd>{profile.provider} · {profile.model}</dd></div>}
                {profile?.reasoningEffort && <div><dt>Reasoning</dt><dd>{profile.reasoningEffort}</dd></div>}
                {profile && <div><dt>Access</dt><dd>{profile.workspaceAccess}</dd></div>}
                {profile && <div><dt>Nested agents</dt><dd>{profile.enableSubagents ? 'Enabled' : 'Disabled'}</dd></div>}
                {predecessors.length > 0 && <div><dt>Needs</dt><dd>{predecessors.map(edge => edge.from).join(', ')}</dd></div>}
                {successors.length > 0 && <div><dt>Unlocks</dt><dd>{successors.map(edge => edge.to).join(', ')}</dd></div>}
              </dl>
              {node.description && <p>{node.description}</p>}
            </section>
            {execution && <AttemptList attempts={execution.attempts} />}
          </div>
        )}
        {tab === 'outputs' && (
          <ArtifactList runId={view.run.id} artifacts={relatedArtifacts} api={api} />
        )}
        {tab === 'steer' && profile && (
          <div class="node-steer">
            {canOpenGoal && (
              <OpenGoalSession
                availability={view.run.allowedActions.openGoalSession}
                profile={profile}
                onOpen={goal => onOpenGoalSession(profile.id, goal)}
              />
            )}
            {relatedGoals.map(session => (
              <GoalSessionComposer
                session={session}
                sendInstruction={session.allowedActions.sendInstruction}
                onSend={instruction => onGoalInstruction(session.id, instruction)}
                onClose={() => onCloseGoalSession(session.id)}
                key={session.id}
              />
            ))}
          </div>
        )}
      </div>
    </FocusDialog>
  );
}
