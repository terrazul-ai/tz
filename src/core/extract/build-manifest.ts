import * as TOML from '@iarna/toml';

export interface ExportEntry {
  template?: string;
  // allow additional string properties for forward-compat
  [key: string]: string | undefined;
}

export interface ExportMap {
  codex?: ExportEntry;
  claude?: ExportEntry;
  gemini?: ExportEntry;
  // Unknown tools allowed but not used here
  [key: string]: ExportEntry | undefined;
}

export function buildAgentsToml(
  name: string,
  version: string,
  exportsMap: ExportMap,
  description = 'Extracted AI context package',
): string {
  const doc: TOML.JsonMap = {
    package: { name, version, description, license: 'MIT' },
    // cast is safe because ExportMap only contains string values
    exports: exportsMap as unknown as TOML.JsonMap,
    metadata: { tz_spec_version: 1 },
  };
  return TOML.stringify(doc);
}
