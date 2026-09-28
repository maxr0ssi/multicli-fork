import { useEffect, useState } from 'preact/hooks';

import type { StudioApi } from '../../api.js';
import { FocusDialog } from '../../components/FocusDialog.js';
import type {
  StudioApproval,
  StudioRunAction,
  StudioRunView,
} from '../../types.js';
import { ApprovalDecision } from '../approvals/ApprovalDecision.js';
import { ArtifactList } from '../artifacts/ArtifactList.js';
import { WorkflowFocusDialog } from '../graph/WorkflowFocusDialog.js';
import { NodeInspector } from '../inspector/NodeInspector.js';
import { EventTimeline } from '../timeline/EventTimeline.js';
import { RunTelemetry } from '../telemetry/RunTelemetry.js';
import { RunFocusMenu } from './RunFocusMenu.js';
import type { RunFocus } from './focusModel.js';
import { RunHeader } from './RunHeader.js';

interface RunWorkspaceProps {
  readonly api: StudioApi;
  readonly view: StudioRunView;
  readonly selectedNodeId?: string;
  readonly busyAction?: StudioRunAction;
  readonly actionError?: string;
  readonly syncIssue?: string;
  readonly onSelectNode: (nodeId?: string) => void;
  readonly onRunAction: (action: StudioRunAction) => void;
  readonly onApproval: (
    approval: StudioApproval,
    decision: 'approved' | 'denied',
  ) => Promise<void>;
  readonly onGoalInstruction: (sessionId: string, instruction: string) => Promise<void>;
  readonly onCloseGoalSession: (sessionId: string) => Promise<void>;
  readonly onOpenGoalSession: (profileId: string, goal: string) => Promise<void>;
  readonly onEditWorkflow: (revisionId: string) => void;
}

export function RunWorkspace({
  api,
  view,
  selectedNodeId,
  busyAction,
  actionError,
  syncIssue,
  onSelectNode,
  onRunAction,
  onApproval,
  onGoalInstruction,
  onCloseGoalSession,
  onOpenGoalSession,
  onEditWorkflow,
}: RunWorkspaceProps) {
  const [focus, setFocus] = useState<RunFocus>();
  useEffect(() => setFocus(undefined), [view.run.id]);
  const closeInspector = () => {
    const priorNodeId = selectedNodeId;
    onSelectNode(undefined);
    if (!priorNodeId) return;
    queueMicrotask(() => {
      document.querySelector<HTMLButtonElement>(
        `[data-node-id="${CSS.escape(priorNodeId)}"]`,
      )?.focus();
    });
  };

  return (
    <main class="run-workspace">
      <RunHeader view={view} busyAction={busyAction} error={actionError} onAction={onRunAction} />
      {syncIssue && <p class="notice" role="status">{syncIssue}</p>}
      {view.execution.integrity.state === 'degraded' && (
        <div class="notice notice-danger" role="alert">
          <strong>Run data is incomplete.</strong>
          <ul>{view.execution.integrity.issues.map(issue => <li key={issue}>{issue}</li>)}</ul>
        </div>
      )}
      <RunFocusMenu view={view} onOpen={setFocus} />

      {focus === 'workflow' && (
        <WorkflowFocusDialog
          view={view}
          selectedNodeId={selectedNodeId}
          onSelectNode={onSelectNode}
          onEdit={() => {
            setFocus(undefined);
            onEditWorkflow(view.workflow.recordId);
          }}
          onClose={() => setFocus(undefined)}
        />
      )}
      {focus === 'approvals' && (
        <FocusDialog
          titleId="approvals-focus-title"
          title="Approval required"
          context={view.workflow.name}
          className="approval-focus-dialog"
          onClose={() => setFocus(undefined)}
        >
          <ApprovalDecision
            approvals={view.approvals}
            artifacts={view.artifacts}
            harness={view.harness}
            onResolve={onApproval}
          />
        </FocusDialog>
      )}
      {focus === 'outputs' && (
        <FocusDialog
          titleId="outputs-focus-title"
          title="Outputs"
          context={view.workflow.name}
          onClose={() => setFocus(undefined)}
        >
          <ArtifactList runId={view.run.id} artifacts={view.artifacts} api={api} />
        </FocusDialog>
      )}
      {focus === 'activity' && (
        <FocusDialog
          titleId="activity-focus-title"
          title="Run activity"
          context={view.workflow.name}
          onClose={() => setFocus(undefined)}
        >
          <EventTimeline view={view} />
        </FocusDialog>
      )}
      {focus === 'telemetry' && (
        <FocusDialog
          titleId="telemetry-focus-title"
          title="Usage"
          context={view.workflow.name}
          className="telemetry-focus-dialog"
          onClose={() => setFocus(undefined)}
        >
          <RunTelemetry view={view} />
        </FocusDialog>
      )}
      <NodeInspector
        api={api}
        view={view}
        selectedNodeId={selectedNodeId}
        onClose={closeInspector}
        onGoalInstruction={onGoalInstruction}
        onCloseGoalSession={onCloseGoalSession}
        onOpenGoalSession={onOpenGoalSession}
      />
    </main>
  );
}
