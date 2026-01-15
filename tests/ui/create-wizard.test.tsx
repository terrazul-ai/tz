import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type CreateOptions, type CreateResult } from '../../src/core/package-creator';
import { CreateWizard } from '../../src/ui/create/CreateWizard';

const baseOptions: CreateOptions = {
  name: '@local/sample-package',
  description: '',
  license: 'MIT',
  version: '0.0.0',
  targetDir: '/work/sample-package',
  tools: [],
  includeExamples: false,
  includeHooks: false,
  dryRun: false,
};

const noopResult: CreateResult = {
  created: [],
  targetDir: '/work/sample-package',
  summary: {
    packageName: '@local/sample-package',
    version: '0.0.0',
    toolCount: 0,
    fileCount: 0,
  },
};

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  isVerbose: () => false,
};

afterEach(() => {
  vi.useRealTimers();
});

describe('CreateWizard', () => {
  it('walks through steps and executes with selected options', async () => {
    const execute = vi.fn(async () => noopResult);
    const onComplete = vi.fn();

    render(
      <CreateWizard
        baseOptions={baseOptions}
        execute={execute}
        logger={noopLogger}
        onComplete={onComplete}
        automationScript={{
          description: 'My package description',
          license: 'Apache-2.0',
          tools: ['claude', 'codex'],
          includeExamples: true,
          includeHooks: true,
        }}
      />,
    );

    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalled();
    });

    const call = execute.mock.calls[0][0] as CreateOptions;
    expect(call.description).toBe('My package description');
    expect(call.license).toBe('Apache-2.0');
    expect(call.tools).toEqual(['claude', 'codex']);
    expect(call.includeExamples).toBe(true);
    expect(call.includeHooks).toBe(true);

    await vi.waitFor(() => {
      expect(onComplete).toHaveBeenCalled();
    });
  });

  it('handles cancellation with escape key', async () => {
    const onCancel = vi.fn();

    render(
      <CreateWizard
        baseOptions={baseOptions}
        execute={async () => noopResult}
        logger={noopLogger}
        onCancel={onCancel}
        automationScript={{ cancel: true, submit: false }}
      />,
    );

    await vi.waitFor(
      () => {
        expect(onCancel).toHaveBeenCalled();
      },
      { interval: 25, timeout: 1000 },
    );
  });
});
