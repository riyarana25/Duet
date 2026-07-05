/**
 * Syntax highlighting via highlight.js — deliberately outsourced. Language grammars are
 * commodity work and getting dozens of them right is not this project's point (the CRDT
 * is; that stays hand-written). What stays ours is the *architecture*: callers paint the
 * returned HTML into an underlay behind the transparent contenteditable (see editor.ts),
 * which is what keeps the caret math trivial.
 *
 * Languages are registered individually (not the full build) to keep the bundle lean.
 * highlight.js escapes the source text itself; only its own spans are injected.
 */
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import java from 'highlight.js/lib/languages/java';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import bash from 'highlight.js/lib/languages/bash';
import sql from 'highlight.js/lib/languages/sql';
import markdown from 'highlight.js/lib/languages/markdown';
import plaintext from 'highlight.js/lib/languages/plaintext';

const REGISTRY: Record<string, unknown> = {
  javascript, typescript, python, java, c, cpp, csharp, go, rust,
  json, xml, css, bash, sql, markdown, plaintext,
};
for (const [name, lang] of Object.entries(REGISTRY)) {
  hljs.registerLanguage(name, lang as Parameters<typeof hljs.registerLanguage>[1]);
}

/** Dropdown options; 'auto' defers to detectLanguage(). */
export const LANGUAGE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'auto', label: 'auto' },
  { value: 'javascript', label: 'js' },
  { value: 'typescript', label: 'ts' },
  { value: 'python', label: 'python' },
  { value: 'java', label: 'java' },
  { value: 'c', label: 'c' },
  { value: 'cpp', label: 'c++' },
  { value: 'csharp', label: 'c#' },
  { value: 'go', label: 'go' },
  { value: 'rust', label: 'rust' },
  { value: 'json', label: 'json' },
  { value: 'xml', label: 'html' },
  { value: 'css', label: 'css' },
  { value: 'bash', label: 'bash' },
  { value: 'sql', label: 'sql' },
  { value: 'markdown', label: 'md' },
  { value: 'plaintext', label: 'plain' },
];

// Detection is restricted to a subset: fewer candidates = faster + fewer misdetections.
const AUTO_SUBSET = [
  'javascript', 'typescript', 'python', 'java', 'cpp', 'go', 'rust',
  'json', 'xml', 'css', 'bash', 'sql', 'markdown',
];

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Highlight `text` as `language` (a registered id, not 'auto'). Falls back to plain. */
export function highlightAs(text: string, language: string): string {
  if (text.length === 0) return '';
  try {
    return hljs.highlight(text, { language }).value;
  } catch {
    return escapeHtml(text);
  }
}

/**
 * Best-guess language for `text`. Costs a full multi-grammar pass, so callers should
 * debounce it and cache the answer rather than run it per keystroke (editor.ts does).
 */
export function detectLanguage(text: string): string {
  if (text.trim().length === 0) return 'plaintext';
  try {
    return hljs.highlightAuto(text, AUTO_SUBSET).language ?? 'plaintext';
  } catch {
    return 'plaintext';
  }
}
