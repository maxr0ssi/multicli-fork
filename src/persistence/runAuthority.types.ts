export interface WorkflowRunnerAuthorityRecord {
  workspace: string;
  owner: string;
  acquiredAt: string;
  leaseExpiresAt: string;
  updatedAt: string;
}

export interface ClaimWorkflowRunnerAuthorityInput {
  workspace: string;
  owner: string;
  leaseMs: number;
  now?: string;
}

export type RenewWorkflowRunnerAuthorityInput = ClaimWorkflowRunnerAuthorityInput;

export interface ReleaseWorkflowRunnerAuthorityInput {
  workspace: string;
  owner: string;
}
