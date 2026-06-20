/**
 * Browser editor — a CONTROLLED contenteditable surface over a ClientConnection.
 *
 * The CRDT is the single source of truth: every keystroke is intercepted (`beforeinput`,
 * preventDefault), translated into CRDT ops, and the DOM is re-rendered from `conn.text()`.
 * The browser never holds authoritative text, which sidesteps contenteditable's quirks and
 * keeps local + remote edits converging through the exact same op path.
 *
 * Caret is tracked as a CRDT element id (the char to its left) so it survives remote edits.
 * Remote cursors are drawn as an overlay using Range rects. See design.md for the rationale.
 */
import { ClientConnection } from '../client/connection';
import { browserWsTransport } from '../client/transport.browser';
import { ElementId } from '../crdt/types';
import { AIAction } from '../ai/aiService';
import { CursorPos, PresenceUser } from '../net/protocol';

export interface EditorOptions {
  root: HTMLElement;
  wsUrl: string;
  docId: string;
  user: PresenceUser;
}

const CARET_NULL: CursorPos = { anchor: null, focus: null };

export function mountEditor(opts: EditorOptions): ClientConnection {
  const { root, wsUrl, docId, user } = opts;

  // ---- DOM scaffold ----
  root.innerHTML = '';
  const surface = el('div', 'surface');
  const docEl = el('div', 'doc');
  docEl.contentEditable = 'true';
  docEl.spellcheck = false;
  docEl.setAttribute('role', 'textbox');
  docEl.setAttribute('aria-multiline', 'true');
  const cursorsLayer = el('div', 'cursors');
  surface.appendChild(cursorsLayer);
  surface.appendChild(docEl);

  const aiBar = el('div', 'ai-bar');
  const aiSummarize = button('Summarize');
  const aiImprove = button('Improve');
  const aiStatus = el('span', 'ai-status');
  aiBar.append(aiSummarize, aiImprove, aiStatus);

  const peersEl = el('div', 'peers');

  const chrome = el('div', 'chrome');
  chrome.append(peersEl, aiBar);
  root.append(chrome, surface);

  // ---- connection ----
  const conn = new ClientConnection(
    browserWsTransport(`${wsUrl}/?doc=${encodeURIComponent(docId)}`),
    docId,
    user,
    { flushIntervalMs: 50 },
  );

  // Caret tracked as the element id to its LEFT (null = doc start) — survives remote edits.
  let caretAnchor: ElementId | null = null;
  let suppressSelectionSync = false;

  // ---- model <-> DOM selection mapping ----
  const textLen = (): number => conn.text().length;

  /** Global character index of a (node, offset) DOM position within docEl. */
  function indexFromPoint(node: Node, offset: number): number {
    const textNode = docEl.firstChild;
    if (textNode && node === textNode) return offset;
    if (node === docEl) return offset === 0 ? 0 : textLen();
    return 0;
  }

  /** Current model selection [start, end), or null if not inside the editor. */
  function modelSelection(): { start: number; end: number } | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const r = sel.getRangeAt(0);
    if (!docEl.contains(r.startContainer) || !docEl.contains(r.endContainer)) return null;
    const a = indexFromPoint(r.startContainer, r.startOffset);
    const b = indexFromPoint(r.endContainer, r.endOffset);
    return { start: Math.min(a, b), end: Math.max(a, b) };
  }

  function placeDomCaret(index: number): void {
    const len = textLen();
    const i = Math.max(0, Math.min(index, len));
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    const textNode = docEl.firstChild;
    if (textNode && textNode.nodeType === Node.TEXT_NODE) {
      range.setStart(textNode, Math.min(i, (textNode.textContent ?? '').length));
    } else {
      range.setStart(docEl, 0);
    }
    range.collapse(true);
    suppressSelectionSync = true;
    sel.removeAllRanges();
    sel.addRange(range);
    suppressSelectionSync = false;
  }

  function setCaretIndex(index: number): void {
    caretAnchor = conn.caretAt(index).anchor;
  }

  // ---- rendering ----
  function render(): void {
    const focused = document.activeElement === docEl;
    docEl.textContent = conn.text();
    if (focused) placeDomCaret(conn.caretIndex({ anchor: caretAnchor, focus: caretAnchor }));
    renderCursors();
    renderPeers();
  }

  function caretRect(index: number): DOMRect | null {
    const textNode = docEl.firstChild;
    const len = textLen();
    const range = document.createRange();
    if (textNode && textNode.nodeType === Node.TEXT_NODE && len > 0) {
      const i = Math.max(0, Math.min(index, len));
      if (i < len) {
        range.setStart(textNode, i);
        range.setEnd(textNode, i + 1);
        const r = range.getClientRects()[0];
        if (r) return r;
      }
      // caret at end: take the right edge of the last character
      range.setStart(textNode, len - 1);
      range.setEnd(textNode, len);
      const rects = range.getClientRects();
      const last = rects[rects.length - 1];
      return last ?? null;
    }
    return docEl.getBoundingClientRect();
  }

  function renderCursors(): void {
    cursorsLayer.innerHTML = '';
    const base = surface.getBoundingClientRect();
    for (const p of conn.remotePresence()) {
      if (!p.cursor) continue;
      const idx = conn.caretIndex(p.cursor);
      const rect = caretRect(idx);
      if (!rect) continue;
      const atEnd = idx >= textLen() && textLen() > 0;
      const left = (atEnd ? rect.right : rect.left) - base.left + surface.scrollLeft;
      const top = rect.top - base.top + surface.scrollTop;
      const height = rect.height || 20;

      const caret = el('div', 'remote-caret');
      caret.style.left = `${left}px`;
      caret.style.top = `${top}px`;
      caret.style.height = `${height}px`;
      caret.style.background = p.user.color;

      const label = el('div', 'remote-label');
      label.textContent = p.user.name;
      label.style.background = p.user.color;
      caret.appendChild(label);
      cursorsLayer.appendChild(caret);
    }
  }

  function renderPeers(): void {
    peersEl.innerHTML = '';
    const me = chip(user.name + ' (you)', user.color);
    peersEl.appendChild(me);
    for (const p of conn.remotePresence()) peersEl.appendChild(chip(p.user.name, p.user.color));
  }

  // ---- local editing ----
  function replaceRange(start: number, end: number, text: string): void {
    if (end > start) conn.deleteRange(start, end - start);
    if (text.length > 0) conn.insertText(start, text);
    setCaretIndex(start + text.length);
  }

  docEl.addEventListener('beforeinput', (ev: Event) => {
    const e = ev as InputEvent;
    e.preventDefault();
    const sel = modelSelection();
    if (!sel) return;
    const { start, end } = sel;
    switch (e.inputType) {
      case 'insertText':
        replaceRange(start, end, e.data ?? '');
        break;
      case 'insertParagraph':
      case 'insertLineBreak':
        replaceRange(start, end, '\n');
        break;
      case 'deleteContentBackward':
      case 'deleteWordBackward':
        if (end > start) {
          conn.deleteRange(start, end - start);
          setCaretIndex(start);
        } else if (start > 0) {
          conn.delete(start - 1);
          setCaretIndex(start - 1);
        }
        break;
      case 'deleteContentForward':
      case 'deleteWordForward':
        if (end > start) {
          conn.deleteRange(start, end - start);
          setCaretIndex(start);
        } else if (start < textLen()) {
          conn.delete(start);
          setCaretIndex(start);
        }
        break;
      default:
        return; // unhandled input type — leave model untouched
    }
    render();
    sendCursor();
  });

  docEl.addEventListener('paste', (ev: ClipboardEvent) => {
    ev.preventDefault();
    const text = ev.clipboardData?.getData('text/plain') ?? '';
    const sel = modelSelection();
    if (!sel || text.length === 0) return;
    replaceRange(sel.start, sel.end, text);
    render();
    sendCursor();
  });

  // ---- cursor / presence sync ----
  let cursorTimer: ReturnType<typeof setTimeout> | null = null;
  function sendCursor(): void {
    if (cursorTimer) return;
    cursorTimer = setTimeout(() => {
      cursorTimer = null;
      conn.setCursor({ anchor: caretAnchor, focus: caretAnchor });
    }, 60);
  }

  document.addEventListener('selectionchange', () => {
    if (suppressSelectionSync) return;
    const sel = modelSelection();
    if (!sel) return;
    setCaretIndex(sel.end);
    sendCursor();
  });

  // ---- AI panel ----
  function aiHandler(action: AIAction): () => void {
    return () => {
      const sel = modelSelection();
      if (!sel || sel.start === sel.end) {
        aiStatus.textContent = 'Select some text first.';
        return;
      }
      aiStatus.textContent = action === 'summarize' ? 'Summarizing…' : 'Improving…';
      setButtonsDisabled(true);
      conn
        .transformSelection(action, sel.start, sel.end)
        .then(() => {
          aiStatus.textContent = '';
          render();
        })
        .catch((err: unknown) => {
          aiStatus.textContent = err instanceof Error ? err.message : 'AI request failed';
        })
        .finally(() => setButtonsDisabled(false));
    };
  }
  function setButtonsDisabled(v: boolean): void {
    aiSummarize.disabled = v;
    aiImprove.disabled = v;
  }
  // preventDefault on mousedown keeps the text selection while the button takes the click.
  for (const b of [aiSummarize, aiImprove]) b.addEventListener('mousedown', (e) => e.preventDefault());
  aiSummarize.addEventListener('click', aiHandler('summarize'));
  aiImprove.addEventListener('click', aiHandler('improve'));

  // ---- wire connection events ----
  conn.on('change', () => render());
  conn.on('presence', () => renderCursors());
  conn.on('sync', () => {
    render();
    docEl.focus();
    placeDomCaret(textLen());
    setCaretIndex(textLen());
  });
  window.addEventListener('resize', () => renderCursors());
  surface.addEventListener('scroll', () => renderCursors());

  return conn;
}

// ---- small DOM helpers ----
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}
function button(label: string): HTMLButtonElement {
  const b = el('button', 'ai-btn');
  b.textContent = label;
  b.type = 'button';
  return b;
}
function chip(name: string, color: string): HTMLElement {
  const c = el('span', 'peer');
  const dot = el('span', 'peer-dot');
  dot.style.background = color;
  const text = document.createElement('span');
  text.textContent = name;
  c.append(dot, text);
  return c;
}
