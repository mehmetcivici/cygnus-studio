import { PlugZap } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Button, Kbd, Spinner } from '../../ui';
import { connection, describeError, useConnection } from '../../core';
import { LogoMark } from '../../app/Logo';
import { ConnectionChooser } from '../../app/connect';
import { useSourceLabel } from '../../app/ConnectionMenu';
import { tBus } from './messages';

/** First thing a user sees without a bus: an invitation, not an empty state. */
export function Welcome() {
  const { lang } = useI18n();
  const phase = useConnection((s) => s.phase);
  const source = useConnection((s) => s.source);
  const error = useConnection((s) => s.error);
  const label = useSourceLabel();
  return (
    <div className="bus-welcome">
      <div className="bus-welcome__hero">
        <div className="bus-welcome__mark">
          <LogoMark size={64} />
        </div>
        <div>
          <h1 className="bus-welcome__title">{tBus('welcome.title')}</h1>
          <p className="bus-welcome__body">{tBus('welcome.body')}</p>
        </div>
      </div>
      {phase === 'connecting' && (
        <div className="bus-welcome__status">
          <Spinner size={18} /> {tBus('welcome.connecting')} <span className="bus-welcome__muted">{label}</span>
        </div>
      )}
      {phase === 'error' && error && <div className="bus-welcome__error">{describeError(new Error(error), lang)}</div>}
      {source && source.kind !== 'sim' && phase !== 'connecting' && (
        <div className="bus-welcome__last">
          <span className="bus-welcome__muted">{tBus('welcome.last')}:</span>
          <strong>{label}</strong>
          <Button size="sm" variant="primary" icon={PlugZap} onClick={() => void connection.reconnect()}>
            {tBus('welcome.reconnect')}
          </Button>
        </div>
      )}
      <div className="bus-welcome__chooser">
        <ConnectionChooser variant="cards" />
      </div>
      <p className="bus-welcome__tip">
        <Kbd>{lang === 'tr' ? 'Boşluk' : 'Space'}</Kbd> {tBus('welcome.tipEstop')} · <Kbd>1</Kbd>–<Kbd>8</Kbd> {tBus('welcome.tipScreens')}
      </p>
    </div>
  );
}
