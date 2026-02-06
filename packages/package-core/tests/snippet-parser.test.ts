import { describe, expect, it } from 'vitest';

import { nodeCrypto } from '../src/adapters/node.js';
import { parseSnippets, generateSnippetId, safeResolveWithin, SnippetParseError } from '../src/index.js';

describe('snippet parser', () => {
  it('parses askUser without options', () => {
    const tpl = "Intro {{ askUser('What is your name?') }} content";
    const snippets = parseSnippets(tpl);
    expect(snippets).toHaveLength(1);
    const snippet = snippets[0];
    expect(snippet.type).toBe('askUser');
    if (snippet.type === 'askUser') {
      expect(snippet.question).toBe('What is your name?');
      expect(snippet.options.default).toBeUndefined();
    }
  });

  it('parses askUser with options', () => {
    const tpl = "{{ askUser('Team?', { default: 'Platform', placeholder: 'Team name' }) }}";
    const [snippet] = parseSnippets(tpl);
    expect(snippet.type).toBe('askUser');
    if (snippet.type === 'askUser') {
      expect(snippet.options).toEqual({
        default: 'Platform',
        placeholder: 'Team name',
      });
    }
  });

  it('handles whitespace control tildes around snippets', () => {
    const tpl = "{{~ askUser('Trimmed?') ~}}";
    const [snippet] = parseSnippets(tpl);
    expect(snippet.type).toBe('askUser');
    if (snippet.type === 'askUser') {
      expect(snippet.question).toBe('Trimmed?');
    }
  });

  it('parses triple-mustache askAgent snippets', () => {
    const tpl = "{{{ askAgent('Summarize this repo') }}}";
    const [snippet] = parseSnippets(tpl);
    if (snippet.type !== 'askAgent') throw new Error('expected askAgent snippet');
    expect(snippet.prompt.kind).toBe('text');
    expect(snippet.prompt.value).toBe('Summarize this repo');
  });

  it('parses askAgent inline prompt with options', () => {
    const tpl =
      "{{ askAgent('Summarize this repo', { json: true, tool: 'claude', safeMode: false, timeoutMs: 120000 }) }}";
    const [snippet] = parseSnippets(tpl);
    if (snippet.type !== 'askAgent') throw new Error('expected askAgent snippet');
    expect(snippet.prompt.kind).toBe('text');
    expect(snippet.prompt.value).toBe('Summarize this repo');
    expect(snippet.options).toMatchObject({
      json: true,
      tool: 'claude',
      safeMode: false,
      timeoutMs: 120_000,
    });
  });

  it('detects file prompt form for relative paths', () => {
    const tpl = "{{ askAgent('templates/summary.txt') }}";
    const [snippet] = parseSnippets(tpl);
    if (snippet.type !== 'askAgent') throw new Error('expected askAgent snippet');
    expect(snippet.prompt.kind).toBe('file');
    expect(snippet.prompt.value).toBe('templates/summary.txt');
  });

  it('treats inline prompts with slashes and spaces as text', () => {
    const tpl = "{{ askAgent('Summarize src/utils/snippet-parser.ts usage') }}";
    const [snippet] = parseSnippets(tpl);
    if (snippet.type !== 'askAgent') throw new Error('expected askAgent snippet');
    expect(snippet.prompt.kind).toBe('text');
    expect(snippet.prompt.value).toBe('Summarize src/utils/snippet-parser.ts usage');
  });

  it('supports variable assignment with triple-quoted literal', () => {
    const tpl = `
    {{ var summary = askAgent("""
      Summarize the repository.
        Include highlights.
    """, { json: true }) }}
    `;
    const [snippet] = parseSnippets(tpl);
    if (snippet.type !== 'askAgent') throw new Error('expected askAgent snippet');
    expect(snippet.varName).toBe('summary');
    expect(snippet.prompt.kind).toBe('text');
    expect(snippet.prompt.value).toBe('Summarize the repository.\n  Include highlights.');
    expect(snippet.options.json).toBe(true);
  });

  it('ignores non-snippet handlebars expressions', () => {
    const tpl = '{{project.name}} {{#if condition}}{{/if}}';
    const snippets = parseSnippets(tpl);
    expect(snippets).toHaveLength(0);
  });

  it('allows mentioning snippet helper names inside other expressions', () => {
    const tpl = "{{ helper 'askUser' }} {{ lookup map 'askAgent' }}";
    expect(() => parseSnippets(tpl)).not.toThrow();
    const snippets = parseSnippets(tpl);
    expect(snippets).toHaveLength(0);
  });

  it('rejects nested askAgent call embedded in another helper', () => {
    const tpl = "{{ helper askAgent('Nested prompt?') }}";
    expect(() => parseSnippets(tpl)).toThrow(/Malformed snippet/);
  });

  it('ignores literal strings that contain askUser call syntax', () => {
    const tpl = '{{ helper "askUser(\'noop\')" }}';
    expect(() => parseSnippets(tpl)).not.toThrow();
  });

  it('throws on unsupported askAgent option keys', () => {
    const tpl = "{{ askAgent('Prompt', { unexpected: true }) }}";
    expect(() => parseSnippets(tpl)).toThrow(/Unsupported askAgent option/);
  });

  it('throws on invalid variable name', () => {
    const tpl = "{{ var summary-text = askAgent('Prompt') }}";
    expect(() => parseSnippets(tpl)).toThrow(/Invalid variable name/);
  });

  it('throws on duplicate variable names', () => {
    const tpl = `
      {{ var result = askAgent('Prompt one') }}
      {{ var result = askAgent('Prompt two') }}
    `;
    expect(() => parseSnippets(tpl)).toThrow(/already defined/);
  });

  it('throws when json option is not boolean', () => {
    const tpl = "{{ askAgent('Prompt', { json: 'true' }) }}";
    expect(() => parseSnippets(tpl)).toThrow(/json option must be boolean/);
  });

  it('throws on malformed snippet call', () => {
    const tpl = '{{ askUser }}';
    expect(() => parseSnippets(tpl)).toThrow(/Malformed snippet/);
  });

  // Backtick string tests
  it('parses askUser with backtick strings', () => {
    const tpl = '{{ askUser(`What is your name?`) }}';
    const [snippet] = parseSnippets(tpl);
    expect(snippet.type).toBe('askUser');
    if (snippet.type === 'askUser') {
      expect(snippet.question).toBe('What is your name?');
    }
  });

  it('parses askAgent with backtick strings', () => {
    const tpl = '{{ askAgent(`Summarize this repo`) }}';
    const [snippet] = parseSnippets(tpl);
    if (snippet.type !== 'askAgent') throw new Error('expected askAgent snippet');
    expect(snippet.prompt.kind).toBe('text');
    expect(snippet.prompt.value).toBe('Summarize this repo');
  });

  it('parses multi-line backtick strings', () => {
    const tpl = `{{ askAgent(\`Determine how to run, test,
lint, and format the code locally.\`) }}`;
    const [snippet] = parseSnippets(tpl);
    if (snippet.type !== 'askAgent') throw new Error('expected askAgent snippet');
    expect(snippet.prompt.kind).toBe('text');
    expect(snippet.prompt.value).toBe(
      'Determine how to run, test,\nlint, and format the code locally.',
    );
  });

  it('parses escaped backticks in backtick strings', () => {
    const tpl = '{{ askUser(`Use \\`backticks\\` here`) }}';
    const [snippet] = parseSnippets(tpl);
    expect(snippet.type).toBe('askUser');
    if (snippet.type === 'askUser') {
      expect(snippet.question).toBe('Use `backticks` here');
    }
  });

  it('parses backtick strings with single quotes inside', () => {
    const tpl = '{{ askUser(`What is your name?`) }}';
    const [snippet] = parseSnippets(tpl);
    expect(snippet.type).toBe('askUser');
    if (snippet.type === 'askUser') {
      expect(snippet.question).toBe('What is your name?');
    }
  });

  it('parses backtick strings with options', () => {
    const tpl = "{{ askAgent(`Summarize repo`, { json: true, tool: 'claude' }) }}";
    const [snippet] = parseSnippets(tpl);
    if (snippet.type !== 'askAgent') throw new Error('expected askAgent snippet');
    expect(snippet.prompt.value).toBe('Summarize repo');
    expect(snippet.options.json).toBe(true);
    expect(snippet.options.tool).toBe('claude');
  });

  it('parses variable assignment with backtick literal', () => {
    const tpl = '{{ var summary = askAgent(`Summarize the repository.`) }}';
    const [snippet] = parseSnippets(tpl);
    if (snippet.type !== 'askAgent') throw new Error('expected askAgent snippet');
    expect(snippet.varName).toBe('summary');
    expect(snippet.prompt.value).toBe('Summarize the repository.');
  });

  it('throws SnippetParseError on parse errors', () => {
    const tpl = '{{ askAgent }}';
    expect(() => parseSnippets(tpl)).toThrow(SnippetParseError);
  });
});

describe('generateSnippetId', () => {
  it('generates consistent IDs for the same content', async () => {
    const tpl = "{{ askUser('What is your name?') }}";
    const [snippet] = parseSnippets(tpl);

    const id1 = await generateSnippetId(snippet, nodeCrypto);
    const id2 = await generateSnippetId(snippet, nodeCrypto);

    expect(id1).toBe(id2);
    expect(id1).toMatch(/^snippet_[\da-f]{8}$/);
  });

  it('generates different IDs for different content', async () => {
    const tpl1 = "{{ askUser('What is your name?') }}";
    const tpl2 = "{{ askUser('What is your email?') }}";

    const [snippet1] = parseSnippets(tpl1);
    const [snippet2] = parseSnippets(tpl2);

    const id1 = await generateSnippetId(snippet1, nodeCrypto);
    const id2 = await generateSnippetId(snippet2, nodeCrypto);

    expect(id1).not.toBe(id2);
  });

  it('ignores variable name when generating ID', async () => {
    const tpl1 = "{{ var name = askUser('What is your name?') }}";
    const tpl2 = "{{ var userName = askUser('What is your name?') }}";

    const [snippet1] = parseSnippets(tpl1);
    const [snippet2] = parseSnippets(tpl2);

    const id1 = await generateSnippetId(snippet1, nodeCrypto);
    const id2 = await generateSnippetId(snippet2, nodeCrypto);

    expect(id1).toBe(id2);
  });

  it('includes options in the ID', async () => {
    const tpl1 = "{{ askUser('Team?', { default: 'Platform' }) }}";
    const tpl2 = "{{ askUser('Team?', { default: 'Infrastructure' }) }}";

    const [snippet1] = parseSnippets(tpl1);
    const [snippet2] = parseSnippets(tpl2);

    const id1 = await generateSnippetId(snippet1, nodeCrypto);
    const id2 = await generateSnippetId(snippet2, nodeCrypto);

    expect(id1).not.toBe(id2);
  });
});

describe('safeResolveWithin', () => {
  it('resolves simple relative path within base', () => {
    expect(safeResolveWithin('/root/pkg', 'src/file.ts')).toBe('/root/pkg/src/file.ts');
  });

  it('returns null for path traversal', () => {
    expect(safeResolveWithin('/root/pkg', '../../etc/passwd')).toBeNull();
  });

  it('returns null for sibling directory prefix collision', () => {
    expect(safeResolveWithin('/root/pkg', '../pkg2/secret.md')).toBeNull();
  });

  it('allows exact base directory path', () => {
    expect(safeResolveWithin('/root/pkg', '.')).toBe('/root/pkg');
  });

  it('normalizes backslashes', () => {
    expect(safeResolveWithin('/root/pkg', String.raw`src\file.ts`)).toBe('/root/pkg/src/file.ts');
  });

  it('handles trailing slashes on base dir', () => {
    expect(safeResolveWithin('/root/pkg/', 'src/file.ts')).toBe('/root/pkg/src/file.ts');
  });
});
