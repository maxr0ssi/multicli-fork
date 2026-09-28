import { useEffect, useMemo, useState } from 'preact/hooks';

import type { WorkflowRevision } from '../../../../workflows/domain.js';
import { canAddNodeDependency, setNodeDependency } from './draftEditorModel.js';

interface DependencyEditorProps {
  readonly definition: WorkflowRevision;
  readonly nodeId: string;
  readonly onChange: (definition: WorkflowRevision) => void;
}

export function DependencyEditor({
  definition,
  nodeId,
  onChange,
}: DependencyEditorProps) {
  const incoming = definition.edges.filter(edge => edge.to === nodeId);
  const outgoing = definition.edges.filter(edge => edge.from === nodeId);
  const available = useMemo(() => definition.nodes.filter(node => (
    !incoming.some(edge => edge.from === node.id)
      && canAddNodeDependency(definition, nodeId, node.id)
  )), [definition.nodes, incoming, nodeId]);
  const [nextDependency, setNextDependency] = useState('');
  useEffect(() => setNextDependency(''), [nodeId]);
  const labelFor = (id: string) => (
    definition.nodes.find(node => node.id === id)?.label ?? id
  );

  return (
    <div class="draft-dependencies">
      <section>
        <div class="draft-panel-heading">
          <div>
            <h4>Needs</h4>
            <p>These nodes must finish before this one starts.</p>
          </div>
        </div>
        {incoming.length === 0 ? (
          <p class="draft-empty-copy">No dependencies. This node is currently a root.</p>
        ) : (
          <ul class="draft-relation-list">
            {incoming.map(edge => (
              <li key={`${edge.from}:${edge.to}`}>
                <span>{labelFor(edge.from)}</span>
                <button
                  class="button"
                  type="button"
                  onClick={() => onChange(setNodeDependency(definition, nodeId, edge.from, false))}
                >Remove</button>
              </li>
            ))}
          </ul>
        )}
        {available.length > 0 && (
          <div class="draft-add-dependency">
            <label class="form-field">
              <span>Add dependency</span>
              <select
                value={nextDependency}
                onChange={event => setNextDependency(event.currentTarget.value)}
              >
                <option value="">Choose a node</option>
                {available.map(node => (
                  <option value={node.id} key={node.id}>{node.label}</option>
                ))}
              </select>
            </label>
            <button
              class="button"
              type="button"
              disabled={!nextDependency}
              onClick={() => {
                if (!nextDependency) return;
                onChange(setNodeDependency(definition, nodeId, nextDependency, true));
                setNextDependency('');
              }}
            >Add</button>
          </div>
        )}
        <p class="draft-field-help">Nodes that would create a cycle are not offered.</p>
      </section>
      <section>
        <h4>Unlocks</h4>
        <p>{outgoing.length > 0
          ? outgoing.map(edge => labelFor(edge.to)).join(', ')
          : 'Nothing yet. Validation will require a path to the end.'}</p>
      </section>
    </div>
  );
}
