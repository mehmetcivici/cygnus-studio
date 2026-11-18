import { useState } from 'react';
import { CarFront, FlaskConical, SlidersHorizontal, Usb, X } from 'lucide-react';
import { Button, IconButton } from '../../ui';
import { useConnection } from '../../core';
import { navigate } from '../../app/nav';
import { readStored, writeStored } from '../../lib/storage';
import { tBus } from './messages';

const KEY = 'cygnus.bus.simIntroDismissed';

/**
 * First thing a newcomer sees on the simulator: that this is a simulation and what to try
 * next. Dismissed for good with the close button.
 */
export function SimIntro() {
  const isSim = useConnection((s) => s.source?.kind === 'sim');
  const [hidden, setHidden] = useState(() => readStored(KEY) === '1');
  if (!isSim || hidden) return null;
  const close = (): void => {
    writeStored(KEY, '1');
    setHidden(true);
  };
  return (
    <section className="bus-simintro" aria-label={tBus('simIntro.title')}>
      <FlaskConical size={20} aria-hidden className="bus-simintro__icon" />
      <div className="bus-simintro__text">
        <strong>{tBus('simIntro.title')}</strong>
        <span>{tBus('simIntro.body')}</span>
      </div>
      <ol className="bus-simintro__steps">
        <li>
          <Button size="sm" variant="secondary" icon={CarFront} onClick={() => navigate('vehicle')}>
            {tBus('simIntro.vehicle')}
          </Button>
        </li>
        <li>
          <Button size="sm" variant="secondary" icon={SlidersHorizontal} onClick={() => navigate('tuner')}>
            {tBus('simIntro.tune')}
          </Button>
        </li>
        <li className="bus-simintro__hw">
          <Usb size={14} aria-hidden /> {tBus('simIntro.hardware')}
        </li>
      </ol>
      <IconButton size="sm" variant="ghost" icon={X} label={tBus('simIntro.close')} onClick={close} />
    </section>
  );
}
