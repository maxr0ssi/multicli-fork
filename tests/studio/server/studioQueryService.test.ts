import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LocalControlPlane } from '../../../src/controlPlane/controlPlane.js';
import { createInMemoryRunLedger } from '../../../src/persistence/runLedger.js';
import { visibleRunActions } from '../../../src/studio/client/actionVisibility.js';
import { StudioQueryService } from '../../../src/studio/server/studioQueryService.js';
import {
  buildWorkflowGateApprovalPacket,
  hashWorkflowGateApprovalPacket,
} from '../../../src/workflows/approvalPacket.js';
import { agent, approval, defineWorkflow, profiles, sequence } from '../../../src/workflows/dsl.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function setup() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'multicli-studio-query-'));
  temporaryDirectories.push(workspace);
  const artifactRoot = path.join(workspace, 'artifacts');
  const controlPlane = new LocalControlPlane(createInMemoryRunLedger());
  const reviewer = profiles.opus({ id: 'opus-review', role: 'reviewer' });
  const revision = defineWorkflow({
    id: 'truthful-review',
    revision: 3,
    name: 'Truthful review',
    description: 'Inspect the real durable execution.',
    steps: sequence(
      agent('review', reviewer, 'Review {{objective}}.'),
      approval('accept', 'Accept the reviewed result.'),
    ),
  });
  const recorded = controlPlane.publishWorkflow({
    workflowId: revision.id,
    definition: revision,
  });
  const run = controlPlane.startRun({
    workflowRevisionId: recorded.id,
    workspace,
    runInput: { objective: 'Build the operator workspace' },
  }).run;
  const service = new StudioQueryService({
    controlPlane,
    workspace,
    artifactRoot,
    now: () => new Date('2026-08-09T12:00:00.500Z'),
  });
  return { artifactRoot, controlPlane, recorded, revision, run, service, workspace };
}

describe('StudioQueryService', () => {
  it('projects the immutable DAG, reducer state, and durable active lease', () => {
    const { controlPlane, recorded, run, service } = setup();
    const scheduled = controlPlane.scheduleNodeAttempt({
      runId: run.id,
      nodeId: 'review',
      idempotencyKey: `${run.id}:review:1`,
    });
    controlPlane.claimNodeAttempt({
      id: scheduled.id,
      workerId: 'worker-a',
      leaseMs: 60_000,
      now: '2026-08-09T12:00:00.000Z',
    });

    const view = service.getRunView(run.id);

    expect(view.workflow).toMatchObject({
      recordId: recorded.id,
      workflowId: 'truthful-review',
      logicalRevision: 3,
      name: 'Truthful review',
    });
    expect(view.workflow.nodes.map(node => node.id)).toEqual(['review', 'accept', 'complete']);
    expect(view.execution.nodes.review).toMatchObject({
      status: 'running',
      activeAttemptId: scheduled.id,
      attempts: [{
        id: scheduled.id,
        status: 'running',
        lease: {
          state: 'active',
          lastRenewedAt: '2026-08-09T12:00:00.000Z',
          expiresAt: '2026-08-09T12:01:00.000Z',
        },
      }],
    });
    expect(view.execution.integrity).toEqual({ state: 'ok', issues: [] });
    expect(view.run.allowedActions).toMatchObject({
      pause: { allowed: true },
      resume: { allowed: false },
      cancel: { allowed: true },
      openGoalSession: { allowed: false },
    });
    expect(view.events.map(event => event.type)).toEqual([
      'run.started', 'node.queued', 'node.started',
    ]);
    controlPlane.close();
  });

  it('projects only provider-reported usage and its coverage', () => {
    const { controlPlane, run, service } = setup();
    const scheduled = controlPlane.scheduleNodeAttempt({
      runId: run.id,
      nodeId: 'review',
      idempotencyKey: `${run.id}:review:usage`,
    });
    controlPlane.claimNodeAttempt({
      id: scheduled.id,
      workerId: 'worker-usage',
      leaseMs: 60_000,
      now: '2026-08-09T12:00:00.000Z',
    });
    controlPlane.completeNodeAttempt({
      id: scheduled.id,
      workerId: 'worker-usage',
      status: 'succeeded',
      usage: {
        inputTokens: 12_000,
        cachedInputTokens: 9_000,
        outputTokens: 640,
        reasoningOutputTokens: 510,
      },
      now: '2026-08-09T12:00:00.250Z',
    });

    const view = service.getRunView(run.id);
    expect(view.execution.budget.usage).toMatchObject({
      modelCalls: 1,
      usageReports: 1,
      inputTokens: 12_000,
      cachedInputTokens: 9_000,
      outputTokens: 640,
      reasoningOutputTokens: 510,
    });
    expect(view.execution.nodes.review.attempts[0].usage).toEqual({
      inputTokens: 12_000,
      cachedInputTokens: 9_000,
      outputTokens: 640,
      reasoningOutputTokens: 510,
    });
    controlPlane.close();
  });

  it('offers approval decisions instead of a false resume command at a manual gate', () => {
    const { controlPlane, run, service } = setup();
    const attempt = controlPlane.scheduleNodeAttempt({
      runId: run.id, nodeId: 'review', idempotencyKey: `${run.id}:review:gate`,
    });
    controlPlane.claimNodeAttempt({ id: attempt.id, workerId: 'gate-worker', leaseMs: 60_000 });
    controlPlane.completeNodeAttempt({
      id: attempt.id, workerId: 'gate-worker', status: 'succeeded',
    });
    controlPlane.pauseRun(run.id);
    expect(service.getRunView(run.id).run.allowedActions.resume).toEqual({ allowed: true });
    controlPlane.resumeRun(run.id);
    controlPlane.requestApproval({
      runId: run.id,
      risk: 'workflow-completion',
      actionHash: 'manual-gate-action',
      payload: { kind: 'workflow-gate', nodeId: 'accept' },
    });
    controlPlane.appendEvent(run.id, 'run.waiting', {
      reason: 'manual workflow gate', nodeId: 'accept',
    });

    const view = service.getRunView(run.id);
    expect(view.run.allowedActions.resume).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('approval'),
    });
    expect(visibleRunActions(view)).toEqual(['cancel']);
    expect(() => controlPlane.resumeRun(run.id)).toThrow(/waiting for approval/);
    expect(controlPlane.ledger.getRun(run.id)?.status).toBe('waiting');
    controlPlane.close();
  });

  it('returns a useful workflow library and binds approval context to its exact packet', () => {
    const { controlPlane, recorded, run, service } = setup();
    const packet = buildWorkflowGateApprovalPacket({
      workflowRevisionId: recorded.id,
      workflowId: 'truthful-review',
      workflowContentHash: recorded.contentHash,
      runId: run.id,
      gateId: 'accept',
      gatePrompt: 'Accept the reviewed result.',
      artifacts: [{
        id: 'artifact-reviewed',
        contentHash: 'abc123',
        mediaType: 'text/markdown',
      }],
      harnessEvidence: [{
        sequence: 9,
        invocationId: 'harness-reviewed',
        outcome: 'pass',
        checks: [],
        findingsCount: 0,
      }],
    });
    controlPlane.requestApproval({
      runId: run.id,
      risk: 'workflow-completion',
      actionHash: hashWorkflowGateApprovalPacket(packet),
      payload: packet,
    });

    const bootstrap = service.bootstrap();
    const view = service.getRunView(run.id);

    expect(bootstrap).toMatchObject({
      schemaVersion: 1,
      workspace: expect.stringContaining('multicli-studio-query-'),
      pendingApprovalCount: 1,
      capabilities: { inFlightSteering: false, artifactPreview: true },
      workflows: [{
        recordId: recorded.id,
        logicalRevision: 3,
        nodeCount: 3,
        agentCount: 1,
        providers: ['claude'],
        models: ['claude-opus-5'],
        workspaceAccess: ['read-only'],
        writerAgentCount: 0,
        enableSubagents: false,
      }],
    });
    expect(view.approvals[0].context).toEqual({
      kind: 'workflow-gate',
      nodeId: 'accept',
      prompt: 'Accept the reviewed result.',
      artifactIds: ['artifact-reviewed'],
      harnessInvocationIds: ['harness-reviewed'],
    });
    controlPlane.close();
  });

  it('isolates legacy harness records from the DAG workspace without losing valid runs', () => {
    const { controlPlane, recorded, run, service } = setup();
    const harnessRevision = controlPlane.publishWorkflow({
      workflowId: 'multicli-repository-harness',
      definition: {
        id: 'multicli-repository-harness',
        name: 'Multi-CLI repository harness',
        trigger: 'manual',
        checks: [],
      },
    });
    const harnessRun = controlPlane.startRun({
      workflowRevisionId: harnessRevision.id,
      workspace: run.workspace!,
      runInput: { trigger: 'manual' },
    }).run;
    controlPlane.requestApproval({
      runId: harnessRun.id,
      risk: 'legacy-harness',
      actionHash: 'legacy-harness-action',
    });

    const bootstrap = service.bootstrap(1);

    expect(bootstrap.runs.map(summary => summary.id)).toEqual([run.id]);
    expect(bootstrap.workflows.map(workflow => workflow.recordId)).toEqual([recorded.id]);
    expect(bootstrap.pendingApprovalCount).toBe(0);
    expect(() => service.getWorkflow(harnessRevision.id)).toThrow(/Invalid workflow revision/);
    expect(() => service.getRunView(harnessRun.id)).toThrow(/Invalid workflow revision/);
    controlPlane.close();
  });

  it('reports permanent-session identity and turn lease without claiming in-flight steering', () => {
    const { artifactRoot, controlPlane, run, workspace } = setup();
    const goal = controlPlane.ledger.createGoalSession({
      runId: run.id,
      profileId: 'sol-director',
      provider: 'codex',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      workspaceAccess: 'read-only',
      selection: 'default',
      enableSubagents: false,
      cwd: workspace,
      goalArtifact: {
        contentHash: 'goal-hash',
        mediaType: 'text/markdown',
        name: 'Goal',
        location: path.join(artifactRoot, 'goal.md'),
        metadata: { private: true },
      },
    });
    controlPlane.ledger.claimGoalSessionTurn({
      id: goal.id,
      owner: 'goal-worker',
      leaseMs: 60_000,
      now: '2026-08-09T12:00:00.000Z',
    });
    const service = new StudioQueryService({
      controlPlane,
      workspace,
      artifactRoot,
      goalSessionsEnabled: true,
      now: () => new Date('2026-08-09T12:00:00.500Z'),
    });

    expect(service.getRunView(run.id).goalSessions[0]).toMatchObject({
      id: goal.id,
      provider: 'codex',
      model: 'gpt-5.6-sol',
      turnState: 'running',
      turnLease: { state: 'active', expiresAt: '2026-08-09T12:01:00.000Z' },
      allowedActions: {
        sendInstruction: { allowed: false },
        close: { allowed: false },
      },
    });
    expect(service.bootstrap().capabilities).toMatchObject({
      goalSessions: true,
      inFlightSteering: false,
    });
    controlPlane.close();
  });

  it('offers a separate persistent continuation after the workflow is terminal', () => {
    const { artifactRoot, controlPlane, run, workspace } = setup();
    controlPlane.appendEvent(run.id, 'run.failed', { reason: 'Original one-shot failed' });
    const service = new StudioQueryService({
      controlPlane,
      workspace,
      artifactRoot,
      goalSessionsEnabled: true,
    });

    expect(service.getRunView(run.id).run.allowedActions).toMatchObject({
      cancel: { allowed: false },
      openGoalSession: { allowed: true },
    });
    controlPlane.close();
  });

  it('previews only a contained, hash-matching text artifact without disclosing its path', () => {
    const { artifactRoot, controlPlane, run, service } = setup();
    const directory = path.join(artifactRoot, run.id);
    fs.mkdirSync(directory, { recursive: true });
    const location = path.join(directory, 'review-1.md');
    const content = '# Verified output\n\nEverything is local.';
    fs.writeFileSync(location, content);
    const artifact = controlPlane.recordArtifact({
      runId: run.id,
      contentHash: createHash('sha256').update(content).digest('hex'),
      mediaType: 'text/markdown',
      name: 'Review result',
      location,
    });

    const preview = service.getArtifactPreview(run.id, artifact.id);

    expect(preview).toMatchObject({
      text: content,
      truncated: false,
      totalBytes: Buffer.byteLength(content),
      artifact: { id: artifact.id, preview: { allowed: true } },
    });
    expect(JSON.stringify(preview)).not.toContain(location);
    fs.writeFileSync(location, `${content}\ntampered`);
    expect(() => service.getArtifactPreview(run.id, artifact.id)).toThrow(/integrity/);
    controlPlane.close();
  });
});
