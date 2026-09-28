import type { WorkflowValidationResult } from '../../../../workflows/graph.js';

interface ValidationWorkbenchProps {
  readonly validation: WorkflowValidationResult;
  readonly onSelectNode: (nodeId: string) => void;
  readonly onClose: () => void;
}

export function ValidationWorkbench({
  validation,
  onSelectNode,
  onClose,
}: ValidationWorkbenchProps) {
  return (
    <aside class="draft-workbench" aria-labelledby="draft-validation-title">
      <header class="draft-workbench-heading">
        <div>
          <p class="context-label">Continuous validation</p>
          <h3 id="draft-validation-title">
            {validation.valid ? 'Ready to publish' : `${validation.issues.length} issues`}
          </h3>
        </div>
        <button class="button" type="button" onClick={onClose}>Back to map</button>
      </header>
      <div class="draft-validation-panel">
        {validation.valid ? (
          <div class="draft-validation-ready" role="status">
            <h4>Topology is valid</h4>
            <p>The graph has one root, one end, valid profiles, and no cycles.</p>
          </div>
        ) : (
          <ol class="draft-validation-list">
            {validation.issues.map((issue, index) => (
              <li key={`${issue.code}:${issue.nodeId ?? ''}:${index}`}>
                {issue.nodeId ? (
                  <button type="button" onClick={() => onSelectNode(issue.nodeId!)}>
                    <strong>{issue.message}</strong>
                    <span>{issue.nodeId}</span>
                  </button>
                ) : (
                  <div><strong>{issue.message}</strong><span>Workflow</span></div>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </aside>
  );
}
