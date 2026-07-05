/**
 * Word-based autocompletion — the classic lightweight approach (no LSP, no server):
 * candidates are the active language's keywords plus every identifier already present in
 * the document, prefix-matched against the word being typed. Cheap enough to run per
 * keystroke on demo-sized documents, and surprisingly effective in practice because most
 * completions people want are names they already used.
 */

const JS_CORE = [
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'console', 'continue',
  'default', 'delete', 'document', 'else', 'export', 'extends', 'false', 'finally',
  'for', 'from', 'function', 'if', 'import', 'instanceof', 'length', 'let', 'new',
  'null', 'return', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try',
  'typeof', 'undefined', 'var', 'while', 'window', 'yield',
];
const TS_EXTRA = [
  'any', 'boolean', 'enum', 'implements', 'interface', 'namespace', 'never', 'number',
  'private', 'protected', 'public', 'readonly', 'string', 'type', 'unknown', 'void',
];

const KEYWORDS: Record<string, string[]> = {
  javascript: JS_CORE,
  typescript: [...JS_CORE, ...TS_EXTRA],
  python: [
    'and', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del',
    'elif', 'else', 'except', 'False', 'finally', 'for', 'from', 'global', 'if',
    'import', 'in', 'is', 'lambda', 'len', 'None', 'nonlocal', 'not', 'or', 'pass',
    'print', 'raise', 'range', 'return', 'self', 'True', 'try', 'while', 'with', 'yield',
  ],
  java: [
    'abstract', 'boolean', 'break', 'case', 'catch', 'class', 'continue', 'default',
    'double', 'else', 'extends', 'final', 'finally', 'float', 'for', 'if', 'implements',
    'import', 'instanceof', 'interface', 'new', 'package', 'private', 'protected',
    'public', 'return', 'static', 'String', 'super', 'switch', 'this', 'throw', 'throws',
    'try', 'void', 'while',
  ],
  c: [
    'break', 'case', 'char', 'const', 'continue', 'default', 'double', 'else', 'enum',
    'float', 'for', 'if', 'include', 'int', 'long', 'printf', 'return', 'sizeof',
    'static', 'struct', 'switch', 'typedef', 'unsigned', 'void', 'while',
  ],
  cpp: [
    'auto', 'bool', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default',
    'delete', 'double', 'else', 'false', 'float', 'for', 'if', 'include', 'int',
    'namespace', 'new', 'nullptr', 'private', 'public', 'return', 'static', 'std',
    'struct', 'switch', 'template', 'throw', 'true', 'try', 'typename', 'using',
    'vector', 'virtual', 'void', 'while',
  ],
  go: [
    'append', 'bool', 'break', 'case', 'chan', 'const', 'continue', 'default', 'defer',
    'else', 'error', 'false', 'for', 'func', 'go', 'if', 'import', 'int', 'interface',
    'len', 'make', 'map', 'nil', 'package', 'range', 'return', 'select', 'string',
    'struct', 'switch', 'true', 'type', 'var',
  ],
  rust: [
    'break', 'const', 'continue', 'else', 'enum', 'false', 'fn', 'for', 'if', 'impl',
    'let', 'loop', 'match', 'mod', 'mut', 'println', 'pub', 'return', 'self', 'static',
    'String', 'struct', 'trait', 'true', 'use', 'Vec', 'while',
  ],
};

const WORD = /[A-Za-z_$][\w$]{2,}/g;
const MAX_ITEMS = 8;

/**
 * Completions for `prefix` (the word being typed, ≥ 2 chars): language keywords first,
 * then identifiers harvested from the document. Case-sensitive prefix match so accepting
 * never mangles capitalisation; the typed word itself is excluded.
 */
export function completions(text: string, language: string, prefix: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([prefix]);
  const push = (w: string): void => {
    if (out.length < MAX_ITEMS && !seen.has(w) && w.startsWith(prefix)) {
      seen.add(w);
      out.push(w);
    }
  };
  for (const kw of KEYWORDS[language] ?? []) push(kw);
  for (const m of text.match(WORD) ?? []) {
    if (out.length >= MAX_ITEMS) break;
    push(m);
  }
  return out;
}
