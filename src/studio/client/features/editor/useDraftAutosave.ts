import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import type { WorkflowDraftView } from '../../../../controlPlane/workflowDrafts.js';
import type { WorkflowDraftDefinition } from '../../../../workflows/drafts.js';
import {
  type StudioApi,
  type WorkflowDraftConflictRecovery,
  workflowDraftConflictRecovery,
} from '../../api.js';

export async function persistConflictAsNewDraft(
  api: StudioApi,
  recovery: WorkflowDraftConflictRecovery,
  definition: WorkflowDraftDefinition,
  proposedRunInput: unknown,
  onSaved: (draft: WorkflowDraftView) => void,
): Promise<WorkflowDraftView> {
  const next = await api.saveWorkflowDraftConflictAsNewDraft(
    recovery,
    definition,
    proposedRunInput,
  );
  onSaved(next);
  return next;
}

export function useDraftAutosave(
  api: StudioApi,
  initialDraft: WorkflowDraftView,
  onDraftChanged: (draft: WorkflowDraftView) => void,
) {
  const [draft, setDraft] = useState(initialDraft);
  const [definition, setDefinition] = useState(initialDraft.definition);
  const [proposedRunInput, setProposedRunInput] = useState(initialDraft.proposedRunInput);
  const [editVersion, setEditVersion] = useState(0);
  const [savedEditVersion, setSavedEditVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [saveConflict, setSaveConflict] = useState<WorkflowDraftConflictRecovery>();
  const draftRef = useRef(initialDraft);
  const definitionRef = useRef(initialDraft.definition);
  const proposedRunInputRef = useRef(initialDraft.proposedRunInput);
  const editVersionRef = useRef(0);
  const savedEditVersionRef = useRef(0);
  const savePromise = useRef<Promise<void>>();
  const saveConflictRef = useRef<WorkflowDraftConflictRecovery>();
  const dirty = editVersion !== savedEditVersion;

  const replaceDraft = useCallback((next: WorkflowDraftView) => {
    draftRef.current = next;
    definitionRef.current = next.definition;
    proposedRunInputRef.current = next.proposedRunInput;
    editVersionRef.current = 0;
    savedEditVersionRef.current = 0;
    setDraft(next);
    setDefinition(next.definition);
    setProposedRunInput(next.proposedRunInput);
    setEditVersion(0);
    setSavedEditVersion(0);
    setSaveError(undefined);
    saveConflictRef.current = undefined;
    setSaveConflict(undefined);
    onDraftChanged(next);
  }, [onDraftChanged]);

  useEffect(() => {
    if (initialDraft.id !== draftRef.current.id) replaceDraft(initialDraft);
  }, [initialDraft, replaceDraft]);

  const markEdited = () => {
    const nextVersion = editVersionRef.current + 1;
    editVersionRef.current = nextVersion;
    setEditVersion(nextVersion);
    if (!saveConflictRef.current) setSaveError(undefined);
  };
  const changeDefinition = (next: WorkflowDraftDefinition) => {
    definitionRef.current = next;
    setDefinition(next);
    markEdited();
  };
  const changeProposedRunInput = (next: unknown) => {
    proposedRunInputRef.current = next;
    setProposedRunInput(next);
    markEdited();
  };

  const saveLatest = useCallback(async (): Promise<WorkflowDraftView> => {
    while (savedEditVersionRef.current < editVersionRef.current) {
      if (savePromise.current) {
        await savePromise.current;
        continue;
      }
      const savingVersion = editVersionRef.current;
      const savingDefinition = definitionRef.current;
      const savingRunInput = proposedRunInputRef.current;
      const currentDraft = draftRef.current;
      const request = (async () => {
        setSaving(true);
        setSaveError(undefined);
        const result = await api.updateWorkflowDraft(
          currentDraft.id,
          currentDraft.version,
          savingDefinition,
          savingRunInput,
        );
        draftRef.current = result.draft;
        savedEditVersionRef.current = savingVersion;
        setDraft(result.draft);
        setSavedEditVersion(savingVersion);
        saveConflictRef.current = undefined;
        setSaveConflict(undefined);
        if (editVersionRef.current === savingVersion) {
          definitionRef.current = result.draft.definition;
          setDefinition(result.draft.definition);
        }
        onDraftChanged(result.draft);
      })();
      savePromise.current = request;
      try {
        await request;
      } catch (reason) {
        const conflict = workflowDraftConflictRecovery(reason);
        saveConflictRef.current = conflict;
        setSaveConflict(conflict);
        setSaveError(reason instanceof Error ? reason.message : String(reason));
        throw reason;
      } finally {
        savePromise.current = undefined;
        setSaving(false);
      }
    }
    return draftRef.current;
  }, [api, onDraftChanged]);

  const saveAsNewDraft = useCallback(async (): Promise<WorkflowDraftView> => {
    const recovery = saveConflictRef.current;
    if (!recovery) throw new Error('This save failure does not offer draft recovery');
    setSaving(true);
    setSaveError(undefined);
    try {
      return await persistConflictAsNewDraft(
        api,
        recovery,
        definitionRef.current,
        proposedRunInputRef.current,
        replaceDraft,
      );
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    } finally {
      setSaving(false);
    }
  }, [api, replaceDraft]);

  useEffect(() => {
    if (!dirty || draft.publishedRevisionId || saveError) return undefined;
    const timer = window.setTimeout(() => void saveLatest().catch(() => undefined), 450);
    return () => window.clearTimeout(timer);
  }, [dirty, draft.publishedRevisionId, editVersion, saveError, saveLatest]);

  useEffect(() => {
    if (!dirty && !saving) return undefined;
    const protectUnsavedDraft = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', protectUnsavedDraft);
    return () => window.removeEventListener('beforeunload', protectUnsavedDraft);
  }, [dirty, saving]);

  return {
    draft,
    definition,
    proposedRunInput,
    dirty,
    saving,
    saveError,
    saveConflict,
    changeDefinition,
    changeProposedRunInput,
    replaceDraft,
    saveLatest,
    saveAsNewDraft,
  };
}
