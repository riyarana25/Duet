/**
 * Transport: the minimal socket surface ClientConnection needs. Abstracted so the same
 * client logic runs over `ws` in Node (tests / SSR) and the browser's global WebSocket
 * (UI, a later phase) without change.
 */
export interface Transport {
  send(data: string): void;
  close(): void;
  isOpen(): boolean;
  onOpen(cb: () => void): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: () => void): void;
}
