/** Browser entry: build a user identity, derive the room + WS URL, mount the editor. */
import { mountEditor } from './editor';
import { newId } from '../util/id';
import { PresenceUser } from '../net/protocol';

// One accent-free, distinct color per user (chosen from a calm editorial palette).
const COLORS = ['#b45309', '#1d4ed8', '#15803d', '#9d174d', '#7c3aed', '#0e7490', '#a16207'];
const NAMES = ['Ada', 'Alan', 'Grace', 'Edsger', 'Barbara', 'Donald', 'Katherine', 'Linus'];

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

const params = new URLSearchParams(location.search);
const docId = params.get('doc') ?? 'welcome';

const user: PresenceUser = {
  userId: newId(),
  name: `${pick(NAMES)} ${Math.floor(Math.random() * 90 + 10)}`,
  color: pick(COLORS),
};

const wsProtocol = location.protocol === 'https:' ? 'wss' : 'ws';
const wsUrl = `${wsProtocol}://${location.host}`;

const root = document.getElementById('app');
if (root) {
  mountEditor({ root, wsUrl, docId, user });
}
