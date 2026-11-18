// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEstopKeyHandlers, ESC_DOUBLE_MS } from './estop';

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup) c();
  cleanup = [];
  document.body.innerHTML = '';
});

function setup() {
  let now = 0;
  const fire = vi.fn();
  const h = createEstopKeyHandlers(fire, () => now);
  window.addEventListener('keydown', h.keydown, true);
  window.addEventListener('keyup', h.keyup, true);
  cleanup.push(() => {
    window.removeEventListener('keydown', h.keydown, true);
    window.removeEventListener('keyup', h.keyup, true);
  });
  const press = (el: Element, key: string, opts: KeyboardEventInit = {}) => {
    const code = key === ' ' ? 'Space' : key;
    const down = new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...opts });
    el.dispatchEvent(down);
    const up = new KeyboardEvent('keyup', { key, code, bubbles: true, cancelable: true, ...opts });
    el.dispatchEvent(up);
    return { down, up };
  };
  return { fire, press, advance: (ms: number) => (now += ms) };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  document.body.appendChild(e);
  return e;
}

describe('E-STOP keyboard (uygulama #3 core side)', () => {
  it('Space on a focused button stops and does not click', () => {
    const { fire, press } = setup();
    const btn = el('button');
    const { down, up } = press(btn, ' ');
    expect(fire).toHaveBeenCalledTimes(1);
    expect(down.defaultPrevented && up.defaultPrevented).toBe(true);
  });

  it('plain Space types in a text field, but Ctrl+Space stops there', () => {
    const { fire, press } = setup();
    const input = el('input', { type: 'text' });
    const plain = press(input, ' ');
    expect(fire).not.toHaveBeenCalled();
    expect(plain.down.defaultPrevented).toBe(false);
    const chord = press(input, ' ', { ctrlKey: true });
    expect(fire).toHaveBeenCalledTimes(1);
    expect(chord.down.defaultPrevented).toBe(true);
  });

  it('Space stops in numeric fields; Esc Esc stops anywhere, also in a textarea', () => {
    const { fire, press, advance } = setup();
    press(el('input', { type: 'text', 'data-numeric': '' }), ' ');
    expect(fire).toHaveBeenCalledTimes(1);
    const ta = el('textarea');
    press(ta, 'Escape');
    expect(fire).toHaveBeenCalledTimes(1);
    advance(ESC_DOUBLE_MS - 100);
    press(ta, 'Escape');
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it('two slow Escapes or an Escape with another key between do not stop', () => {
    const { fire, press, advance } = setup();
    const b = el('div');
    press(b, 'Escape');
    advance(ESC_DOUBLE_MS + 1);
    press(b, 'Escape');
    press(b, 'a');
    press(b, 'Escape');
    expect(fire).not.toHaveBeenCalled();
  });

  it('Alt/Meta+Space are left to the OS', () => {
    const { fire, press } = setup();
    press(document.body, ' ', { altKey: true });
    press(document.body, ' ', { metaKey: true });
    expect(fire).not.toHaveBeenCalled();
  });
});
