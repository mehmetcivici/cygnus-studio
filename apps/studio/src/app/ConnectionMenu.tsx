import { useCallback, useState } from 'react';
import { ChevronDown, PlugZap, RotateCw, Unplug } from 'lucide-react';
import { useI18n } from '../i18n';
import { Button, StatusDot, cx, type DeviceStatus } from '../ui';
import { connection, describeError, useConnection, type ConnectionPhase } from '../core';
import { ConnectionChooser, scenarioInfo } from './connect';
import { Popover } from './Popover';
import { tShell } from './messages';

const DOT: Record<ConnectionPhase, DeviceStatus> = { idle: 'offline', connecting: 'boot', connected: 'ok', lost: 'fault', error: 'fault' };

/** Name of the current source for the UI (localised scenario name or port label). */
export function useSourceLabel(): string {
  const { tl } = useI18n();
  const source = useConnection((s) => s.source);
  const label = useConnection((s) => s.label);
  if (source?.kind === 'sim') {
    const info = scenarioInfo(source.scenarioId);
    return `${tShell('conn.simPrefix')} · ${info ? tl(info.name) : source.scenarioId}`;
  }
  return label;
}

/** Top bar: link status + menu with every connection option. */
export function ConnectionMenu() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const phase = useConnection((s) => s.phase);
  const error = useConnection((s) => s.error);
  const source = useConnection((s) => s.source);
  const label = useSourceLabel();
  const close = useCallback(() => setOpen(false), []);
  return (
    <Popover
      open={open}
      onClose={close}
      width={560}
      anchor={
        <button type="button" className={cx('cy-connbtn', `is-${phase}`)} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <StatusDot status={DOT[phase]} pulse={phase === 'connecting' || phase === 'lost'} />
          <span className="cy-connbtn__text">
            <span className="cy-connbtn__phase">{t(`core.conn.phase.${phase}`)}</span>
            {source && <span className="cy-connbtn__label">{label}</span>}
          </span>
          <ChevronDown size={15} aria-hidden />
        </button>
      }
    >
      <div className="cy-connmenu">
        {(phase === 'lost' || phase === 'error') && (
          <div className="cy-connmenu__alert">
            <strong>{t(`core.conn.phase.${phase}`)}</strong>
            <span>{phase === 'lost' ? tShell('conn.lostHint') : error ? describeError(new Error(error)) : ''}</span>
          </div>
        )}
        <ConnectionChooser onStarted={close} />
        <footer className="cy-connmenu__foot">
          <span className="cy-connmenu__current">
            <StatusDot status={DOT[phase]} withLabel label={t(`core.conn.phase.${phase}`)} />
            {source && <span className="cy-connmenu__label">{label}</span>}
          </span>
          {source && phase !== 'connected' && (
            <Button size="sm" icon={source.kind === 'sim' ? RotateCw : PlugZap} onClick={() => void connection.reconnect()}>
              {tShell('conn.reconnect')}
            </Button>
          )}
          {phase !== 'idle' && (
            <Button size="sm" variant="ghost" icon={Unplug} onClick={() => void connection.disconnect()}>
              {tShell('conn.disconnect')}
            </Button>
          )}
        </footer>
      </div>
    </Popover>
  );
}
