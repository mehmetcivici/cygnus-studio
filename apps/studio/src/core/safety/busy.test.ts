import { afterEach, describe, expect, it } from 'vitest';
import { acquireBusyLock, confirmLeave, isBusy, registerBusyPromptHost, useBusy } from './busy';
import { setNavGuard, useNav } from '../../app/nav';

afterEach(() => useBusy.setState({ locks: [], prompt: null }));

describe('busy locks', () => {
  it('lets actions through without locks and asks while locked', async () => {
    expect(await confirmLeave('navigate')).toBe(true);
    const release = acquireBusyLock('firmware.busy.flashing', { count: 2 });
    expect(isBusy()).toBe(true);
    // nobody to ask (no dialog host) → refused while locked
    expect(await confirmLeave('navigate')).toBe(false);
    const off = registerBusyPromptHost();
    const p = confirmLeave('disconnect');
    expect(useBusy.getState().prompt?.action).toBe('disconnect');
    useBusy.getState().prompt?.resolve(true);
    expect(await p).toBe(true);
    off();
    release();
    release();
    expect(isBusy()).toBe(false);
  });

  it('a navigation guard cancels screen changes while locked', () => {
    const off = setNavGuard(() => !isBusy());
    useNav.setState({ screen: 'firmware', params: {} });
    const release = acquireBusyLock('x');
    useNav.getState().navigate('bus');
    expect(useNav.getState().screen).toBe('firmware');
    useNav.getState().navigate('bus', {}, { force: true });
    expect(useNav.getState().screen).toBe('bus');
    release();
    off();
  });
});
