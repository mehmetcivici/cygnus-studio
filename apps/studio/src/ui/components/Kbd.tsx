import type { ReactNode } from 'react';
import './Kbd.css';

/** Keyboard key cap for shortcut hints. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="cy-kbd">{children}</kbd>;
}
