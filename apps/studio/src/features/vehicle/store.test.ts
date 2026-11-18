import { describe, expect, it } from 'vitest';
import { draft, useDraft } from './store';

const esc = (uid48: string) => ({ kind: 'device' as const, uid48, model: 'esc20a' });

describe('vehicle draft: motor test answers (walkthrough: tune step showed "not tested" after a test in step 2)', () => {
  it('keeps an answer for the tune step and drops it when the slot gets another board', () => {
    draft.reset();
    draft.chooseTemplate('frc.swerve4', 'Robot');
    draft.bind('fl.drive', esc('0962deccc243'));
    draft.bind('fr.drive', esc('c91c80ddb26a'));
    draft.setVerified('fl.drive', false);
    draft.setVerified('fr.drive', true);
    expect(useDraft.getState().verified).toEqual({ 'fl.drive': false, 'fr.drive': true });
    draft.bind('fl.drive', esc('d4d5d7a83ff0'));
    expect(useDraft.getState().verified).toEqual({ 'fr.drive': true });
    draft.unbind('fr.drive');
    expect(useDraft.getState().verified).toEqual({});
    draft.chooseTemplate('frc.tank', 'Robot');
    expect(useDraft.getState().verified).toEqual({});
  });
});
