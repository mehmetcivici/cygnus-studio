// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NumberField } from './NumberField';
import { setLang } from '../../i18n';

afterEach(cleanup);

function setup(props: Partial<Parameters<typeof NumberField>[0]> = {}) {
  setLang('tr');
  const onCommit = vi.fn();
  render(<NumberField value={1.5} onCommit={onCommit} min={0} max={10} step={0.1} ariaLabel="kp" {...props} />);
  const input = screen.getByLabelText('kp') as HTMLInputElement;
  return { input, onCommit };
}

describe('NumberField', () => {
  it('shows the value with a Turkish decimal comma', () => {
    const { input } = setup();
    expect(input.value).toBe('1,5');
  });

  it('commits a valid draft on Enter', () => {
    const { input, onCommit } = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '2,25' } });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith(2.25);
  });

  it('reverts the draft on Escape', () => {
    const { input, onCommit } = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '7' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('1,5');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('shows a range error and refuses to commit', () => {
    const { input, onCommit } = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '12' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('En çok 10,0');
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('steps with arrow keys and commits only on Enter by default', () => {
    const { input, onCommit } = setup();
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'ArrowUp', shiftKey: true });
    expect(input.value).toBe('2,6');
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith(2.6);
  });

  it('commitOnStep sends every step immediately', () => {
    const { input, onCommit } = setup({ commitOnStep: true });
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(onCommit).toHaveBeenCalledWith(1.4);
  });

  it('drops an invalid draft on blur', () => {
    const { input, onCommit } = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe('1,5');
  });
});
