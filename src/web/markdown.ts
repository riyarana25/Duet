/**
 * Minimal, safe Markdown renderer for the doc-mode preview.
 *
 * Hand-rolled on purpose: the full CommonMark spec is a library-sized problem, but the
 * subset a collaborative notes surface needs (headings, bold/italic, inline code, fenced
 * code, lists, links) fits in a page — and doing it ourselves makes the XSS posture easy
 * to audit: ALL input is HTML-escaped first, and only our own tags are re-introduced.
 * Link hrefs must be http(s); everything else renders as text.
 *
 * Why markdown at all: the CRDT is a plain-text sequence, so formatting lives IN the
 * text (like every wiki), not as attributed ranges — see design.md for the trade-off.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Inline marks on already-escaped text: code, bold, italic, links. */
function inline(escaped: string): string {
  let out = escaped;
  // `code` first, so its contents are protected from bold/italic processing.
  out = out.replace(/`([^`\n]+)`/g, (_m, code: string) => `<code>${code}</code>`);
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  // [text](url) — http(s) only; note the input is escaped, so no quote can break out.
  out = out.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  );
  return out;
}

/** Render markdown `src` to HTML. Safe on untrusted input (escape-first). */
export function renderMarkdown(src: string): string {
  const lines = src.split('\n');
  const out: string[] = [];
  let para: string[] = [];
  let list: string[] | null = null;
  let fence: string[] | null = null;

  const flushPara = (): void => {
    if (para.length > 0) {
      out.push(`<p>${para.map((l) => inline(escapeHtml(l))).join('<br>')}</p>`);
      para = [];
    }
  };
  const flushList = (): void => {
    if (list) {
      out.push(`<ul>${list.map((li) => `<li>${inline(escapeHtml(li))}</li>`).join('')}</ul>`);
      list = null;
    }
  };

  for (const line of lines) {
    // Fenced code blocks swallow everything until the closing fence.
    if (fence !== null) {
      if (/^```/.test(line)) {
        out.push(`<pre><code>${escapeHtml(fence.join('\n'))}</code></pre>`);
        fence = null;
      } else {
        fence.push(line);
      }
      continue;
    }
    if (/^```/.test(line)) {
      flushPara();
      flushList();
      fence = [];
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      const level = heading[1]!.length;
      out.push(`<h${level}>${inline(escapeHtml(heading[2]!))}</h${level}>`);
      continue;
    }

    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (item) {
      flushPara();
      (list ??= []).push(item[1]!);
      continue;
    }
    flushList();

    if (line.trim().length === 0) {
      flushPara();
      continue;
    }
    para.push(line);
  }
  if (fence !== null) out.push(`<pre><code>${escapeHtml(fence.join('\n'))}</code></pre>`);
  flushPara();
  flushList();
  return out.join('\n');
}
