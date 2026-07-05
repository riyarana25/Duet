/**
 * Lightweight "does it compile?" checks — outsourced in the same spirit as highlight.ts:
 * the parsing comes from a library, the integration stays ours. Actually compiling 16
 * languages in a browser isn't realistic; what we can do cheaply and *honestly* is full
 * syntax validation where a small trusted parser exists:
 *   - javascript — acorn (the parser the bundler ecosystem runs on)
 *   - json       — the platform's own JSON.parse
 * Languages without a cheap in-browser parser return null (no checker) rather than a
 * fake green check.
 */
import { parse } from 'acorn';

export interface Diagnostic {
  ok: boolean;
  /** 1-based line of the first error, when known. */
  line?: number;
  message?: string;
}

/** Check `text` as `language`. Returns null when there is no checker for the language. */
export function checkSyntax(text: string, language: string): Diagnostic | null {
  if (text.trim().length === 0) return null;
  switch (language) {
    case 'javascript':
      return checkJs(text);
    case 'json':
      return checkJson(text);
    default:
      return null;
  }
}

function checkJs(text: string): Diagnostic {
  try {
    parse(text, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true });
    return { ok: true };
  } catch (err) {
    const e = err as { loc?: { line: number }; message?: string };
    // acorn appends " (line:col)" to messages; the status bar shows the line itself.
    const message = (e.message ?? 'syntax error').replace(/\s*\(\d+:\d+\)\s*$/, '');
    return { ok: false, line: e.loc?.line, message };
  }
}

function checkJson(text: string): Diagnostic {
  try {
    JSON.parse(text);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid JSON';
    // Error shapes vary by engine: some report "line N", older ones only "position N".
    const lineMatch = /line (\d+)/i.exec(message);
    const posMatch = /position (\d+)/i.exec(message);
    let line: number | undefined;
    if (lineMatch?.[1]) line = Number(lineMatch[1]);
    else if (posMatch?.[1]) line = text.slice(0, Number(posMatch[1])).split('\n').length;
    return { ok: false, line, message };
  }
}
