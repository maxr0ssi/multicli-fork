import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import * as api from '../src/publicApi.js';

describe('package API', () => {
  it('exposes the local runtime and workflow kernel without using the executable entrypoint', () => {
    expect(api.createLocalOrchestrator).toBeTypeOf('function');
    expect(api.createWorkflowDraftService).toBeTypeOf('function');
    expect(api.describeWorkflowDraftDesign).toBeTypeOf('function');
    expect(api.workflowDraftProposalSchema).toBeTypeOf('object');
    expect(api.defineWorkflowRevision).toBeTypeOf('function');
    expect(api.runHarness).toBeTypeOf('function');

    const packageJson = JSON.parse(fs.readFileSync(
      path.resolve(process.cwd(), 'package.json'),
      'utf8',
    )) as {
      main: string;
      types: string;
      bin: Record<string, string>;
      exports: Record<string, unknown>;
    };

    expect(packageJson.main).toBe('dist/publicApi.js');
    expect(packageJson.types).toBe('dist/publicApi.d.ts');
    expect(packageJson.bin.multicli).toBe('dist/index.js');
    expect(packageJson.exports).toHaveProperty('.');
    expect(packageJson.exports).toHaveProperty('./workflows');
    expect(packageJson.exports).toHaveProperty('./harness');
  });
});
