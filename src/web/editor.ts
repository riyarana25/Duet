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
 *
 * Trailing-newline sentinel: a caret placed after a final "\n" has no line box, so the
 * browser draws it at the end of the PREVIOUS line (the classic contenteditable bug:
 * press Enter, the gutter grows but the caret doesn't move). When the model text ends
 * with "\n" we render ONE extra "\n" into the DOM so the last line has a line box; all
 * model<->DOM index mapping clamps to the model length, so the sentinel is invisible to
 * editing.
 */
import { ClientConnection } from '../client/connection';
import { browserWsTransport } from '../client/transport.browser';
import { ElementId } from '../crdt/types';
import { AIAction } from '../ai/aiService';
import { ChatBroadcast, CursorPos, PresenceUser } from '../net/protocol';
import { highlightAs, detectLanguage, LANGUAGE_OPTIONS } from './highlight';
import { checkSyntax, Diagnostic } from './diagnostics';
import { completions } from './complete';
import { runPython } from './runner';
import { renderMarkdown } from './markdown';

export interface EditorOptions {
  root: HTMLElement;
  wsUrl: string;
  docId: string;
  user: PresenceUser;
}

type Mode = 'code' | 'doc';

const INDENT = '  ';
const ANALYSIS_DEBOUNCE_MS = 400;

export function mountEditor(opts: EditorOptions): ClientConnection {
  const { root, wsUrl, docId, user } = opts;

  // ---- DOM scaffold ----
  root.innerHTML = '';

  // Filename tab: room name + an extension that follows the active language/mode.
  const tab = el('div', 'tab');
  tab.title = `room: ${docId}`;
  const tabName = el('span', 'tab-name');
  tabName.textContent = docId;
  const tabExt = el('span', 'tab-ext');
  tab.append(tabName, tabExt);

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

  // Doc-mode formatting toolbar: markdown insertion + a live preview toggle. Formatting
  // lives IN the shared text (markdown), so it collaborates like any other keystroke.
  const docTools = el('div', 'doc-tools');
  const tH1 = toolBtn('H1', 'Heading 1');
  const tH2 = toolBtn('H2', 'Heading 2');
  const tBold = toolBtn('B', 'Bold (Ctrl+B)');
  tBold.style.fontWeight = '700';
  const tItalic = toolBtn('I', 'Italic (Ctrl+I)');
  tItalic.style.fontStyle = 'italic';
  const tCode = toolBtn('‹›', 'Inline code');
  const tList = toolBtn('•', 'Bullet list');
  const tPreview = toolBtn('preview', 'Toggle rendered preview');
  docTools.append(tH1, tH2, tBold, tItalic, tCode, tList, tPreview);

  // Run button (Python via Pyodide; visible only when the active language is python).
  const runBtn = el('button', 'run-btn');
  runBtn.type = 'button';
  runBtn.textContent = '▶ run';
  runBtn.title = 'Run as Python (sandboxed)';

  // Share: the room already lives in the URL — collaborating is "send this link".
  const shareBtn = el('button', 'share-btn');
  shareBtn.type = 'button';
  shareBtn.textContent = 'share';
  shareBtn.title = 'Copy the room link';

  const chatBtn = el('button', 'share-btn');
  chatBtn.type = 'button';
  chatBtn.textContent = 'chat';
  chatBtn.title = 'Room chat';

  const aiBar = el('div', 'ai-bar');
  const aiPrimary = button('Explain');
  const aiSecondary = button('Refactor');
  const aiStatus = el('span', 'ai-status');
  aiBar.append(aiPrimary, aiSecondary, aiStatus);

  const themeBtn = el('button', 'theme-btn');
  themeBtn.type = 'button';
  themeBtn.title = 'Toggle theme';

  const chrome = el('div', 'chrome');
  chrome.append(tab, peersEl, modeSeg, docTools, langSelect, runBtn, aiBar, chatBtn, shareBtn, themeBtn);

  const gutter = el('div', 'gutter');
  const docEl = el('div', 'doc');
  docEl.contentEditable = 'true';
  docEl.spellcheck = false;
  docEl.setAttribute('role', 'textbox');
  docEl.setAttribute('aria-multiline', 'true');
  const highlightEl = el('div', 'highlight');
  highlightEl.setAttribute('aria-hidden', 'true');
  const cursorsLayer = el('div', 'cursors');

  const acMenu = el('div', 'autocomplete');
  acMenu.style.display = 'none';

  const stack = el('div', 'code-stack');
  stack.append(highlightEl, docEl, cursorsLayer, acMenu);
  const previewEl = el('div', 'preview');
  previewEl.style.display = 'none';
  const scroll = el('div', 'code-scroll');
  scroll.append(stack, previewEl);
  const shell = el('div', 'editor-shell');
  shell.append(gutter, scroll);

  // Status bar: position + diagnostics on the left; language, peers, link state right.
  const posEl = el('span', 'status-pos');
  const diagEl = el('span', 'status-diag');
  const statusLeftGroup = el('div', 'status-group');
  statusLeftGroup.append(posEl, diagEl);
  const langEl = el('span', 'status-lang');
  const onlineEl = el('span', 'status-online');
  const stateEl = el('span', 'status-state');
  const statusRightGroup = el('div', 'status-group');
  statusRightGroup.append(langEl, onlineEl, stateEl);
  const statusbar = el('div', 'statusbar');
  statusbar.append(statusLeftGroup, statusRightGroup);

  // Output panel for Run results — hidden until the first run.
  const outputTitle = el('span', 'output-title');
  const outputClose = el('button', 'output-close');
  outputClose.type = 'button';
  outputClose.textContent = '✕';
  const outputHead = el('div', 'output-head');
  outputHead.append(outputTitle, outputClose);
  const outputBody = el('pre', 'output-body');
  const outputEl = el('div', 'output');
  outputEl.style.display = 'none';
  outputEl.append(outputHead, outputBody);
  outputClose.addEventListener('click', () => {
    outputEl.style.display = 'none';
  });

  // Room chat panel — ephemeral, per-room, identity stamped by the server.
  const chatTitle = el('span', 'output-title');
  chatTitle.textContent = 'room chat';
  const chatCloseBtn = el('button', 'output-close');
  chatCloseBtn.type = 'button';
  chatCloseBtn.textContent = '✕';
  const chatHead = el('div', 'chat-head');
  chatHead.append(chatTitle, chatCloseBtn);
  const chatMsgs = el('div', 'chat-msgs');
  const chatInput = document.createElement('input');
  chatInput.className = 'chat-input';
  chatInput.type = 'text';
  chatInput.placeholder = 'Message the room…';
  chatInput.maxLength = 500;
  chatInput.spellcheck = false;
  const chatPanel = el('div', 'chat-panel');
  chatPanel.style.display = 'none';
  chatPanel.append(chatHead, chatMsgs, chatInput);

  root.append(chrome, shell, outputEl, chatPanel, statusbar);

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

  // ---- mode / language / analysis state ----
  let mode: Mode = readStored('editor.mode') === 'doc' ? 'doc' : 'code';
  let langChoice = readStored('editor.lang') ?? 'auto';
  if (!LANGUAGE_OPTIONS.some((o) => o.value === langChoice)) langChoice = 'auto';
  langSelect.value = langChoice;
  let detected = 'plaintext'; // cached auto-detection (a full pass is too slow per keystroke)
  let diag: Diagnostic | null = null;
  let analysisTimer: ReturnType<typeof setTimeout> | null = null;
  let previewing = false;

  const applyMode = (m: Mode): void => {
    mode = m;
    root.classList.toggle('mode-doc', m === 'doc');
    modeCode.classList.toggle('active', m === 'code');
    modeDoc.classList.toggle('active', m === 'doc');
    langSelect.style.display = m === 'code' ? '' : 'none';
    aiPrimary.textContent = m === 'code' ? 'Explain' : 'Summarize';
    aiSecondary.textContent = m === 'code' ? 'Refactor' : 'Improve';
    if (m === 'code') setPreview(false); // preview is a doc-mode concept
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

  // Caret tracked as the element id to its left (null = doc start) — survives remote
  // edits. selAnchor is the selection's OTHER end: when it differs from caretAnchor,
  // peers render the range as a highlight (the protocol carried anchor/focus all along).
  let caretAnchor: ElementId | null = null;
  let selAnchor: ElementId | null = null;
  let suppressSelectionSync = false;
  /** Peer being followed (their caret keeps scrolled into view), or null. */
  let followId: string | null = null;
  /** Peers who authored ops in the last moment → typing indicator on their chip. */
  const typers = new Map<string, ReturnType<typeof setTimeout>>();

  // ---- model <-> DOM selection mapping ----
  const textLen = (): number => conn.text().length;

  /**
   * Global character index of a (node, offset) DOM position within docEl. Clamped to the
   * model length: the DOM may carry one sentinel "\n" beyond the model text.
   */
  function indexFromPoint(node: Node, offset: number): number {
    const textNode = docEl.firstChild;
    if (textNode && node === textNode) return Math.min(offset, textLen());
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
    const i = Math.max(0, Math.min(index, textLen()));
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
    selAnchor = caretAnchor; // editing collapses the selection
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
    // Trailing-newline sentinel (see the header comment): give the final empty line a
    // line box so the caret can actually sit on it.
    docEl.textContent = text.endsWith('\n') ? text + '\n' : text;
    if (mode === 'code') {
      highlightEl.innerHTML = highlightAs(text, effectiveLang());
      renderGutter(text);
      scheduleAnalysis(text);
    } else {
      highlightEl.innerHTML = '';
      gutter.textContent = '';
      diag = null;
      // Live preview: re-render on every change, so it follows remote edits too.
      if (previewing) previewEl.innerHTML = renderMarkdown(text);
    }
    if (focused) placeDomCaret(caretModelIndex());
    renderCursors();
    renderPeers();
    renderStatus();
    refreshAutocomplete();
  }

  /**
   * Deferred per-pause work: language auto-detection and the syntax check. Both cost a
   * full pass over the text, so they run once typing pauses, never per keystroke.
   */
  function scheduleAnalysis(text: string): void {
    if (analysisTimer) clearTimeout(analysisTimer);
    analysisTimer = setTimeout(() => {
      analysisTimer = null;
      let langChanged = false;
      if (langChoice === 'auto') {
        const lang = detectLanguage(text);
        if (lang !== detected) {
          detected = lang;
          langChanged = true;
        }
      }
      diag = checkSyntax(text, effectiveLang());
      if (langChanged) render(); // repaint highlight in the newly detected language
      else renderStatus();
    }, ANALYSIS_DEBOUNCE_MS);
  }

  function renderGutter(text: string): void {
    const lines = text.length === 0 ? 1 : text.split('\n').length;
    let nums = '';
    for (let n = 1; n <= lines; n++) nums += (n === 1 ? '' : '\n') + n;
    gutter.textContent = nums;
  }

  /** Viewport point where a caret at model `index` renders (x, top, height). */
  function caretPoint(index: number): { x: number; y: number; h: number } | null {
    const textNode = docEl.firstChild;
    const domText = textNode && textNode.nodeType === Node.TEXT_NODE ? textNode.textContent ?? '' : '';
    if (domText.length === 0) {
      // Empty doc: the caret sits at the text origin (inside the padding).
      const r = docEl.getBoundingClientRect();
      const cs = getComputedStyle(docEl);
      return {
        x: r.left + parseFloat(cs.paddingLeft),
        y: r.top + parseFloat(cs.paddingTop),
        h: parseFloat(cs.lineHeight) || 20,
      };
    }
    // Note: measured against the DOM text (which may include the sentinel), so a caret
    // on the final empty line lands on that line, not at the end of the previous one.
    const i = Math.max(0, Math.min(index, domText.length));
    const range = document.createRange();
    if (i < domText.length) {
      range.setStart(textNode!, i);
      range.setEnd(textNode!, i + 1);
      const r = range.getClientRects()[0];
      if (r) return { x: r.left, y: r.top, h: r.height || 20 };
    }
    // Caret past the last char: right edge of the last character.
    range.setStart(textNode!, domText.length - 1);
    range.setEnd(textNode!, domText.length);
    const rects = range.getClientRects();
    const last = rects[rects.length - 1];
    return last ? { x: last.right, y: last.top, h: last.height || 20 } : null;
  }

  function renderCursors(): void {
    cursorsLayer.innerHTML = '';
    // Positions are relative to the scrolled content, so remote carets move with scroll.
    const base = stack.getBoundingClientRect();
    const textNode = docEl.firstChild;
    const domLen =
      textNode && textNode.nodeType === Node.TEXT_NODE ? (textNode.textContent ?? '').length : 0;
    let followEl: HTMLElement | null = null;

    for (const p of conn.remotePresence()) {
      if (!p.cursor) continue;
      const focusIdx = conn.caretIndex(p.cursor);
      const anchorIdx = conn.caretIndex({ anchor: p.cursor.anchor, focus: p.cursor.anchor });

      // Selected range → translucent highlight rects (getClientRects handles multi-line).
      if (anchorIdx !== focusIdx && textNode && domLen > 0) {
        const lo = Math.min(anchorIdx, focusIdx);
        const hi = Math.min(Math.max(anchorIdx, focusIdx), domLen);
        if (lo < hi) {
          const range = document.createRange();
          range.setStart(textNode, lo);
          range.setEnd(textNode, hi);
          for (const r of Array.from(range.getClientRects())) {
            const box = el('div', 'remote-sel');
            box.style.left = `${r.left - base.left}px`;
            box.style.top = `${r.top - base.top}px`;
            box.style.width = `${Math.max(r.width, 2)}px`;
            box.style.height = `${r.height}px`;
            box.style.background = p.user.color;
            cursorsLayer.appendChild(box);
          }
        }
      }

      const pt = caretPoint(focusIdx);
      if (!pt) continue;
      const caret = el('div', 'remote-caret');
      caret.style.left = `${pt.x - base.left}px`;
      caret.style.top = `${pt.y - base.top}px`;
      caret.style.height = `${pt.h}px`;
      caret.style.background = p.user.color;

      const label = el('div', 'remote-label');
      label.textContent = p.user.name;
      label.style.background = p.user.color;
      caret.appendChild(label);
      cursorsLayer.appendChild(caret);
      if (p.clientId === followId) followEl = caret;
    }
    // Follow mode: keep the followed peer's caret in view as they move around.
    if (followEl) followEl.scrollIntoView({ block: 'center', inline: 'nearest' });
  }

  function toggleFollow(clientId: string): void {
    followId = followId === clientId ? null : clientId;
    renderPeers();
    renderCursors();
  }

  function renderPeers(): void {
    peersEl.innerHTML = '';
    peersEl.appendChild(chip(user.name, user.color, { self: true }));
    const present = new Set<string>();
    for (const p of conn.remotePresence()) {
      present.add(p.clientId);
      peersEl.appendChild(
        chip(p.user.name, p.user.color, {
          typing: typers.has(p.clientId),
          following: followId === p.clientId,
          onClick: () => toggleFollow(p.clientId),
        }),
      );
    }
    if (followId && !present.has(followId)) followId = null; // they left
  }

  function renderStatus(): void {
    const text = conn.text();

    // Filename tab follows the active language (doc mode reads as markdown).
    const ext = mode === 'doc' ? 'md' : extOf(effectiveLang());
    tabExt.textContent = `.${ext}`;

    // Run is real execution and only exists where we have a runtime: Python.
    runBtn.style.display = mode === 'code' && effectiveLang() === 'python' ? '' : 'none';

    if (mode === 'code') {
      const idx = caretModelIndex();
      const upTo = text.slice(0, idx);
      const lastNl = upTo.lastIndexOf('\n');
      const line = (upTo.match(/\n/g)?.length ?? 0) + 1;
      const col = idx - lastNl; // works for lastNl === -1 too (col = idx + 1)
      posEl.textContent = `Ln ${line}, Col ${col}`;
      langEl.textContent = langChoice === 'auto' ? `auto · ${labelOf(effectiveLang())}` : labelOf(langChoice);
    } else {
      const words = text.split(/\s+/).filter(Boolean).length;
      posEl.textContent = `${words} word${words === 1 ? '' : 's'}`;
      langEl.textContent = '';
    }

    if (diag === null) {
      diagEl.textContent = '';
      diagEl.className = 'status-diag';
    } else if (diag.ok) {
      diagEl.textContent = '✓ syntax ok';
      diagEl.className = 'status-diag ok';
    } else {
      diagEl.textContent = `✗ ${diag.line ? `Ln ${diag.line} — ` : ''}${diag.message ?? 'syntax error'}`;
      diagEl.className = 'status-diag err';
    }

    const online = conn.remotePresence().length + 1;
    onlineEl.textContent = `${online} online`;
    const state = conn.isSynced ? 'synced' : conn.isOpen ? 'connecting' : 'offline';
    stateEl.textContent = `● ${state}`;
    stateEl.className = `status-state ${state === 'synced' ? 'ok' : state === 'connecting' ? 'warn' : 'err'}`;
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
        if (end > start) {
          conn.deleteRange(start, end - start);
          setCaretIndex(start);
        } else if (start > 0) {
          conn.delete(start - 1);
          setCaretIndex(start - 1);
        }
        break;
      case 'deleteWordBackward': {
        // Ctrl+Backspace: eat the whole word (or punctuation run) left of the caret.
        if (end > start) {
          conn.deleteRange(start, end - start);
          setCaretIndex(start);
        } else if (start > 0) {
          const from = prevWordStart(conn.text(), start);
          conn.deleteRange(from, start - from);
          setCaretIndex(from);
        }
        break;
      }
      case 'deleteContentForward':
        if (end > start) {
          conn.deleteRange(start, end - start);
          setCaretIndex(start);
        } else if (start < textLen()) {
          conn.delete(start);
          setCaretIndex(start);
        }
        break;
      case 'deleteWordForward': {
        // Ctrl+Delete: eat the whole word right of the caret.
        if (end > start) {
          conn.deleteRange(start, end - start);
          setCaretIndex(start);
        } else if (start < textLen()) {
          const to = nextWordEnd(conn.text(), start);
          conn.deleteRange(start, to - start);
          setCaretIndex(start);
        }
        break;
      }
      default:
        return; // unhandled input type — leave model untouched
    }
    // Autocomplete opens while typing word characters, survives backspaces, and closes
    // on anything else; refreshAutocomplete() (called from render) does the matching.
    if (e.inputType === 'insertText') acWanted = !!(e.data && /[\w$]/.test(e.data));
    else if (e.inputType !== 'deleteContentBackward' && e.inputType !== 'deleteWordBackward') acWanted = false;
    followId = null; // editing yourself ends follow mode
    render();
    sendCursor();
  });

  // Keyboard: autocomplete navigation wins while the menu is open; otherwise Tab types
  // an indent instead of moving focus — table stakes for a code surface.
  docEl.addEventListener('keydown', (e: KeyboardEvent) => {
    // Doc-mode formatting shortcuts.
    if (mode === 'doc' && (e.ctrlKey || e.metaKey)) {
      const k = e.key.toLowerCase();
      if (k === 'b') {
        e.preventDefault();
        mdWrap('**');
        return;
      }
      if (k === 'i') {
        e.preventDefault();
        mdWrap('*');
        return;
      }
    }
    if (acOpen()) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        acSel = (acSel + (e.key === 'ArrowDown' ? 1 : acItems.length - 1)) % acItems.length;
        renderAcMenu();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        acceptAc();
        return;
      }
      if (e.key === 'Escape') {
        acWanted = false;
        hideAc();
        return;
      }
    }
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const sel = modelSelection();
    if (!sel) return;
    replaceRange(sel.start, sel.end, INDENT);
    render();
    sendCursor();
  });

  docEl.addEventListener('blur', () => {
    acWanted = false;
    hideAc();
  });

  docEl.addEventListener('paste', (ev: ClipboardEvent) => {
    ev.preventDefault();
    const text = ev.clipboardData?.getData('text/plain') ?? '';
    const sel = modelSelection();
    if (!sel || text.length === 0) return;
    replaceRange(sel.start, sel.end, text);
    acWanted = false;
    render();
    sendCursor();
  });

  // ---- word boundaries (Ctrl+Backspace / Ctrl+Delete) ----
  const isWordCh = (c: string): boolean => /[\w$]/.test(c);
  const isSpaceCh = (c: string): boolean => c === ' ' || c === '\t';

  /** Start of the deletion Ctrl+Backspace should make from `i`: skip spaces, then eat a
   *  word or a punctuation run; at a line start, eat just the newline. */
  function prevWordStart(text: string, i: number): number {
    let j = i;
    while (j > 0 && isSpaceCh(text[j - 1]!)) j--;
    if (j > 0 && text[j - 1] === '\n') return j === i ? j - 1 : j;
    if (j > 0 && isWordCh(text[j - 1]!)) {
      while (j > 0 && isWordCh(text[j - 1]!)) j--;
    } else {
      while (j > 0 && !isWordCh(text[j - 1]!) && !isSpaceCh(text[j - 1]!) && text[j - 1] !== '\n') j--;
    }
    return j;
  }

  /** Mirror of prevWordStart for Ctrl+Delete. */
  function nextWordEnd(text: string, i: number): number {
    let j = i;
    while (j < text.length && isSpaceCh(text[j]!)) j++;
    if (j < text.length && text[j] === '\n') return j === i ? j + 1 : j;
    if (j < text.length && isWordCh(text[j]!)) {
      while (j < text.length && isWordCh(text[j]!)) j++;
    } else {
      while (j < text.length && !isWordCh(text[j]!) && !isSpaceCh(text[j]!) && text[j] !== '\n') j++;
    }
    return j;
  }

  // ---- autocomplete ----
  let acItems: string[] = [];
  let acSel = 0;
  let acPrefix = '';
  let acWanted = false; // true only while the user is typing word characters

  function acOpen(): boolean {
    return acMenu.style.display !== 'none';
  }
  function hideAc(): void {
    acMenu.style.display = 'none';
    acItems = [];
  }

  /** The word being typed, left of the caret (≥ 2 chars, not a number). */
  function currentPrefix(): { start: number; word: string } | null {
    const i = caretModelIndex();
    const text = conn.text();
    let s = i;
    while (s > 0 && isWordCh(text[s - 1]!)) s--;
    const word = text.slice(s, i);
    if (word.length < 2 || /^\d/.test(word)) return null;
    return { start: s, word };
  }

  /** Recompute the menu against the current caret/text; called from render(). */
  function refreshAutocomplete(): void {
    if (!acWanted || mode !== 'code') {
      hideAc();
      return;
    }
    const p = currentPrefix();
    if (!p) {
      hideAc();
      return;
    }
    const items = completions(conn.text(), effectiveLang(), p.word);
    if (items.length === 0) {
      hideAc();
      return;
    }
    acItems = items;
    acSel = Math.min(acSel, items.length - 1);
    acPrefix = p.word;
    const pt = caretPoint(caretModelIndex());
    if (!pt) {
      hideAc();
      return;
    }
    const base = stack.getBoundingClientRect();
    acMenu.style.left = `${pt.x - base.left}px`;
    acMenu.style.top = `${pt.y - base.top + pt.h + 4}px`;
    renderAcMenu();
    acMenu.style.display = '';
  }

  function renderAcMenu(): void {
    acMenu.innerHTML = '';
    acItems.forEach((word, i) => {
      const item = el('div', i === acSel ? 'ac-item active' : 'ac-item');
      const hit = el('span', 'ac-hit');
      hit.textContent = acPrefix;
      item.append(hit, document.createTextNode(word.slice(acPrefix.length)));
      item.addEventListener('mousedown', (ev) => ev.preventDefault()); // keep focus/caret
      item.addEventListener('click', () => {
        acSel = i;
        acceptAc();
      });
      acMenu.appendChild(item);
    });
  }

  function acceptAc(): void {
    const word = acItems[acSel];
    acWanted = false;
    hideAc();
    if (!word) return;
    const idx = caretModelIndex();
    const remainder = word.slice(acPrefix.length);
    if (remainder.length > 0) {
      conn.insertText(idx, remainder);
      setCaretIndex(idx + remainder.length);
    }
    render();
    sendCursor();
  }

  // ---- doc-mode formatting (markdown into the shared text) ----
  function setPreview(v: boolean): void {
    if (previewing === v) return;
    previewing = v;
    stack.style.display = v ? 'none' : '';
    previewEl.style.display = v ? '' : 'none';
    tPreview.classList.toggle('active', v);
    render();
    if (!v) docEl.focus();
  }

  /** Wrap the selection in `marker` (e.g. ** for bold). */
  function mdWrap(marker: string): void {
    const sel = modelSelection();
    if (!sel || sel.start === sel.end) {
      aiStatus.textContent = 'Select some text first.';
      return;
    }
    conn.insertText(sel.end, marker); // end first so the start index stays valid
    conn.insertText(sel.start, marker);
    setCaretIndex(sel.end + marker.length * 2);
    render();
    sendCursor();
  }

  /** Toggle a `#`-heading prefix on the caret's line (same level toggles off). */
  function mdHeading(level: number): void {
    const sel = modelSelection();
    const at = sel ? sel.start : caretModelIndex();
    const text = conn.text();
    const ls = text.lastIndexOf('\n', at - 1) + 1;
    const m = /^(#{1,6}) /.exec(text.slice(ls, ls + 8));
    const target = '#'.repeat(level) + ' ';
    let delta = 0;
    if (m && m[1]!.length === level) {
      conn.deleteRange(ls, m[0].length);
      delta = -m[0].length;
    } else if (m) {
      conn.deleteRange(ls, m[0].length);
      conn.insertText(ls, target);
      delta = target.length - m[0].length;
    } else {
      conn.insertText(ls, target);
      delta = target.length;
    }
    setCaretIndex(Math.max(ls, at + delta));
    render();
    sendCursor();
  }

  /** Toggle `- ` bullets on every line the selection touches. */
  function mdList(): void {
    const sel = modelSelection();
    const start = sel ? sel.start : caretModelIndex();
    const end = sel ? sel.end : start;
    const text = conn.text();
    const starts: number[] = [text.lastIndexOf('\n', start - 1) + 1];
    for (let i = starts[0]!; i < end && i < text.length; i++) {
      if (text[i] === '\n') starts.push(i + 1);
    }
    // Back to front so earlier line starts stay valid as we edit.
    for (let k = starts.length - 1; k >= 0; k--) {
      const s = starts[k]!;
      if (text.startsWith('- ', s)) conn.deleteRange(s, 2);
      else conn.insertText(s, '- ');
    }
    render();
    sendCursor();
  }

  for (const b of [tH1, tH2, tBold, tItalic, tCode, tList, tPreview]) {
    b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
  }
  tH1.addEventListener('click', () => mdHeading(1));
  tH2.addEventListener('click', () => mdHeading(2));
  tBold.addEventListener('click', () => mdWrap('**'));
  tItalic.addEventListener('click', () => mdWrap('*'));
  tCode.addEventListener('click', () => mdWrap('`'));
  tList.addEventListener('click', () => mdList());
  tPreview.addEventListener('click', () => setPreview(!previewing));

  // ---- share ----
  shareBtn.addEventListener('click', () => {
    const url = location.href;
    const done = (): void => {
      shareBtn.textContent = 'copied ✓';
      setTimeout(() => {
        shareBtn.textContent = 'share';
      }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, () => window.prompt('Copy this link:', url));
    } else {
      window.prompt('Copy this link:', url);
    }
  });

  // ---- room chat ----
  let chatVisible = false;
  let unread = 0;
  function updateChatBtn(): void {
    chatBtn.textContent = unread > 0 ? `chat (${unread})` : 'chat';
    chatBtn.classList.toggle('has-unread', unread > 0);
  }
  function setChatOpen(v: boolean): void {
    chatVisible = v;
    chatPanel.style.display = v ? '' : 'none';
    if (v) {
      unread = 0;
      updateChatBtn();
      chatMsgs.scrollTop = chatMsgs.scrollHeight;
      chatInput.focus();
    }
  }
  chatBtn.addEventListener('click', () => setChatOpen(!chatVisible));
  chatCloseBtn.addEventListener('click', () => setChatOpen(false));
  chatInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    conn.sendChat(chatInput.value);
    chatInput.value = '';
  });
  function appendChat(m: ChatBroadcast): void {
    const row = el('div', 'chat-msg');
    const name = el('span', 'chat-name');
    name.textContent = m.from === conn.clientId ? 'you' : m.name;
    name.style.color = m.color;
    const text = document.createElement('span');
    text.textContent = m.text; // textContent — chat can never inject HTML
    row.append(name, text);
    chatMsgs.appendChild(row);
    while (chatMsgs.children.length > 200) chatMsgs.removeChild(chatMsgs.firstChild!);
    chatMsgs.scrollTop = chatMsgs.scrollHeight;
    if (!chatVisible && m.from !== conn.clientId) {
      unread += 1;
      updateChatBtn();
    }
  }

  // ---- run (Python via Pyodide, sandboxed in a worker) ----
  let running = false;
  runBtn.addEventListener('click', () => {
    if (running) return;
    running = true;
    runBtn.disabled = true;
    outputEl.style.bottom = `${statusbar.offsetHeight}px`;
    outputEl.style.display = '';
    outputTitle.textContent = 'output';
    outputBody.textContent = '';
    runPython(conn.text(), (s) => {
      outputBody.textContent =
        s === 'loading' ? 'loading Python runtime… (first run downloads ~10 MB)' : 'running…';
    }).then((res) => {
      running = false;
      runBtn.disabled = false;
      outputTitle.textContent = `output — ${res.durationMs}ms`;
      outputBody.textContent = res.logs.join('\n');
      if (res.error) {
        const err = el('span', 'output-err');
        err.textContent = (res.logs.length > 0 ? '\n' : '') + res.error;
        outputBody.appendChild(err);
      } else if (res.logs.length === 0) {
        outputBody.textContent = '(no output)';
      }
    });
  });

  // ---- cursor / presence sync ----
  let cursorTimer: ReturnType<typeof setTimeout> | null = null;
  function sendCursor(): void {
    if (cursorTimer) return;
    cursorTimer = setTimeout(() => {
      cursorTimer = null;
      conn.setCursor({ anchor: selAnchor, focus: caretAnchor });
    }, 60);
  }

  document.addEventListener('selectionchange', () => {
    if (suppressSelectionSync) return;
    const sel = modelSelection();
    if (!sel) return;
    // A caret that jumped somewhere else (click, arrows) dismisses the completion menu;
    // the typing path lands on the same index and keeps it.
    if (acOpen() && sel.end !== caretModelIndex()) {
      acWanted = false;
      hideAc();
    }
    setCaretIndex(sel.end);
    if (sel.start !== sel.end) selAnchor = conn.caretAt(sel.start).anchor;
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
  conn.on('activity', (...args: unknown[]) => {
    // A peer authored ops: pulse their chip for a moment.
    const from = args[0] as string;
    const prev = typers.get(from);
    if (prev) clearTimeout(prev);
    typers.set(
      from,
      setTimeout(() => {
        typers.delete(from);
        renderPeers();
      }, 1600),
    );
    renderPeers();
  });
  conn.on('chat', (...args: unknown[]) => appendChat(args[0] as ChatBroadcast));
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
function extOf(lang: string): string {
  return LANGUAGE_OPTIONS.find((o) => o.value === lang)?.ext ?? 'txt';
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
function toolBtn(label: string, title: string): HTMLButtonElement {
  const b = el('button', 'tool-btn');
  b.textContent = label;
  b.type = 'button';
  b.title = title;
  return b;
}
interface ChipOpts {
  self?: boolean;
  typing?: boolean;
  following?: boolean;
  onClick?: () => void;
}
function chip(name: string, color: string, opts: ChipOpts): HTMLElement {
  const c = el('span', 'peer');
  const dot = el('span', opts.typing ? 'peer-dot typing' : 'peer-dot');
  dot.style.background = color;
  const text = document.createElement('span');
  text.textContent = opts.self ? `${name} (you)` : name;
  c.append(dot, text);
  if (opts.typing) {
    const pen = el('span', 'peer-pen');
    pen.textContent = '✎';
    c.appendChild(pen);
  }
  if (opts.onClick) {
    c.classList.add('clickable');
    c.title = opts.following ? 'Following — click to stop' : 'Click to follow their cursor';
    if (opts.following) c.classList.add('following');
    c.addEventListener('click', opts.onClick);
  }
  return c;
}
