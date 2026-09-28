import { FocusDialog } from '../../components/FocusDialog.js';
import type { StudioRunView } from '../../types.js';
import { DagCanvas } from './DagCanvas.js';

interface WorkflowFocusDialogProps {
  readonly view: StudioRunView;
  readonly selectedNodeId?: string;
  readonly onSelectNode: (nodeId: string) => void;
  readonly onEdit: () => void;
  readonly onClose: () => void;
}

export function WorkflowFocusDialog({
  view,
  selectedNodeId,
  onSelectNode,
  onEdit,
  onClose,
}: WorkflowFocusDialogProps) {
  return (
    <FocusDialog
      titleId="workflow-focus-title"
      title={view.workflow.name}
      context={`Workflow · revision ${view.workflow.logicalRevision}`}
      className="workflow-focus-dialog"
      actions={<button class="button" type="button" onClick={onEdit}>Edit as new draft</button>}
      onClose={onClose}
    >
      <DagCanvas
        graph={{
          key: view.workflow.recordId,
          nodes: view.workflow.nodes,
          edges: view.workflow.edges,
          profiles: view.workflow.profiles,
        }}
        selectedNodeId={selectedNodeId}
        onSelect={onSelectNode}
        showHeading={false}
        nodePresentation={node => ({
          state: view.execution.nodes[node.id]?.status ?? 'pending',
        })}
      />
    </FocusDialog>
  );
}
