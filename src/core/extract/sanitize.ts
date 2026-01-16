import { homedir } from 'node:os';
import path from 'node:path';

// Minimal placeholders used in extracted templates. These encode intent for users.
const P = {
  HOME: '{{ HOME }}',
  PROJECT: '{{ PROJECT_ROOT }}',
  REPLACE: '{{ replace_me }}',
} as const;

function toForward(p: string): string {
  // Avoid ES2021 String#replaceAll; keep ES2020 target
  return p.split('\\').join('/');
}

export function sanitizeEnv(env?: Record<string, string>): Record<string, string> | undefined {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const key of Object.keys(env)) {
    out[key] = `{{ env.${key} }}`;
  }
  return out;
}

export function rewritePath(s: string, projectRootAbs: string): string {
  const home = toForward(homedir());
  const proj = toForward(projectRootAbs);
  const str = toForward(s);

  if (str.startsWith(proj + '/')) return str.replace(proj, P.PROJECT);
  if (str.startsWith(home + '/')) return str.replace(home, P.HOME);
  // Windows UNC (\\server\share) or forward variant (//server/share)
  if (/^\\\\/.test(s) || str.startsWith('//')) return P.REPLACE;
  // Absolute path (POSIX) or Windows drive letter (C:\ or C:/)
  if (path.isAbsolute(s) || /^[A-Za-z]:[/\\]/.test(s)) return P.REPLACE;
  return s;
}

function deepVisitStrings(obj: unknown, fn: (s: string) => string): void {
  if (!obj || typeof obj !== 'object') return;
  for (const k of Object.keys(obj as Record<string, unknown>)) {
    const v = (obj as Record<string, unknown>)[k];
    if (typeof v === 'string') (obj as Record<string, unknown>)[k] = fn(v);
    else deepVisitStrings(v, fn);
  }
}

// Claude settings.json: sanitize env, risky script fields, and absolute paths.
export function sanitizeSettingsJson(raw: unknown, projectRootAbs: string): unknown {
  const base = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const c: Record<string, unknown> = structuredClone(base);

  const env = c.env && typeof c.env === 'object' ? (c.env as Record<string, string>) : undefined;
  if (env) c.env = sanitizeEnv(env);

  for (const key of ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport']) {
    if (Object.prototype.hasOwnProperty.call(c, key)) c[key] = P.REPLACE;
  }

  const permissions =
    c.permissions && typeof c.permissions === 'object'
      ? (c.permissions as Record<string, unknown>)
      : undefined;
  const addl =
    permissions?.additionalDirectories && Array.isArray(permissions.additionalDirectories)
      ? (permissions.additionalDirectories as string[])
      : undefined;
  if (addl) {
    (permissions as Record<string, unknown>).additionalDirectories = addl.map((p) =>
      /^\\\\/.test(p) ? P.REPLACE : rewritePath(p, projectRootAbs),
    );
  }

  // Rewrite string fields that look like absolute paths (POSIX or Windows)
  deepVisitStrings(c, (s) =>
    /^(\/|[A-Za-z]:[/\\]|\\\\)/.test(s) ? rewritePath(s, projectRootAbs) : s,
  );
  return c;
}

export function sanitizeMcpServers(raw: unknown, projectRootAbs: string): unknown {
  const c = structuredClone(raw ?? {});
  deepVisitStrings(c, (s) =>
    /^(\/|[A-Za-z]:[/\\]|\\\\)/.test(s) ? rewritePath(s, projectRootAbs) : s,
  );
  return c;
}

// For plain text (e.g., Markdown), rewrite obvious absolute project/home paths.
export function sanitizeText(raw: string, projectRootAbs: string): string {
  const home = toForward(homedir());
  const proj = toForward(projectRootAbs);
  let out = raw;
  // Replace project and home paths with placeholders
  out = out.split(proj).join(P.PROJECT);
  out = out.split(home).join(P.HOME);
  // Heuristic for URLs vs. absolute POSIX paths → replace_me for the latter only
  // Match tokens that look like: https://..., //cdn..., or /absolute/path. Only mask the last form,
  // and preserve only scheme-relative URLs that look like a public domain (with a dot).
  // eslint-disable-next-line unicorn/prefer-string-replace-all
  out = out.replace(
    /(^|\s)(https?:\/\/[\w%+,./:@-]+|\/\/[\w%+,./:@-]+|\/[\w%+,./:@-]+)(?=\s|$)/g,
    (_m: string, pre: string, token: string) => {
      if (token.startsWith('http://') || token.startsWith('https://')) {
        return `${pre}${token}`; // leave absolute URLs untouched
      }
      if (token.startsWith('//')) {
        // Preserve scheme-relative only when it looks like a public domain (contains a dot)
        if (/^\/\/[\d.a-z-]+\.[a-z]{2,}/i.test(token)) return `${pre}${token}`;
        return `${pre}${P.REPLACE}`; // likely UNC //server/share → replace
      }
      if (token.startsWith(P.PROJECT) || token.startsWith(P.HOME)) return `${pre}${token}`;
      return `${pre}${P.REPLACE}`;
    },
  );
  // Windows absolute path heuristics (both backslash and forward slash variants)
  // Use negative lookbehind to avoid matching protocol like 'https://'
  // eslint-disable-next-line unicorn/prefer-string-replace-all
  out = out.replace(/(?<![A-Za-z])([A-Za-z]:\\[^\s"']+)/g, P.REPLACE);
  // eslint-disable-next-line unicorn/prefer-string-replace-all
  out = out.replace(/(?<![A-Za-z])([A-Za-z]:\/[^\s"']+)/g, P.REPLACE);
  return out;
}

export function resolveProjectRoot(fromDirAbs: string): string {
  const base = path.basename(fromDirAbs);
  if (['.claude', '.codex', '.gemini'].includes(base)) {
    return path.dirname(fromDirAbs);
  }
  return fromDirAbs;
}

export const Placeholders = P;
