/**
 * Browser entry: apply the saved theme, show a join screen (name / cursor colour / room),
 * then mount the editor with the chosen identity. Name and colour persist in localStorage
 * so returning users land back in with one click.
 */
import { mountEditor } from './editor';
import { newId } from '../util/id';
import { PresenceUser } from '../net/protocol';

// Cursor palette — mid-tone hues that read against both the dark and light themes,
// and carry white label text.
const COLORS = ['#d97706', '#3b82f6', '#059669', '#db2777', '#7c3aed', '#0891b2', '#e11d48'];

// Theme before first paint so the join screen doesn't flash the wrong background.
let saved: string | null = null;
try {
  saved = localStorage.getItem('editor.theme');
} catch {
  /* storage may be unavailable */
}
document.documentElement.dataset.theme = saved === 'light' ? 'light' : 'dark';

const params = new URLSearchParams(location.search);
const root = document.getElementById('app');

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
    /* fine — identity just won't persist */
  }
}

function showJoinScreen(host: HTMLElement): void {
  host.innerHTML = '';

  const card = div('join-card');
  const title = div('join-title');
  title.textContent = 'Join a session';
  const sub = div('join-sub');
  sub.textContent = 'Live collaborative code editing over a hand-written CRDT.';

  const nameField = field('Name');
  const nameInput = nameField.input;
  nameInput.value = readStored('editor.name') ?? '';
  nameInput.placeholder = 'your name';
  nameInput.maxLength = 24;

  const roomField = field('Room');
  const roomInput = roomField.input;
  roomInput.value = params.get('doc') ?? 'welcome';
  roomInput.placeholder = 'room name';
  roomInput.maxLength = 64;

  // Colour swatches — the one choice that has no sensible text input.
  const colorLabel = div('join-label');
  colorLabel.textContent = 'Cursor colour';
  const swatches = div('swatches');
  let color = readStored('editor.color') ?? COLORS[Math.floor(Math.random() * COLORS.length)]!;
  if (!COLORS.includes(color)) color = COLORS[0]!;
  const swatchEls: HTMLButtonElement[] = [];
  for (const c of COLORS) {
    const s = document.createElement('button');
    s.type = 'button';
    s.className = 'swatch';
    s.style.background = c;
    s.setAttribute('aria-label', `cursor colour ${c}`);
    s.addEventListener('click', () => {
      color = c;
      for (const other of swatchEls) other.classList.toggle('selected', other === s);
    });
    if (c === color) s.classList.add('selected');
    swatchEls.push(s);
    swatches.appendChild(s);
  }

  const joinBtn = document.createElement('button');
  joinBtn.type = 'button';
  joinBtn.className = 'join-btn';
  joinBtn.textContent = 'Join';

  const join = (): void => {
    const name = nameInput.value.trim() || 'anonymous';
    const room = roomInput.value.trim() || 'welcome';
    store('editor.name', name);
    store('editor.color', color);
    // Keep the room in the URL so it's shareable / survives refresh.
    const url = new URL(location.href);
    url.searchParams.set('doc', room);
    history.replaceState(null, '', url);

    const user: PresenceUser = { userId: newId(), name, color };
    const wsProtocol = location.protocol === 'https:' ? 'wss' : 'ws';
    mountEditor({ root: host, wsUrl: `${wsProtocol}://${location.host}`, docId: room, user });
  };
  joinBtn.addEventListener('click', join);
  card.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') join();
  });

  card.append(title, sub, nameField.wrap, roomField.wrap, colorLabel, swatches, joinBtn);
  const screen = div('join-screen');
  screen.appendChild(card);
  host.appendChild(screen);
  nameInput.focus();
}

function div(className: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = className;
  return d;
}
function field(label: string): { wrap: HTMLDivElement; input: HTMLInputElement } {
  const wrap = div('join-field');
  const l = div('join-label');
  l.textContent = label;
  const input = document.createElement('input');
  input.className = 'join-input';
  input.type = 'text';
  input.spellcheck = false;
  wrap.append(l, input);
  return { wrap, input };
}

if (root) showJoinScreen(root);
