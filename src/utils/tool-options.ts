import { ErrorCode, TerrazulError } from '../core/errors.js';

import type { ToolType } from '../types/context.js';

export function normalizeToolOption(value: string | undefined): ToolType | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'claude' || normalized === 'codex' || normalized === 'gemini') {
    return normalized as ToolType;
  }
  throw new TerrazulError(
    ErrorCode.INVALID_ARGUMENT,
    `Unsupported tool '${value}'. Expected 'claude', 'codex', or 'gemini'.`,
  );
}
