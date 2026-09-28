import type { ToolExecutionContext } from '../execution.js';
import type { Logger } from '../logger.js';
import { executeClaudeCLI } from '../utils/claudeExecutor.js';
import { executeCodexCLI } from '../utils/codexExecutor.js';
import type { AttemptUsage, ResolvedProfile } from './domain.js';

export interface ProviderExecutionRequest {
  profile: ResolvedProfile;
  prompt: string;
  cwd: string;
  signal?: AbortSignal;
  /** Process liveness, independent of model text/progress. */
  onHeartbeat?: () => void;
  heartbeatMs?: number;
  /** Explicit provider-native conversation lifecycle; omitted for a stateless call. */
  session?:
    | { mode: 'start'; sessionId?: string }
    | { mode: 'resume'; sessionId: string };
}

export interface ProviderExecutionResult {
  text: string;
  sessionId?: string;
  /** Present only when the provider emitted structured usage for this invocation. */
  usage?: AttemptUsage;
}

export interface WorkflowProviderExecutor {
  execute(request: ProviderExecutionRequest): Promise<ProviderExecutionResult>;
}

export class LocalSubscriptionCliExecutor implements WorkflowProviderExecutor {
  constructor(
    private readonly options: {
      /** Optional last-resort wall-clock ceiling; silence alone never triggers it. */
      timeoutMs?: number;
      killGraceMs: number;
      logger?: Logger;
    },
  ) {}

  async execute(request: ProviderExecutionRequest): Promise<ProviderExecutionResult> {
    const context: ToolExecutionContext = {
      cwd: request.cwd,
      timeoutMs: this.options.timeoutMs,
      killGraceMs: this.options.killGraceMs,
      signal: request.signal,
      onHeartbeat: request.onHeartbeat,
      heartbeatMs: request.heartbeatMs,
      logger: this.options.logger,
    };
    if (request.profile.provider === 'codex') {
      if (request.session?.mode === 'start' && request.session.sessionId) {
        throw new Error('Codex chooses its native session id when a session starts');
      }
      return executeCodexCLI(
        request.prompt,
        request.profile.model,
        request.profile.workspaceAccess,
        undefined,
        context,
        request.session?.mode === 'resume' ? request.session.sessionId : undefined,
        {
          effort: request.profile.reasoningEffort,
          enableSubagents: request.profile.enableSubagents,
          captureUsage: true,
        },
      );
    }
    if (request.profile.provider === 'claude') {
      if (request.profile.workspaceAccess === 'danger-full-access') {
        throw new Error('Claude danger-full-access is not available to workflow profiles');
      }
      return executeClaudeCLI(
        request.prompt,
        request.profile.model,
        request.profile.workspaceAccess === 'workspace-write' ? 'acceptEdits' : 'plan',
        undefined,
        undefined,
        context,
        request.session?.mode === 'start' ? request.session.sessionId : undefined,
        request.session?.mode === 'resume' ? request.session.sessionId : undefined,
        {
          effort: request.profile.reasoningEffort,
          enableSubagents: request.profile.enableSubagents,
          captureUsage: true,
        },
      );
    }
    throw new Error(
      `No local provider CLI adapter is registered for provider ${request.profile.provider}`,
    );
  }
}
