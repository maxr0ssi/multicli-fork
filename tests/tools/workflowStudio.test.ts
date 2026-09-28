import { describe, expect, it } from 'vitest';

import {
  getWorkflowRunTool,
  listWorkflowRunsTool,
  startLunaBuildCouncilTool,
  workflowRunStudioCommand,
} from '../../src/tools/workflow-studio.tool.js';

describe('workflow Studio tools', () => {
  it('exposes a bounded Luna MAX council and read-only run inspection tools', () => {
    const startSchema = startLunaBuildCouncilTool.zodSchema.parse({
      objective: 'Build it',
    });
    expect(startSchema).toMatchObject({ objective: 'Build it', builderCount: 5 });
    expect(() => startLunaBuildCouncilTool.zodSchema.parse({
      objective: 'Too many',
      builderCount: 21,
    })).toThrow();
    expect(listWorkflowRunsTool.name).toBe('List-Workflow-Runs');
    expect(getWorkflowRunTool.name).toBe('Get-Workflow-Run');
    expect(startLunaBuildCouncilTool.description).toContain('CLI-owned authentication');
    expect(workflowRunStudioCommand('run-123')).toBe('multicli studio --run run-123');
    expect(workflowRunStudioCommand(
      'run-123',
      '/tmp/Workspace with spaces',
      '/tmp/stores/custom.sqlite',
    )).toBe(
      "multicli studio --run run-123 --workspace '/tmp/Workspace with spaces' "
      + '--store /tmp/stores/custom.sqlite',
    );
  });
});
