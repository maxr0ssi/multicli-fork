import type { StudioRunView } from '../../types.js';

export type RunFocus = 'workflow' | 'approvals' | 'outputs' | 'telemetry' | 'activity';

export interface RunFocusItem {
  readonly id: RunFocus;
  readonly label: string;
  readonly detail: string;
  readonly state: string;
}

export function runFocusItems(view: StudioRunView): RunFocusItem[] {
  const pendingApprovals = view.approvals.filter(approval => approval.status === 'pending').length;
  return [
    {
      id: 'workflow',
      label: 'Workflow',
      detail: `${view.workflow.nodes.length} nodes · revision ${view.workflow.logicalRevision}`,
      state: view.run.status,
    },
    ...(pendingApprovals > 0
      ? [{
        id: 'approvals' as const,
        label: 'Approval required',
        detail: `${pendingApprovals} pending decision${pendingApprovals === 1 ? '' : 's'}`,
        state: 'waiting',
      }]
      : []),
    ...(view.artifacts.length > 0
      ? [{
        id: 'outputs' as const,
        label: 'Outputs',
        detail: `${view.artifacts.length} committed artifact${view.artifacts.length === 1 ? '' : 's'}`,
        state: 'neutral',
      }]
      : []),
    ...(view.execution.budget.usage.modelCalls > 0
      || view.execution.budget.usage.nodeAttempts > 0
      ? [{
        id: 'telemetry' as const,
        label: 'Usage',
        detail: view.execution.budget.usage.usageReports > 0
          ? `${view.execution.budget.usage.usageReports}/${view.execution.budget.usage.modelCalls} provider reports`
          : 'Usage not reported',
        state: 'neutral',
      }]
      : []),
    ...(view.events.length > 0
      ? [{
        id: 'activity' as const,
        label: 'Activity',
        detail: `${view.events.length} durable event${view.events.length === 1 ? '' : 's'}`,
        state: 'neutral',
      }]
      : []),
  ];
}
