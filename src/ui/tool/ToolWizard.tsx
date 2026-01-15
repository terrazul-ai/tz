import { Box, Text, useApp, useInput } from 'ink';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { type DetectableToolType, type ToolDetectionResult } from '../../core/tool-detector.js';
import {
  type KeyHint,
  type SelectableListItem,
  SelectableList,
  type StatusMessage,
  WizardFrame,
} from '../extract/components.js';

export interface LoggerLike {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string | Error) => void;
  debug: (msg: string) => void;
  isVerbose: () => boolean;
}

export type ToolScope = 'project' | 'user' | 'both';

export interface ToolWizardProps {
  /** Function to detect tools */
  detectTools: () => Promise<ToolDetectionResult[]>;
  /** Current project tool setting (or null if not set, undefined if no manifest) */
  currentProjectTool: DetectableToolType | null | undefined;
  /** Current user tool setting (first tool in profile.tools) */
  currentUserTool: DetectableToolType | null;
  /** Save the selection */
  saveSelection: (tool: DetectableToolType, scope: ToolScope) => Promise<void>;
  /** Logger instance */
  logger: LoggerLike;
  /** Called when wizard completes successfully */
  onComplete?: (tool: DetectableToolType, scope: ToolScope) => void;
  /** Called when user cancels */
  onCancel?: () => void;
  /** Whether project has agents.toml */
  hasProjectManifest: boolean;
}

type Step = 'tool-select' | 'scope-select' | 'confirm';

interface ScopeOption {
  id: ToolScope;
  label: string;
  description: string;
}

const SCOPE_OPTIONS: ScopeOption[] = [
  { id: 'project', label: 'Project', description: 'Save to agents.toml (this project only)' },
  { id: 'user', label: 'User', description: 'Save to ~/.terrazul/config.json (all projects)' },
  { id: 'both', label: 'Both', description: 'Save to both locations' },
];

export function ToolWizard({
  detectTools,
  currentProjectTool,
  currentUserTool,
  saveSelection,
  logger,
  onComplete,
  onCancel,
  hasProjectManifest,
}: ToolWizardProps): React.ReactElement {
  const { exit } = useApp();
  const [step, setStep] = useState<Step>('tool-select');
  const [detecting, setDetecting] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tools, setTools] = useState<ToolDetectionResult[]>([]);
  const [selectedTool, setSelectedTool] = useState<DetectableToolType | null>(null);
  const [selectedScope, setSelectedScope] = useState<ToolScope>(
    hasProjectManifest ? 'project' : 'user',
  );
  const [toolCursor, setToolCursor] = useState(0);
  const [scopeCursor, setScopeCursor] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Run detection on mount
  useEffect(() => {
    void (async () => {
      try {
        const results = await detectTools();
        setTools(results);
        // Pre-select current tool or first installed
        const installed = results.filter((t) => t.installed);
        if (installed.length > 0) {
          const current = currentProjectTool ?? currentUserTool;
          const preselect = installed.find((t) => t.type === current) ?? installed[0];
          setSelectedTool(preselect.type);
          const idx = results.findIndex((t) => t.type === preselect.type);
          if (idx >= 0) setToolCursor(idx);
        }
      } catch (error) {
        logger.error(error instanceof Error ? error : String(error));
        setErrorMessage('Failed to detect tools');
      } finally {
        setDetecting(false);
      }
    })();
  }, [detectTools, currentProjectTool, currentUserTool, logger]);

  // Update scope cursor when hasProjectManifest changes
  useEffect(() => {
    const defaultScope = hasProjectManifest ? 'project' : 'user';
    setSelectedScope(defaultScope);
    setScopeCursor(SCOPE_OPTIONS.findIndex((s) => s.id === defaultScope));
  }, [hasProjectManifest]);

  const handleCancel = useCallback(() => {
    onCancel?.();
    exit();
  }, [onCancel, exit]);

  const handleSave = useCallback(async () => {
    if (!selectedTool) return;
    setSaving(true);
    setErrorMessage(null);
    try {
      await saveSelection(selectedTool, selectedScope);
      onComplete?.(selectedTool, selectedScope);
      exit();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setErrorMessage(msg);
      logger.error(error instanceof Error ? error : msg);
      setSaving(false);
    }
  }, [selectedTool, selectedScope, saveSelection, onComplete, exit, logger]);

  const proceedTo = useCallback((nextStep: Step) => {
    setStep(nextStep);
    setErrorMessage(null);
  }, []);

  useInput(
    (input, key) => {
      const isEscape = key.escape || input === '\u001B';

      if (detecting || saving) {
        if (isEscape) handleCancel();
        return;
      }

      if (isEscape) {
        handleCancel();
        return;
      }

      if (step === 'tool-select') {
        const installedTools = tools.filter((t) => t.installed);
        if (installedTools.length === 0) {
          // No tools to select, can only cancel
          return;
        }

        if (key.upArrow) {
          setToolCursor((prev) => (prev === 0 ? tools.length - 1 : prev - 1));
          return;
        }
        if (key.downArrow) {
          setToolCursor((prev) => (prev + 1) % tools.length);
          return;
        }
        if (input === ' ' || key.return) {
          const tool = tools[toolCursor];
          if (tool.installed) {
            setSelectedTool(tool.type);
            if (key.return) {
              proceedTo('scope-select');
            }
          }
          return;
        }
        if (key.tab && !key.shift) {
          const tool = tools[toolCursor];
          if (tool.installed) {
            setSelectedTool(tool.type);
            proceedTo('scope-select');
          }
          return;
        }
        return;
      }

      if (step === 'scope-select') {
        if (key.tab && key.shift) {
          proceedTo('tool-select');
          return;
        }
        if (key.upArrow) {
          setScopeCursor((prev) => (prev === 0 ? SCOPE_OPTIONS.length - 1 : prev - 1));
          return;
        }
        if (key.downArrow) {
          setScopeCursor((prev) => (prev + 1) % SCOPE_OPTIONS.length);
          return;
        }
        if (input === ' ') {
          const scope = SCOPE_OPTIONS[scopeCursor];
          // Skip project scope if no manifest
          if (scope.id === 'project' && !hasProjectManifest) return;
          if (scope.id === 'both' && !hasProjectManifest) return;
          setSelectedScope(scope.id);
          return;
        }
        if (key.return || (key.tab && !key.shift)) {
          const scope = SCOPE_OPTIONS[scopeCursor];
          if (scope.id === 'project' && !hasProjectManifest) return;
          if (scope.id === 'both' && !hasProjectManifest) return;
          setSelectedScope(scope.id);
          proceedTo('confirm');
          return;
        }
        return;
      }

      if (step === 'confirm') {
        if (key.tab && key.shift) {
          proceedTo('scope-select');
          return;
        }
        if (key.return) {
          void handleSave();
          return;
        }
        return;
      }
    },
    { isActive: true },
  );

  // Build tool list items
  const toolItems: SelectableListItem[] = useMemo(() => {
    return tools.map((tool) => {
      const statusText = tool.installed
        ? tool.version
          ? `installed (v${tool.version})`
          : 'installed'
        : (tool.error ?? 'not found');
      const statusIcon = tool.installed ? '\u2713' : '\u2717';
      return {
        id: tool.type,
        label: `${tool.type.padEnd(10)} ${statusIcon} ${statusText}`,
        detail: tool.displayName,
        selected: tool.type === selectedTool,
      };
    });
  }, [tools, selectedTool]);

  // Build scope list items
  const scopeItems: SelectableListItem[] = useMemo(() => {
    return SCOPE_OPTIONS.map((scope) => {
      const disabled = !hasProjectManifest && (scope.id === 'project' || scope.id === 'both');
      return {
        id: scope.id,
        label: disabled ? `${scope.label} (no agents.toml)` : scope.label,
        detail: scope.description,
        selected: scope.id === selectedScope,
      };
    });
  }, [selectedScope, hasProjectManifest]);

  // Heading
  const headingTitle = useMemo(() => {
    switch (step) {
      case 'tool-select': {
        return 'Select Tool';
      }
      case 'scope-select': {
        return 'Select Scope';
      }
      default: {
        return 'Confirm';
      }
    }
  }, [step]);

  const stepIndex = useMemo(() => {
    switch (step) {
      case 'tool-select': {
        return 0;
      }
      case 'scope-select': {
        return 1;
      }
      default: {
        return 2;
      }
    }
  }, [step]);

  const instruction = useMemo(() => {
    switch (step) {
      case 'tool-select': {
        return 'Select your default AI tool';
      }
      case 'scope-select': {
        return 'Choose where to save the preference';
      }
      default: {
        return 'Review and confirm your selection';
      }
    }
  }, [step]);

  // Action hints
  const actionHints: KeyHint[] = useMemo(() => {
    const hints: KeyHint[] = [];

    if (step === 'tool-select') {
      hints.push(
        { key: '\u2191\u2193', label: 'Navigate' },
        { key: 'Space', label: 'Select' },
        { key: 'Enter', label: 'Continue', emphasis: 'primary' },
      );
    } else if (step === 'scope-select') {
      hints.push(
        { key: '\u2191\u2193', label: 'Navigate' },
        { key: 'Space', label: 'Select' },
        { key: 'Shift+Tab', label: 'Back' },
        { key: 'Enter', label: 'Continue', emphasis: 'primary' },
      );
    } else {
      hints.push(
        { key: 'Shift+Tab', label: 'Back' },
        { key: 'Enter', label: 'Confirm', emphasis: 'primary' },
      );
    }

    hints.push({ key: 'Esc', label: 'Cancel', emphasis: 'danger' });

    return hints;
  }, [step]);

  // Status message
  const status: StatusMessage | null = useMemo(() => {
    if (detecting) {
      return { kind: 'busy', text: 'Detecting installed tools...', spinner: '\u280B' };
    }
    if (saving) {
      return { kind: 'busy', text: 'Saving preferences...', spinner: '\u280B' };
    }
    if (errorMessage) {
      return { kind: 'error', text: errorMessage };
    }
    return null;
  }, [detecting, saving, errorMessage]);

  // Warning for no tools
  const warning = useMemo(() => {
    if (!detecting && tools.filter((t) => t.installed).length === 0) {
      return 'No tools detected. Install claude, codex, or gemini to continue.';
    }
    return null;
  }, [detecting, tools]);

  // Current defaults info
  const currentDefaultsInfo = useMemo(() => {
    const parts: string[] = [];
    if (currentProjectTool !== undefined) {
      parts.push(`Project: ${currentProjectTool ?? 'not set'}`);
    }
    parts.push(`User: ${currentUserTool ?? 'not set'}`);
    return parts.join(' | ');
  }, [currentProjectTool, currentUserTool]);

  return (
    <WizardFrame
      heading={{
        task: 'Tool Configuration',
        stepIndex,
        stepCount: 3,
        title: headingTitle,
      }}
      instruction={instruction}
      actionHints={actionHints}
      status={status}
      warning={warning}
    >
      {step === 'tool-select' && (
        <Box flexDirection="column" gap={1}>
          <SelectableList
            items={toolItems}
            activeIndex={toolCursor}
            emptyMessage="No tools available"
          />
          {!detecting && <Text dimColor>Current: {currentDefaultsInfo}</Text>}
        </Box>
      )}

      {step === 'scope-select' && (
        <Box flexDirection="column" gap={1}>
          <SelectableList
            items={scopeItems}
            activeIndex={scopeCursor}
            emptyMessage="No scope options"
          />
          <Text dimColor>Current: {currentDefaultsInfo}</Text>
        </Box>
      )}

      {step === 'confirm' && (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Text>
              Tool:{' '}
              <Text color="green" bold>
                {selectedTool}
              </Text>
            </Text>
            <Text>
              Scope:{' '}
              <Text color="green" bold>
                {selectedScope}
              </Text>
            </Text>
          </Box>
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>This will update:</Text>
            {(selectedScope === 'project' || selectedScope === 'both') && (
              <Text dimColor> - ./agents.toml [package.tool]</Text>
            )}
            {(selectedScope === 'user' || selectedScope === 'both') && (
              <Text dimColor> - ~/.terrazul/config.json [profile.tools]</Text>
            )}
          </Box>
        </Box>
      )}
    </WizardFrame>
  );
}
