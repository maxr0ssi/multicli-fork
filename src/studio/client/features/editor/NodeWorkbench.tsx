import { useEffect, useState } from 'preact/hooks';

import type { WorkflowDraftProviderCapability } from '../../../../controlPlane/workflowDraftCapabilities.js';
import type {
  AgentNode,
  WorkflowNode,
  WorkflowProfile,
  WorkflowRevision,
} from '../../../../workflows/domain.js';
import { DependencyEditor } from './DependencyEditor.js';
import {
  makeAgentProfileUnique,
  profileUseCount,
  updateWorkflowNode,
  updateWorkflowProfile,
  withWorkflowProfileModel,
} from './draftEditorModel.js';

type WorkbenchTab = 'agent' | 'execution' | 'dependencies';

interface NodeWorkbenchProps {
  readonly definition: WorkflowRevision;
  readonly node: WorkflowNode;
  readonly providerCapabilities: readonly WorkflowDraftProviderCapability[];
  readonly onChange: (definition: WorkflowRevision) => void;
  readonly onClose: () => void;
  readonly duplicateAllowed: boolean;
  readonly onDuplicateAgent: () => void;
  readonly onRemoveAgent: () => void;
}

function withoutEmptyEffort(profile: WorkflowProfile, value: string): WorkflowProfile {
  if (value.trim()) return { ...profile, reasoningEffort: value.trim() };
  const { reasoningEffort: _removed, ...rest } = profile;
  return rest;
}

function AgentExecution({
  definition,
  node,
  providerCapabilities,
  onChange,
}: {
  readonly definition: WorkflowRevision;
  readonly node: AgentNode;
  readonly providerCapabilities: readonly WorkflowDraftProviderCapability[];
  readonly onChange: (definition: WorkflowRevision) => void;
}) {
  const profile = definition.profiles.find(candidate => candidate.id === node.profileId);
  const uses = profileUseCount(definition, node.profileId);
  const [editShared, setEditShared] = useState(false);
  useEffect(() => setEditShared(false), [node.id, node.profileId]);
  if (!profile) {
    return <p class="notice notice-danger" role="alert">This agent references a missing profile.</p>;
  }
  const updateProfile = (update: (current: WorkflowProfile) => WorkflowProfile) => {
    onChange(updateWorkflowProfile(definition, profile.id, update));
  };
  const sharedLocked = uses > 1 && !editShared;
  const provider = providerCapabilities.find(candidate => candidate.id === profile.provider);
  const capabilitiesMissing = providerCapabilities.length === 0;
  const accessOptions = provider?.workspaceAccess ?? [profile.workspaceAccess];
  const providerOptions = providerCapabilities.some(candidate => candidate.id === profile.provider)
    ? providerCapabilities
    : [{
      id: profile.provider,
      label: `${profile.provider || 'Unconfigured'} (not reported)`,
      models: [{
        id: profile.model,
        reasoningEfforts: profile.reasoningEffort ? [profile.reasoningEffort] : [],
      }],
      reasoningEfforts: profile.reasoningEffort ? [profile.reasoningEffort] : [],
      workspaceAccess: [profile.workspaceAccess],
      supportsSubagents: profile.enableSubagents ?? false,
      availability: 'unknown' as const,
    }, ...providerCapabilities];
  const providerModels = provider?.models.map(model => model.id) ?? [];
  const modelOptions = providerModels.includes(profile.model)
    ? providerModels
    : [profile.model, ...providerModels].filter(Boolean);
  const modelEfforts = provider?.models.find(model => model.id === profile.model)?.reasoningEfforts
    ?? provider?.reasoningEfforts
    ?? [];
  const effortOptions = modelEfforts.includes(profile.reasoningEffort ?? '')
    ? modelEfforts
    : [profile.reasoningEffort, ...modelEfforts]
      .filter((value): value is string => Boolean(value));

  return (
    <div class="draft-execution-fields">
      <label class="form-field">
        <span>Profile</span>
        <select
          value={node.profileId}
          onChange={event => onChange(updateWorkflowNode(definition, node.id, current => (
            current.kind === 'agent'
              ? { ...current, profileId: event.currentTarget.value }
              : current
          )))}
        >
          {definition.profiles.map(candidate => (
            <option value={candidate.id} key={candidate.id}>{candidate.label}</option>
          ))}
        </select>
      </label>
      {uses > 1 && sharedLocked && (
        <div class="draft-shared-profile" role="note">
          <p>This profile controls {uses} agents. Choose the scope before changing it.</p>
          <div class="draft-inline-actions">
            <button
              class="button"
              type="button"
              onClick={() => onChange(makeAgentProfileUnique(definition, node.id))}
            >Make unique for this agent</button>
            <button class="button" type="button" onClick={() => setEditShared(true)}>
              Edit all {uses} agents
            </button>
          </div>
        </div>
      )}
      {uses > 1 && editShared && (
        <p class="draft-field-help"><strong>Editing execution settings for all {uses} agents.</strong></p>
      )}
      {capabilitiesMissing && (
        <p class="notice" role="status">
          Provider capabilities were not reported. Existing execution settings are preserved.
        </p>
      )}
      {provider?.availability === 'unavailable' && (
        <p class="notice notice-danger" role="status">
          The {provider.label} CLI is not available locally. This profile cannot run here yet.
        </p>
      )}
      {provider?.availability === 'unknown' && (
        <p class="draft-field-help">Models are catalogued; local CLI availability is unknown.</p>
      )}
      {!sharedLocked && <fieldset class="draft-fieldset">
        <div class="draft-field-grid">
          <label class="form-field">
            <span>Profile name</span>
            <input
              value={profile.label}
              onInput={event => updateProfile(current => ({
                ...current,
                label: event.currentTarget.value,
              }))}
            />
          </label>
          <label class="form-field">
            <span>Role</span>
            <select
              value={profile.role}
              onChange={event => updateProfile(current => ({
                ...current,
                role: event.currentTarget.value as WorkflowProfile['role'],
              }))}
            >
              <option value="builder">Builder</option>
              <option value="conductor">Conductor</option>
              <option value="reviewer">Reviewer</option>
              <option value="researcher">Researcher</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          <label class="form-field">
            <span>Provider</span>
            <select
              value={profile.provider}
              disabled={capabilitiesMissing}
              onChange={event => {
                const selected = providerCapabilities.find(candidate => (
                  candidate.id === event.currentTarget.value
                ));
                if (!selected) return;
                updateProfile(current => {
                  const access = selected.workspaceAccess.includes(current.workspaceAccess)
                    ? current.workspaceAccess
                    : selected.workspaceAccess[0] ?? 'read-only';
                  const { reasoningEffort: _oldEffort, ...base } = current;
                  return withWorkflowProfileModel({
                    ...base,
                    provider: selected.id,
                    model: '',
                    workspaceAccess: access,
                    enableSubagents: selected.supportsSubagents
                      ? current.enableSubagents
                      : false,
                  }, selected.models[0]?.id ?? '');
                });
              }}
            >
              {providerOptions.map(candidate => (
                <option value={candidate.id} key={candidate.id}>
                  {candidate.label}{candidate.availability === 'available'
                    ? ''
                    : ` · ${candidate.availability}`}
                </option>
              ))}
            </select>
          </label>
          <label class="form-field">
            <span>Model</span>
            <select
              value={profile.model}
              disabled={!provider}
              onChange={event => updateProfile(current => (
                withWorkflowProfileModel(current, event.currentTarget.value)
              ))}
            >
              {modelOptions.map(model => <option value={model} key={model}>{model}</option>)}
            </select>
          </label>
          {provider && modelEfforts.length > 0 && (
            <label class="form-field">
              <span>{provider.id === 'claude' ? 'Thinking level' : 'Reasoning effort'}</span>
              <select
                value={profile.reasoningEffort ?? ''}
                onChange={event => updateProfile(current => (
                  withoutEmptyEffort(current, event.currentTarget.value)
                ))}
              >
                <option value="">Provider default</option>
                {effortOptions.map(effort => (
                  <option value={effort} key={effort}>{effort}</option>
                ))}
              </select>
              <small>{provider.id === 'claude'
                ? 'Controls adaptive thinking depth for this Claude agent.'
                : 'Controls reasoning depth for this Codex agent.'}</small>
            </label>
          )}
          <label class="form-field">
            <span>Workspace access</span>
            <select
              value={profile.workspaceAccess}
              disabled={!provider}
              onChange={event => updateProfile(current => ({
                ...current,
                workspaceAccess: event.currentTarget.value as WorkflowProfile['workspaceAccess'],
              }))}
            >
              {accessOptions.map(access => (
                <option value={access} key={access}>{access === 'read-only'
                  ? 'Read only'
                  : access === 'workspace-write'
                    ? 'Workspace write'
                    : 'Full machine access'}</option>
              ))}
            </select>
          </label>
        </div>
        <label class="draft-toggle">
          <input
            type="checkbox"
            checked={profile.enableSubagents ?? false}
            disabled={!provider?.supportsSubagents}
            onChange={event => updateProfile(current => ({
              ...current,
              enableSubagents: event.currentTarget.checked,
            }))}
          />
          <span><strong>Enable nested agents</strong>Allow this provider session to create its own subagents.</span>
        </label>
        {(profile.workspaceAccess !== 'read-only' || profile.enableSubagents) && (
          <div class="draft-consequence" role="note">
            {profile.workspaceAccess !== 'read-only' && (
              <p>This agent can modify {profile.workspaceAccess === 'workspace-write'
                ? 'the workspace'
                : 'the local machine'}.</p>
            )}
            {profile.enableSubagents && <p>Nested agents can start additional provider work.</p>}
          </div>
        )}
      </fieldset>}
    </div>
  );
}

export function NodeWorkbench({
  definition,
  node,
  providerCapabilities,
  onChange,
  onClose,
  duplicateAllowed,
  onDuplicateAgent,
  onRemoveAgent,
}: NodeWorkbenchProps) {
  const [tab, setTab] = useState<WorkbenchTab>('agent');
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => {
    setTab('agent');
    setConfirmRemove(false);
  }, [node.id]);
  const tabs: readonly WorkbenchTab[] = node.kind === 'agent'
    ? ['agent', 'execution', 'dependencies']
    : ['agent', 'dependencies'];
  const tabLabel = (value: WorkbenchTab) => value === 'agent' ? 'Node' : value[0].toUpperCase() + value.slice(1);

  return (
    <aside class="draft-workbench" aria-label={`Edit ${node.label}`}>
      <header class="draft-workbench-heading">
        <div><p class="context-label">{node.kind} · {node.id}</p><h3>{node.label}</h3></div>
        <button class="button" type="button" onClick={onClose}>Back to map</button>
      </header>
      <div class="draft-workbench-tabs" role="tablist" aria-label="Node editor sections">
        {tabs.map(value => (
          <button
            type="button"
            role="tab"
            aria-selected={tab === value}
            class="draft-workbench-tab"
            onClick={() => setTab(value)}
            key={value}
          >{tabLabel(value)}</button>
        ))}
      </div>
      <div class="draft-workbench-panel" role="tabpanel">
        {tab === 'agent' && (
          <div class="draft-node-fields">
            <label class="form-field">
              <span>Node name</span>
              <input
                value={node.label}
                onInput={event => onChange(updateWorkflowNode(definition, node.id, current => ({
                  ...current,
                  label: event.currentTarget.value,
                })))}
              />
            </label>
            {(node.kind === 'agent' || node.kind === 'gate') && (
              <label class="form-field draft-prompt-field">
                <span>Prompt</span>
                <textarea
                  value={node.prompt}
                  onInput={event => onChange(updateWorkflowNode(definition, node.id, current => (
                    current.kind === 'agent' || current.kind === 'gate'
                      ? { ...current, prompt: event.currentTarget.value }
                      : current
                  )))}
                />
              </label>
            )}
            {node.kind !== 'agent' && (
              <p class="draft-empty-copy">This structural node has no execution profile.</p>
            )}
          </div>
        )}
        {tab === 'execution' && node.kind === 'agent' && (
          <AgentExecution
            definition={definition}
            node={node}
            providerCapabilities={providerCapabilities}
            onChange={onChange}
          />
        )}
        {tab === 'dependencies' && (
          <DependencyEditor definition={definition} nodeId={node.id} onChange={onChange} />
        )}
      </div>
      {node.kind === 'agent' && (
        <footer class="draft-workbench-actions">
          {confirmRemove ? (
            <div class="draft-remove-confirmation" role="alert">
              <p>Remove this agent and reconnect its incoming and outgoing paths?</p>
              <button class="button" type="button" onClick={() => setConfirmRemove(false)}>Keep agent</button>
              <button class="button button-danger" type="button" onClick={onRemoveAgent}>Confirm remove</button>
            </div>
          ) : (
            <>
              <button
                class="button"
                type="button"
                disabled={!duplicateAllowed}
                title={duplicateAllowed
                  ? 'Create a parallel agent with the same dependencies'
                  : 'A root agent cannot be duplicated as a parallel lane'}
                onClick={onDuplicateAgent}
              >Duplicate as parallel lane</button>
              <button class="button button-danger" type="button" onClick={() => setConfirmRemove(true)}>Remove agent</button>
            </>
          )}
        </footer>
      )}
    </aside>
  );
}
