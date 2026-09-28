import type {
  StudioActionAvailability,
  StudioApproval,
  StudioArtifactPreview,
  StudioArtifactSummary,
  StudioBootstrap,
  StudioGoalSessionSummary,
  StudioHarnessEvidence,
  StudioNodeAttempt,
  StudioNodeExecution,
  StudioRunSummary,
  StudioRunView,
  StudioWorkflowProfile,
  StudioWorkflowSummary,
} from '../contracts/studio.js';

export type StudioRunAction = 'pause' | 'resume' | 'cancel';

export type {
  StudioActionAvailability,
  StudioApproval,
  StudioArtifactPreview,
  StudioArtifactSummary,
  StudioBootstrap,
  StudioGoalSessionSummary,
  StudioHarnessEvidence,
  StudioNodeAttempt,
  StudioNodeExecution,
  StudioRunSummary,
  StudioRunView,
  StudioWorkflowProfile,
  StudioWorkflowSummary,
};

export interface StartedRunResponse {
  readonly run: { readonly id: string };
}
