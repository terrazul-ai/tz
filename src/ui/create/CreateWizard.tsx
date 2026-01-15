import path from 'node:path';

import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { getPackageDirName } from '../../core/package-creator.js';
import {
  type KeyHint,
  type SelectableListItem,
  SelectableList,
  type StatusMessage,
  WizardFrame,
} from '../extract/components.js';

import type { CreateOptions, CreateResult } from '../../core/package-creator.js';

export interface LoggerLike {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string | Error) => void;
  debug: (msg: string) => void;
  isVerbose: () => boolean;
}

export interface CreateWizardProps {
  baseOptions: CreateOptions;
  execute: (options: CreateOptions) => Promise<CreateResult>;
  logger: LoggerLike;
  onComplete?: (result: CreateResult) => void;
  onCancel?: () => void;
  automationScript?: CreateWizardAutomation;
}

type Step = 'metadata' | 'tools' | 'options' | 'preview';

interface ToolDescriptor {
  id: SelectableTool;
  label: string;
}

type SelectableTool = 'claude' | 'codex' | 'cursor' | 'copilot' | 'gemini';

export interface CreateWizardAutomation {
  name?: string;
  description?: string;
  license?: string;
  tools?: SelectableTool[];
  includeExamples?: boolean;
  includeHooks?: boolean;
  submit?: boolean;
  cancel?: boolean;
}

const TOOLS: ToolDescriptor[] = [
  { id: 'claude', label: 'claude — Claude Code compatibility' },
  { id: 'codex', label: 'codex — Codex cli compatibility' },
  { id: 'gemini', label: 'gemini — Google Gemini compatibility' },
  { id: 'cursor', label: 'cursor — Cursor workspace tooling' },
  { id: 'copilot', label: 'copilot — GitHub Copilot instructions' },
];

const OPTION_LABELS: { id: 'examples' | 'hooks'; label: string }[] = [
  { id: 'examples', label: 'Include example agents/commands' },
  { id: 'hooks', label: 'Include hooks/ directory' },
];

function slugifySegment(value: string): string {
  const lower = value.toLowerCase();
  const replaced = lower.replaceAll(/[^\da-z]+/g, '-');
  const trimmed = replaced.replaceAll(/^-+|-+$/g, '');
  return trimmed || 'package';
}

export function CreateWizard({
  baseOptions,
  execute,
  logger,
  onComplete,
  onCancel,
  automationScript,
}: CreateWizardProps): React.ReactElement {
  const { exit } = useApp();
  const [step, setStep] = useState<Step>('metadata');
  const [metadataIndex, setMetadataIndex] = useState(0);
  const [toolCursor, setToolCursor] = useState(0);
  const [optionCursor, setOptionCursor] = useState(0);
  const [name, setName] = useState(baseOptions.name);
  const [description, setDescription] = useState(baseOptions.description ?? '');
  const [license, setLicense] = useState(baseOptions.license ?? 'MIT');
  const [selectedTools, setSelectedTools] = useState<SelectableTool[]>(
    (baseOptions.tools ?? []) as SelectableTool[],
  );
  const [includeExamples, setIncludeExamples] = useState(Boolean(baseOptions.includeExamples));
  const [includeHooks, setIncludeHooks] = useState(Boolean(baseOptions.includeHooks));
  const [executing, setExecuting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [automationApplied, setAutomationApplied] = useState(false);

  const projectRoot = useMemo(() => path.dirname(baseOptions.targetDir), [baseOptions.targetDir]);

  useEffect(() => {
    setToolCursor(0);
  }, [step]);

  const targetDir = useMemo(() => {
    const segment = slugifySegment(
      getPackageDirName(name.trim().length > 0 ? name : baseOptions.name),
    );
    return path.join(projectRoot, segment);
  }, [name, baseOptions.name, projectRoot]);

  const headingTitle = useMemo(() => {
    switch (step) {
      case 'metadata': {
        return 'Package Metadata';
      }
      case 'tools': {
        return 'Tool Compatibility';
      }
      case 'options': {
        return 'Options';
      }
      default: {
        return 'Review & Confirm';
      }
    }
  }, [step]);

  const stepIndex = useMemo(() => {
    switch (step) {
      case 'metadata': {
        return 0;
      }
      case 'tools': {
        return 1;
      }
      case 'options': {
        return 2;
      }
      default: {
        return 3;
      }
    }
  }, [step]);

  const instruction = useMemo(() => {
    switch (step) {
      case 'metadata': {
        return 'Define your package identity';
      }
      case 'tools': {
        return 'Select which AI tools are supported';
      }
      case 'options': {
        return 'Configure additional scaffolding options';
      }
      default: {
        return 'Review configuration before creating the package';
      }
    }
  }, [step]);

  const actionHints: KeyHint[] = useMemo(() => {
    if (executing) {
      return [{ key: 'Esc', label: 'Cancel', hidden: true }];
    }
    switch (step) {
      case 'metadata': {
        return [
          { key: 'Enter', label: 'Next field' },
          { key: 'Tab', label: 'Next field' },
          { key: 'Shift+Tab', label: 'Previous field' },
          { key: 'Esc', label: 'Cancel', emphasis: 'danger' },
        ];
      }
      case 'tools': {
        return [
          { key: 'Space', label: 'Toggle tool' },
          { key: 'A', label: 'Select all' },
          { key: 'N', label: 'Clear all' },
          { key: 'Enter', label: 'Continue', emphasis: 'primary' },
          { key: 'Shift+Tab', label: 'Back' },
          { key: 'Esc', label: 'Cancel', emphasis: 'danger' },
        ];
      }
      case 'options': {
        return [
          { key: 'Space', label: 'Toggle option' },
          { key: 'Enter', label: 'Continue', emphasis: 'primary' },
          { key: 'Shift+Tab', label: 'Back' },
          { key: 'Esc', label: 'Cancel', emphasis: 'danger' },
        ];
      }
      default: {
        return [
          {
            key: 'Enter',
            label: baseOptions.dryRun ? 'Preview' : 'Create package',
            emphasis: 'primary',
          },
          { key: 'Shift+Tab', label: 'Back' },
          { key: 'Esc', label: 'Cancel', emphasis: 'danger' },
        ];
      }
    }
  }, [step, executing, baseOptions.dryRun]);

  const toolItems: SelectableListItem[] = useMemo(
    () =>
      TOOLS.map((tool) => ({
        id: tool.id,
        label: tool.label,
        selected: selectedTools.includes(tool.id),
      })),
    [selectedTools],
  );

  const optionItems: SelectableListItem[] = useMemo(
    () =>
      OPTION_LABELS.map((opt) => ({
        id: opt.id,
        label: opt.label,
        selected: opt.id === 'examples' ? includeExamples : includeHooks,
      })),
    [includeExamples, includeHooks],
  );

  const statusMessage: StatusMessage | null = useMemo(() => {
    if (executing) {
      return {
        kind: 'busy',
        text: baseOptions.dryRun ? 'Previewing scaffold…' : 'Creating package…',
      } satisfies StatusMessage;
    }
    if (errorMessage) {
      return { kind: 'error', text: errorMessage } satisfies StatusMessage;
    }
    if (statusNote) {
      return { kind: 'busy', text: statusNote } satisfies StatusMessage;
    }
    return null;
  }, [baseOptions.dryRun, errorMessage, executing, statusNote]);

  const proceedTo = useCallback((next: Step) => {
    setStep(next);
    setErrorMessage(null);
    if (next === 'tools') setToolCursor(0);
    if (next === 'options') setOptionCursor(0);
  }, []);

  const handleCancel = useCallback(() => {
    onCancel?.();
    exit();
  }, [exit, onCancel]);

  const buildExecutionOptions = useCallback((): CreateOptions => {
    return {
      ...baseOptions,
      name,
      description,
      license,
      targetDir,
      tools: [...selectedTools],
      includeExamples,
      includeHooks,
      dryRun: Boolean(baseOptions.dryRun),
    };
  }, [
    baseOptions,
    description,
    includeExamples,
    includeHooks,
    license,
    name,
    selectedTools,
    targetDir,
  ]);

  const handleExecute = useCallback(async () => {
    if (executing) return;
    setExecuting(true);
    setStatusNote(null);
    setErrorMessage(null);
    try {
      const result = await execute(buildExecutionOptions());
      onComplete?.(result);
      exit();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErrorMessage(message);
      logger.error(error instanceof Error ? error : message);
      setExecuting(false);
    }
  }, [buildExecutionOptions, execute, executing, exit, logger, onComplete]);

  useEffect(() => {
    if (!automationScript || automationApplied) return;

    const scriptedName = automationScript.name ?? baseOptions.name;
    const scriptDescription = automationScript.description ?? baseOptions.description ?? '';
    const scriptLicense = automationScript.license ?? baseOptions.license ?? 'MIT';
    const scriptedTools = Array.isArray(automationScript.tools)
      ? automationScript.tools.filter((tool): tool is SelectableTool =>
          TOOLS.some((entry) => entry.id === tool),
        )
      : ((baseOptions.tools ?? []) as SelectableTool[]);
    const scriptExamples = automationScript.includeExamples ?? Boolean(baseOptions.includeExamples);
    const scriptHooks = automationScript.includeHooks ?? Boolean(baseOptions.includeHooks);

    const autoOptions: CreateOptions = {
      ...baseOptions,
      name: scriptedName,
      description: scriptDescription,
      license: scriptLicense,
      tools: [...scriptedTools],
      includeExamples: scriptExamples,
      includeHooks: scriptHooks,
      targetDir: path.join(
        projectRoot,
        slugifySegment(
          getPackageDirName(scriptedName.trim().length > 0 ? scriptedName : baseOptions.name),
        ),
      ),
    };

    setName(autoOptions.name);
    setDescription(autoOptions.description);
    setLicense(autoOptions.license);
    setSelectedTools([...autoOptions.tools]);
    setIncludeExamples(autoOptions.includeExamples);
    setIncludeHooks(autoOptions.includeHooks);
    setAutomationApplied(true);

    if (automationScript.cancel) {
      onCancel?.();
      exit();
      return;
    }

    if (automationScript.submit ?? true) {
      setExecuting(true);
      setErrorMessage(null);
      void (async () => {
        try {
          const result = await execute(autoOptions);
          onComplete?.(result);
          exit();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setErrorMessage(message);
          logger.error(error instanceof Error ? error : message);
          setExecuting(false);
        }
      })();
    }
  }, [
    automationApplied,
    automationScript,
    baseOptions,
    execute,
    exit,
    logger,
    onCancel,
    onComplete,
    projectRoot,
  ]);

  useInput(
    (input, key) => {
      const isEscape = key.escape || input === '\u001B';

      if (executing) {
        if (isEscape) handleCancel();
        return;
      }

      if (isEscape) {
        handleCancel();
        return;
      }

      if (step === 'metadata') {
        if (key.tab) {
          if (key.shift) {
            setMetadataIndex((prev) => (prev === 0 ? 2 : prev - 1));
          } else {
            setMetadataIndex((prev) => (prev + 1) % 3);
          }
          return;
        }
        if (key.return) {
          if (metadataIndex < 2) {
            setMetadataIndex((prev) => (prev + 1) % 3);
            return;
          }
          proceedTo('tools');
          return;
        }
        return;
      }

      if (step === 'tools') {
        if (key.tab && key.shift) {
          proceedTo('metadata');
          setMetadataIndex(2);
          return;
        }

        if (key.tab || key.return) {
          proceedTo('options');
          return;
        }

        if (key.upArrow) {
          setToolCursor((prev) => (prev === 0 ? TOOLS.length - 1 : prev - 1));
          return;
        }
        if (key.downArrow) {
          setToolCursor((prev) => (prev + 1) % TOOLS.length);
          return;
        }

        const lower = input.toLowerCase();
        if (input === ' ') {
          setSelectedTools((prev) => {
            const tool = TOOLS[toolCursor].id;
            return prev.includes(tool) ? prev.filter((t) => t !== tool) : [...prev, tool];
          });
          return;
        }
        if (lower === 'a') {
          setSelectedTools(TOOLS.map((tool) => tool.id));
          return;
        }
        if (lower === 'n') {
          setSelectedTools([]);
          return;
        }
        return;
      }

      if (step === 'options') {
        if (key.tab && key.shift) {
          proceedTo('tools');
          return;
        }
        if (key.tab || key.return) {
          proceedTo('preview');
          return;
        }
        if (key.upArrow) {
          setOptionCursor((prev) => (prev === 0 ? OPTION_LABELS.length - 1 : prev - 1));
          return;
        }
        if (key.downArrow) {
          setOptionCursor((prev) => (prev + 1) % OPTION_LABELS.length);
          return;
        }
        if (input === ' ') {
          const current = OPTION_LABELS[optionCursor];
          if (current.id === 'examples') setIncludeExamples((prev) => !prev);
          else setIncludeHooks((prev) => !prev);
          return;
        }
        return;
      }

      if (step === 'preview') {
        if (key.tab && key.shift) {
          proceedTo('options');
          return;
        }
        if (key.return) {
          void handleExecute();
          return;
        }
      }
    },
    { isActive: true },
  );

  const toolsList =
    selectedTools.length > 0
      ? selectedTools.map((tool) => `✓ ${tool}`).join('\n ')
      : 'None selected';

  return (
    <WizardFrame
      heading={{
        task: 'Create',
        stepIndex,
        stepCount: 4,
        title: headingTitle,
      }}
      instruction={instruction}
      actionHints={actionHints}
      status={statusMessage}
      warning={null}
    >
      {step === 'metadata' ? (
        <Box flexDirection="column" gap={1}>
          {metadataIndex === 0 ? (
            <Box flexDirection="column">
              <Text>Package name:</Text>
              <TextInput
                value={name}
                focus
                onChange={setName}
                onSubmit={() => {
                  setMetadataIndex(1);
                }}
                placeholder="@scope/package-name"
              />
            </Box>
          ) : null}
          {metadataIndex === 1 ? (
            <Box flexDirection="column">
              <Text>Description:</Text>
              <TextInput
                value={description}
                focus
                onChange={setDescription}
                onSubmit={() => {
                  setMetadataIndex(2);
                }}
                placeholder="Optional description"
              />
            </Box>
          ) : null}
          {metadataIndex === 2 ? (
            <Box flexDirection="column">
              <Text>License:</Text>
              <TextInput
                value={license}
                focus
                onChange={setLicense}
                onSubmit={() => {
                  proceedTo('tools');
                }}
              />
            </Box>
          ) : null}
        </Box>
      ) : null}

      {step === 'tools' ? (
        <SelectableList items={toolItems} activeIndex={toolCursor} emptyMessage="No tools found" />
      ) : null}

      {step === 'options' ? (
        <SelectableList items={optionItems} activeIndex={optionCursor} />
      ) : null}

      {step === 'preview' ? (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Text bold>Package</Text>
            <Text> Name: {name}</Text>
            <Text> Version: {baseOptions.version}</Text>
            <Text> License: {license}</Text>
            {description.trim().length > 0 ? <Text> Description: {description}</Text> : null}
          </Box>
          <Box flexDirection="column">
            <Text bold>Tools</Text>
            <Text> {toolsList}</Text>
          </Box>
          <Box flexDirection="column">
            <Text bold>Structure</Text>
            <Text> {formatTree(targetDir, includeHooks, selectedTools)}</Text>
          </Box>
          {baseOptions.dryRun ? (
            <Text color="yellow">⚠ DRY RUN MODE — No files will be written</Text>
          ) : null}
        </Box>
      ) : null}
    </WizardFrame>
  );
}

function formatTree(targetDir: string, includeHooks: boolean, tools: SelectableTool[]): string {
  const base = `./${path.basename(targetDir)}/`;
  const lines = [
    `${base}`,
    `├── agents.toml`,
    `├── README.md`,
    `├── .gitignore`,
    `├── agents/`,
    `├── commands/`,
    `├── configurations/`,
    `└── mcp/`,
  ];
  const insertIndex = lines.length - 1;
  if (includeHooks) {
    lines.splice(insertIndex, 0, '├── hooks/');
  }
  if (tools.length > 0) {
    const templateLines = buildTemplateTree(tools);
    lines.splice(insertIndex, 0, ...templateLines);
  }
  return lines.join('\n  ');
}

function buildTemplateTree(tools: SelectableTool[]): string[] {
  const files = tools
    .map((tool) => {
      switch (tool) {
        case 'claude': {
          return 'CLAUDE.md.hbs';
        }
        case 'codex': {
          return 'AGENTS.md.hbs';
        }
        case 'cursor': {
          return 'cursor.rules.mdc.hbs';
        }
        case 'copilot': {
          return 'COPILOT.md.hbs';
        }
        default: {
          return null;
        }
      }
    })
    .filter((value) => value !== null)
    .map((value) => value as string);
  if (files.length === 0) return [];
  const sorted = [...files].sort();
  const lines: string[] = ['├── templates/'];
  for (const [index, file] of sorted.entries()) {
    const prefix = index === sorted.length - 1 ? '│   └──' : '│   ├──';
    lines.push(`${prefix} ${file}`);
  }
  return lines;
}
