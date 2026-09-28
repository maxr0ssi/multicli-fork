/**
 * Side-effect-free package entrypoint.
 *
 * Importing this module never starts an MCP transport, HTTP server, service,
 * browser, or workflow worker. Callers explicitly construct a local runtime.
 */

export {
  LocalOrchestrator,
  createLocalOrchestrator,
  type CreateLocalOrchestratorOptions,
  type ExistingLocalRun,
  type LocalApprovalDecision,
  type LocalOrchestratorDependencies,
  type LocalOrchestratorRunner,
  type LocalRunOptions,
  type LocalWorkflowReference,
  type OpenLocalGoalInput,
} from './localOrchestrator.js';

export * from './workflows/index.js';

export {
  WorkflowDraftService,
  createWorkflowDraftService,
  describeWorkflowDraftDesign,
  jsonValueSchema,
  proposedWorkflowRunInputSchema,
  workflowDraftDefinitionSchema,
  workflowDraftProposalSchema,
  type JsonValue,
  type ProposedWorkflowRunInput,
  type WorkflowDraftProposalHandoff,
  type WorkflowDraftProposalInput,
  type WorkflowDraftProposalResult,
  type WorkflowDraftStudioAvailability,
} from './workflowDraftService.js';

export {
  LocalControlPlane,
  type RunEventListener,
  type RunSnapshot,
} from './controlPlane/controlPlane.js';

export {
  type PublishedWorkflowDraftView,
  type WorkflowDraftSummary,
  type WorkflowDraftUpdateResult,
  type WorkflowDraftView,
} from './controlPlane/workflowDrafts.js';

export {
  type WorkflowDraftCapabilities,
  type WorkflowDraftProviderCapability,
} from './controlPlane/workflowDraftCapabilities.js';

export {
  SqliteRunLedger,
  WorkflowDraftValidationError,
  WorkflowDraftVersionConflictError,
  createInMemoryRunLedger,
  type AppendEventOptions,
  type ApprovalRecord,
  type ArtifactRecord,
  type DurableNodeAttemptRecord,
  type DurableRunEvent,
  type DurableRunRecord,
  type CreateWorkflowDraftInput,
  type GoalSessionArtifactKind,
  type GoalSessionArtifactRecord,
  type GoalSessionRecord,
  type GoalSessionStatus,
  type GoalSessionStore,
  type GoalSessionTurnState,
  type RunLedger,
  type RunStatus as DurableRunStatus,
  type WorkflowRevisionRecord,
  type PublishedWorkflowDraft,
  type PublishedAndStartedWorkflowDraft,
  type PublishAndStartWorkflowDraftInput,
  type PublishWorkflowDraftInput,
  type UpdateWorkflowDraftInput,
  type WorkflowDraftRecord,
} from './persistence/runLedger.js';

export {
  evaluateHarness,
  runHarness,
  resolveHarnessProfile,
  runRepositoryHarness,
  type HarnessEvaluationOptions,
  type HarnessFinding,
  type HarnessRequest,
  type HarnessResult,
  type RepositoryHarnessReport,
} from './harness/index.js';
