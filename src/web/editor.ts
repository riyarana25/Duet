/**
 * Browser editor — a controlled contenteditable surface over a ClientConnection, with two
 * view modes over the SAME shared text: `code` (mono, line numbers, syntax colours, no
 * wrap) and `doc` (serif, wrapped, prose). Mode is a per-client rendering choice — peers
 * can view one document differently and still converge, because the CRDT text is the
 * single source of truth either way.
 *
 * Every keystroke is intercepted (`beforeinput`, preventDefault), translated into CRDT
 * ops, and the surface is re-rendered from `conn.text()`. The browser never holds
 * authoritative text.
 *
 * Rendering is layered so the caret math stays simple:
 *   - `.doc` (contenteditable) holds ONE plain text node — it owns the caret, selection,
 *     and input events. In code mode its text is transparent and…
 *   - `.highlight` behind it paints the SAME text with highlight.js colours; both layers
 *     share font metrics, so they align glyph-for-glyph. (Doc mode simply shows the
 *     text and hides the underlay.)
 *   - `.cursors` overlays remote carets inside the scrolled content, so they track
 *     scrolling for free.
 * In code mode lines never wrap (white-space: pre + horizontal scroll), so the gutter is
 * just "1..N at the shared line-height" — no per-line measurement.
 *
 * Caret is tracked as a CRDT element id (the char to its left) so it survives remote
 * edits. See design.md for the visual rationale.
 */
import { ClientConnection } from '../client/connection';
import { browserWsTransport } from '../client/transport.browser';
import { ElementId } from '../crdt/types';
import { AIAction } from '../ai/aiService';
import { CursorPos, PresenceUser } from '../net/protocol';
import { highlightAs, detectLanguage, LANGUAGE_OPTIONS } from './highlight';

export interface EditorOptions {
  root: HTMLElement;
  wsUrl: string;
  docId: string;
  user: PresenceUser;
}

type Mode = 'code' | 'doc';

const INDENT = '  ';
const DETECT_DEBOUNCE_MS = 400;

export function mountEditor(opts: EditorOptions): ClientConnection {
  const { root, wsUrl, docId, user } = opts;

  // ---- DOM scaffold ----
  root.innerHTML = '';

  const roomEl = el('div', 'room');
  const roomLabel = el('span', 'room-label');
  roomLabel.textContent = 'room';
  const roomName = el('span', 'room-name');
  roomName.textContent = docId;
  roomEl.append(roomLabel, roomName);

  const peersEl = el('div', 'peers');

  // Code / Doc mode switch.
  const modeSeg = el('div', 'mode-seg');
  const modeCode = segBtn('code');
  const modeDoc = segBtn('doc');
  modeSeg.append(modeCode, modeDoc);

  // Language picker (code mode only).
  const langSelect = document.createElement('select');
  langSelect.className = 'lang-select';
  langSelect.title = 'Syntax language';
  for (const o of LANGUAGE_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    langSelect.appendChild(opt);
  }

  const aiBar = el('div', 'ai-bar');
  const aiPrimary = button('Explain');
  const aiSecondary = button('Refactor');
  const aiStatus = el('span', 'ai-status');
  aiBar.append(aiPrimary, aiSecondary, aiStatus);

  const themeBtn = el('button', 'theme-btn');
  themeBtn.type = 'button';
  themeBtn.title = 'Toggle theme';

  const chrome = el('div', 'chrome');
  chrome.append(roomEl, peersEl, modeSeg, langSelect, aiBar, themeBtn);

  const gutter = el('div', 'gutter');
  const docEl = el('div', 'doc');
  docEl.contentEditable = 'true';
  docEl.spellcheck = false;
  docEl.setAttribute('role', 'textbox');
  docEl.setAttribute('aria-multiline', 'true');
  const highlightEl = el('div', 'highlight');
  highlightEl.setAttribute('aria-hidden', 'true');
  const cursorsLayer = el('div', 'cursors');

  const stack = el('div', 'code-stack');
  stack.append(highlightEl, docEl, cursorsLayer);
  const scroll = el('div', 'code-scroll');
  scroll.appendChild(stack);
  const shell = el('div', 'editor-shell');
  shell.append(gutter, scroll);

  const statusLeft = el('span', 'status-pos');
  const statusRight = el('span', 'status-net');
  const statusbar = el('div', 'statusbar');
  statusbar.append(statusLeft, statusRight);

  root.append(chrome, shell, statusbar);

  // ---- theme ----
  const applyTheme = (theme: string): void => {
    document.documentElement.dataset.theme = theme;
    themeBtn.textContent = theme === 'dark' ? '☼' : '☾'; // ☼ / ☾ = what you switch TO
  };
  applyTheme(document.documentElement.dataset.theme ?? 'dark');
  themeBtn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    store('editor.theme', next);
  });

  // ---- mode / language state ----
  let mode: Mode = readStored('editor.mode') === 'doc' ? 'doc' : 'code';
  let langChoice = readStored('editor.lang') ?? 'auto';
  if (!LANGUAGE_OPTIONS.some((o) => o.value === langChoice)) langChoice = 'auto';
  langSelect.value = langChoice;
  let detected = 'plaintext'; // cached auto-detection result (a full pass is too slow per keystroke)
  let detectTimer: ReturnType<typeof setTimeout> | null = null;

  const applyMode = (m: Mode): void => {
    mode = m;
    root.classList.toggle('mode-doc', m === 'doc');
    modeCode.classList.toggle('active', m === 'code');
    modeDoc.classList.toggle('active', m === 'doc');
    langSelect.style.display = m === 'code' ? '' : 'none';
    aiPrimary.textContent = m === 'code' ? 'Explain' : 'Summarize';
    aiSecondary.textContent = m === 'code' ? 'Refactor' : 'Improve';
    store('editor.mode', m);
  };
  modeCode.addEventListener('click', () => {
    applyMode('code');
    render();
  });
  modeDoc.addEventListener('click', () => {
    applyMode('doc');
    render();
  });
  langSelect.addEventListener('change', () => {
    langChoice = langSelect.value;
    store('editor.lang', langChoice);
    render();
  });
  applyMode(mode);

  // ---- connection ----
  const conn = new ClientConnection(
    browserWsTransport(`${wsUrl}/?doc=${encodeURIComponent(docId)}`),
    docId,
    user,
    { flushIntervalMs: 50 },
  );

  // Caret tracked as the element id to its left (null = doc start) — survives remote edits.
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

  function caretModelIndex(): number {
    return conn.caretIndex({ anchor: caretAnchor, focus: caretAnchor });
  }

  // ---- rendering ----
  function effectiveLang(): string {
    return langChoice === 'auto' ? detected : langChoice;
  }

  function render(): void {
    const text = conn.text();
    const focused = document.activeElement === docEl;
    docEl.textContent = text;
    if (mode === 'code') {
      highlightEl.innerHTML = highlightAs(text, effectiveLang());
      renderGutter(text);
      scheduleDetect(text);
    } else {
      highlightEl.innerHTML = '';
      gutter.textContent = '';
    }
    if (focused) placeDomCaret(caretModelIndex());
    renderCursors();
    renderPeers();
    renderStatus();
  }

  /** Re-run auto-detection at most once per pause in typing; re-render only on change. */
  function scheduleDetect(text: string): void {
    if (langChoice !== 'auto') return;
    if (detectTimer) clearTimeout(detectTimer);
    detectTimer = setTimeout(() => {
      detectTimer = null;
      const lang = detectLanguage(text);
      if (lang !== detected) {
        detected = lang;
        render();
      }
    }, DETECT_DEBOUNCE_MS);
  }

  function renderGutter(text: string): void {
    const lines = text.length === 0 ? 1 : text.split('\n').length;
    let nums = '';
    for (let n = 1; n <= lines; n++) nums += (n === 1 ? '' : '\n') + n;
    gutter.textContent = nums;
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
    // Positions are relative to the scrolled content, so remote carets move with scroll.
    const base = stack.getBoundingClientRect();
    for (const p of conn.remotePresence()) {
      if (!p.cursor) continue;
      const idx = conn.caretIndex(p.cursor);
      const rect = caretRect(idx);
      if (!rect) continue;
      const atEnd = idx >= textLen() && textLen() > 0;
      const left = (atEnd ? rect.right : rect.left) - base.left;
      const top = rect.top - base.top;
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
    peersEl.appendChild(chip(user.name, user.color, true));
    for (const p of conn.remotePresence()) peersEl.appendChild(chip(p.user.name, p.user.color, false));
  }

  function renderStatus(): void {
    const text = conn.text();
    if (mode === 'code') {
      const idx = caretModelIndex();
      const upTo = text.slice(0, idx);
      const lastNl = upTo.lastIndexOf('\n');
      const line = (upTo.match(/\n/g)?.length ?? 0) + 1;
      const col = idx - lastNl; // works for lastNl === -1 too (col = idx + 1)
      statusLeft.textContent = `Ln ${line}, Col ${col}`;
    } else {
      const words = text.split(/\s+/).filter(Boolean).length;
      statusLeft.textContent = `${words} word${words === 1 ? '' : 's'}`;
    }
    const online = conn.remotePresence().length + 1;
    const state = conn.isSynced ? 'synced' : conn.isOpen ? 'connecting' : 'offline';
    const langBit =
      mode === 'code'
        ? `${langChoice === 'auto' ? `auto · ${labelOf(effectiveLang())}` : labelOf(langChoice)} · `
        : '';
    statusRight.textContent = `${langBit}${online} online · ${state}`;
  }

  // ---- local editing ----
  function replaceRange(start: number, end: number, text: string): void {
    if (end > start) conn.deleteRange(start, end - start);
    if (text.length > 0) conn.insertText(start, text);
    setCaretIndex(start + text.length);
  }

  /** Leading whitespace of the line containing `index` — reused for auto-indent. */
  function lineIndent(index: number): string {
    const text = conn.text();
    const lineStart = text.lastIndexOf('\n', index - 1) + 1;
    let i = lineStart;
    while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
    return text.slice(lineStart, Math.min(i, index)); // never indent past the caret
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
        // Auto-indent is a code-mode behaviour; prose just gets the newline.
        replaceRange(start, end, mode === 'code' ? '\n' + lineIndent(start) : '\n');
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

  // Tab types an indent instead of moving focus — table stakes for a code surface.
  docEl.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const sel = modelSelection();
    if (!sel) return;
    replaceRange(sel.start, sel.end, INDENT);
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
    renderStatus();
    sendCursor();
  });

  // ---- AI panel ----
  // UI verbs are mode-flavoured; on the wire they map to the protocol's two actions
  // (Explain/Summarize -> 'summarize', Refactor/Improve -> 'improve') so the server and
  // tests are untouched.
  function aiHandler(action: AIAction): () => void {
    return () => {
      const sel = modelSelection();
      if (!sel || sel.start === sel.end) {
        aiStatus.textContent = 'Select something first.';
        return;
      }
      aiStatus.textContent = 'Working…';
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
    aiPrimary.disabled = v;
    aiSecondary.disabled = v;
  }
  // preventDefault on mousedown keeps the text selection while the button takes the click.
  for (const b of [aiPrimary, aiSecondary]) b.addEventListener('mousedown', (e) => e.preventDefault());
  aiPrimary.addEventListener('click', aiHandler('summarize'));
  aiSecondary.addEventListener('click', aiHandler('improve'));

  // ---- wire connection events ----
  conn.on('change', () => render());
  conn.on('presence', () => {
    renderCursors();
    renderPeers();
    renderStatus();
  });
  conn.on('sync', () => {
    render();
    docEl.focus();
    placeDomCaret(textLen());
    setCaretIndex(textLen());
  });
  conn.on('close', () => renderStatus());
  window.addEventListener('resize', () => renderCursors());
  render();

  return conn;
}

// ---- small helpers ----
function labelOf(lang: string): string {
  return LANGUAGE_OPTIONS.find((o) => o.value === lang)?.label ?? lang;
}
function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* fine — preference just won't persist */
  }
}
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
function segBtn(label: string): HTMLButtonElement {
  const b = el('button', 'mode-btn');
  b.textContent = label;
  b.type = 'button';
  return b;
}
function chip(name: string, color: string, isSelf: boolean): HTMLElement {
  const c = el('span', 'peer');
  const dot = el('span', 'peer-dot');
  dot.style.background = color;
  const text = document.createElement('span');
  text.textContent = isSelf ? `${name} (you)` : name;
  c.append(dot, text);
  return c;
}
