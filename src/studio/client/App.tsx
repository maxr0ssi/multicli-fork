import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import { StudioApi } from './api.js';
import { RunsSidebar } from './features/runs/RunsSidebar.js';
import { RunWorkspace } from './features/runs/RunWorkspace.js';
import { WorkflowLauncher } from './features/launcher/WorkflowLauncher.js';
import { WorkflowDraftEditor } from './features/editor/WorkflowDraftEditor.js';
import type { WorkflowDraftCapabilities } from '../../controlPlane/workflowDraftCapabilities.js';
import type {
  PublishedWorkflowDraftView,
  WorkflowDraftView,
} from '../../controlPlane/workflowDrafts.js';
import type {
  StudioApproval,
  StudioBootstrap,
  StudioRunAction,
  StudioRunView,
} from './types.js';
import {
  readStudioSelection,
  writeStudioSelection,
} from './urlState.js';
import { mergeSelectedRunView, refreshStudio } from './refresh.js';
import {
  initialRunTarget,
  loadRunTarget,
  runTargetError,
} from './targetedLaunch.js';

type ThemeChoice = 'system' | 'light' | 'dark';

const api = new StudioApi();

function initialTheme(): ThemeChoice {
  const saved = localStorage.getItem('multicli-studio-theme');
  return saved === 'light' || saved === 'dark' ? saved : 'system';
}

export function App() {
  const initialSelection = readStudioSelection(window.location);
  const [overview, setOverview] = useState<StudioBootstrap>();
  const [view, setView] = useState<StudioRunView>();
  const [runId, setRunId] = useState(initialSelection.runId);
  const [nodeId, setNodeId] = useState(initialSelection.nodeId);
  const [theme, setTheme] = useState<ThemeChoice>(initialTheme);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [busyAction, setBusyAction] = useState<StudioRunAction>();
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [launcherBusy, setLauncherBusy] = useState(false);
  const [launcherError, setLauncherError] = useState<string>();
  const [syncIssue, setSyncIssue] = useState<string>();
  const [draft, setDraft] = useState<WorkflowDraftView>();
  const [draftCapabilities, setDraftCapabilities] = useState<WorkflowDraftCapabilities>();
  const requestNumber = useRef(0);
  const selectedRun = useRef(initialSelection.runId);
  const refreshTimer = useRef<number>();
  const launcherReturnFocus = useRef<HTMLElement | null>(null);

  const loadOverview = useCallback(async () => {
    const next = await api.overview();
    setOverview(next);
    return next;
  }, []);

  const loadRun = useCallback(async (selectedRunId: string) => {
    const request = requestNumber.current + 1;
    requestNumber.current = request;
    const next = await api.run(selectedRunId);
    if (request === requestNumber.current) {
      setView(current => mergeSelectedRunView(current, next, selectedRunId));
    }
    return next;
  }, []);

  const loadDraft = useCallback(async (draftId: string) => {
    const [nextDraft, capabilities] = await Promise.all([
      api.workflowDraft(draftId),
      api.workflowDraftCapabilities(),
    ]);
    setDraft(nextDraft);
    setDraftCapabilities(capabilities);
    writeStudioSelection(window.history, window.location, { draftId: nextDraft.id });
    return nextDraft;
  }, []);

  const selectRun = useCallback((selectedRunId: string, selectedNodeId?: string) => {
    selectedRun.current = selectedRunId;
    setRunId(selectedRunId);
    setNodeId(selectedNodeId);
    setView(undefined);
    writeStudioSelection(window.history, window.location, {
      runId: selectedRunId,
      nodeId: selectedNodeId,
    });
    setLoading(true);
    setPageError(undefined);
    setActionError(undefined);
    void loadRunTarget({ run: loadRun }, { runId: selectedRunId, nodeId: selectedNodeId })
      .then(loaded => {
        if (selectedRun.current !== selectedRunId) return;
        setNodeId(loaded.nodeId);
        setActionError(loaded.nodeIssue);
        writeStudioSelection(window.history, window.location, {
          runId: selectedRunId,
          nodeId: loaded.nodeId,
        });
      })
      .catch(reason => {
        if (selectedRun.current === selectedRunId) {
          setPageError(runTargetError(selectedRunId, reason));
        }
      })
      .finally(() => {
        if (selectedRun.current === selectedRunId) setLoading(false);
      });
  }, [loadRun]);

  const refreshSelectedRun = useCallback(async () => {
    if (!runId) return;
    await Promise.all([loadRun(runId), loadOverview()]);
  }, [loadOverview, loadRun, runId]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('multicli-studio-theme', theme);
  }, [theme]);

  const openLauncher = () => {
    launcherReturnFocus.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setLauncherOpen(true);
  };
  useEffect(() => {
    if (launcherOpen || !launcherReturnFocus.current) return;
    launcherReturnFocus.current.focus();
    launcherReturnFocus.current = null;
  }, [launcherOpen]);

  useEffect(() => {
    let active = true;
    void api.connect()
      .then(loadOverview)
      .then(async next => {
        if (!active) return;
        if (initialSelection.draftId) {
          await loadDraft(initialSelection.draftId);
          if (active) setLoading(false);
          return;
        }
        const target = initialRunTarget(next, initialSelection);
        if (target) selectRun(target.runId, target.nodeId);
        else setLoading(false);
      })
      .catch(reason => {
        if (!active) return;
        setPageError(reason instanceof Error ? reason.message : String(reason));
        setLoading(false);
      });
    return () => { active = false; };
  }, [loadDraft, loadOverview, selectRun]);

  useEffect(() => {
    if (!view) return undefined;
    return api.events(view.run.id, view.run.lastSequence, () => {
      setSyncIssue(undefined);
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => {
        void refreshSelectedRun().catch(() => undefined);
      }, 120);
    }, () => setSyncIssue('Live updates disconnected. Polling continues every five seconds.'));
  }, [refreshSelectedRun, view?.run.id, view?.run.lastSequence]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshStudio(api, runId)
        .then(refreshed => {
          setSyncIssue(undefined);
          setOverview(refreshed.overview);
          if (refreshed.view && runId) {
            setView(current => mergeSelectedRunView(current, refreshed.view!, runId));
          }
        })
        .catch(() => setSyncIssue('Run status could not be refreshed. Displayed data may be stale.'));
    }, 5000);
    return () => window.clearInterval(timer);
  }, [loadOverview, loadRun, runId]);

  const selectNode = (selectedNodeId?: string) => {
    setNodeId(selectedNodeId);
    writeStudioSelection(window.history, window.location, {
      runId,
      nodeId: selectedNodeId,
    });
  };
  const controlRun = async (action: StudioRunAction) => {
    if (!view) return;
    setBusyAction(action);
    setActionError(undefined);
    try {
      await api.controlRun(view.run.id, action);
      await refreshSelectedRun();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyAction(undefined);
    }
  };
  const resolveApproval = async (
    approval: StudioApproval,
    decision: 'approved' | 'denied',
  ) => {
    await api.resolveApproval(approval.id, decision, approval.actionHash);
    await refreshSelectedRun();
  };
  const startWorkflow = async (revisionId: string, objective: string) => {
    setLauncherBusy(true);
    setLauncherError(undefined);
    try {
      const started = await api.startRun(revisionId, { objective });
      setLauncherOpen(false);
      await loadOverview();
      selectRun(started.run.id);
    } catch (reason) {
      setLauncherError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLauncherBusy(false);
    }
  };
  const editPublishedWorkflow = async (revisionId: string) => {
    setActionError(undefined);
    try {
      const [nextDraft, capabilities] = await Promise.all([
        api.createWorkflowDraft(revisionId),
        api.workflowDraftCapabilities(),
      ]);
      setDraft(nextDraft);
      setDraftCapabilities(capabilities);
      writeStudioSelection(window.history, window.location, { draftId: nextDraft.id });
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const closeDraft = () => {
    setDraft(undefined);
    setDraftCapabilities(undefined);
    const fallback = runId ?? overview?.runs[0]?.id;
    if (fallback) selectRun(fallback);
    else writeStudioSelection(window.history, window.location, {});
  };
  const draftChanged = (next: WorkflowDraftView) => {
    setDraft(next);
    writeStudioSelection(window.history, window.location, { draftId: next.id });
  };
  const draftPublished = (_result: PublishedWorkflowDraftView) => {
    void loadOverview().catch(() => undefined);
  };

  return (
    <div class="app-shell">
      <header class="app-header">
        <a class="product-name" href="/studio">Multi-CLI Studio</a>
        <label class="theme-control">
          <span>Theme</span>
          <select value={theme} onChange={event => setTheme(event.currentTarget.value as ThemeChoice)}>
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
      </header>
      <div class="app-body">
        {overview && (
          <RunsSidebar
            runs={overview.runs}
            selectedRunId={runId}
            canLaunch={overview.workflows.length > 0}
            onSelect={selectRun}
            onLaunch={openLauncher}
          />
        )}
        {loading && <main class="page-state" aria-live="polite">Loading run…</main>}
        {!loading && pageError && <main class="page-state notice notice-danger" role="alert">{pageError}</main>}
        {!loading && !pageError && view && (
          <RunWorkspace
            api={api}
            view={view}
            selectedNodeId={nodeId}
            busyAction={busyAction}
            actionError={actionError}
            syncIssue={syncIssue}
            onSelectNode={selectNode}
            onRunAction={action => void controlRun(action)}
            onApproval={resolveApproval}
            onGoalInstruction={async (sessionId, instruction) => {
              await api.sendGoalInstruction(sessionId, instruction);
              await refreshSelectedRun();
            }}
            onCloseGoalSession={async sessionId => {
              await api.closeGoalSession(sessionId);
              await refreshSelectedRun();
            }}
            onOpenGoalSession={async (profileId, goal) => {
              await api.openGoalSession(view.run.id, profileId, goal);
              await refreshSelectedRun();
            }}
            onEditWorkflow={revisionId => void editPublishedWorkflow(revisionId)}
          />
        )}
        {!loading && !pageError && overview?.runs.length === 0 && (
          <main class="page-state">
            <h1>No workflow runs yet</h1>
            <p>Start a published workflow to see its graph and outputs here.</p>
            {overview.workflows.length > 0 && (
              <button class="button button-primary" type="button" onClick={openLauncher}>
                New workflow
              </button>
            )}
          </main>
        )}
      </div>
      {launcherOpen && overview && (
        <WorkflowLauncher
          workflows={overview.workflows}
          busy={launcherBusy}
          error={launcherError}
          onClose={() => setLauncherOpen(false)}
          onStart={startWorkflow}
        />
      )}
      {draft && draftCapabilities && (
        <WorkflowDraftEditor
          api={api}
          initialDraft={draft}
          capabilities={draftCapabilities}
          onDraftChanged={draftChanged}
          onPublished={draftPublished}
          onRunStarted={startedRunId => {
            setDraft(undefined);
            setDraftCapabilities(undefined);
            selectRun(startedRunId);
          }}
          onClose={closeDraft}
        />
      )}
      <div class="live-region" aria-live="polite" aria-atomic="true" />
    </div>
  );
}
