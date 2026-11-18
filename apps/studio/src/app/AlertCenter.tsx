import { useCallback, useState } from 'react';
import { BellRing, CircleAlert, TriangleAlert } from 'lucide-react';
import { useI18n } from '../i18n';
import { Button, cx } from '../ui';
import { useAlerts, type Alert } from '../core';
import { navigate } from './nav';
import { Popover } from './Popover';

/** Worst bus-level condition, for the connection dot. */
export function useLinkHealth(): 'ok' | 'warn' | 'fault' {
  return useAlerts((s) => {
    const bus = s.alerts.filter((a) => a.id.startsWith('bus.') || a.id.startsWith('lost.') || a.id.startsWith('fuse.'));
    if (bus.some((a) => a.severity === 'danger')) return 'fault';
    return bus.length ? 'warn' : 'ok';
  });
}

function AlertRow({ alert, onGo }: { alert: Alert; onGo: (a: Alert) => void }) {
  const { t, fmtPercent } = useI18n();
  const params = alert.params && 'pct' in alert.params ? { ...alert.params, pct: fmtPercent(Number(alert.params.pct), 0) } : alert.params;
  const Icon = alert.severity === 'danger' ? CircleAlert : TriangleAlert;
  return (
    <li className={cx('cy-alerts__row', `is-${alert.severity}`)}>
      <Icon size={16} aria-hidden className="cy-alerts__icon" />
      <div className="cy-alerts__text">
        <span>{t(alert.messageKey, params)}</span>
        {alert.detailKey && <span className="cy-alerts__detail">{t(alert.detailKey, alert.detailParams)}</span>}
      </div>
      {alert.target && (
        <Button size="sm" variant="ghost" onClick={() => onGo(alert)}>
          {t('core.alerts.goTo')}
        </Button>
      )}
    </li>
  );
}

/** Top bar: count of active alerts with their causes; each row jumps to the related screen. */
export function AlertCenter() {
  const { t } = useI18n();
  const alerts = useAlerts((s) => s.alerts);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const go = useCallback((a: Alert) => {
    if (!a.target) return;
    setOpen(false);
    navigate(a.target.screen, a.target.params);
  }, []);
  const tone = alerts.some((a) => a.severity === 'danger') ? 'danger' : alerts.length ? 'warn' : 'none';
  const label = alerts.length ? t('core.alerts.count', { count: alerts.length }) : t('core.alerts.none');
  return (
    <Popover
      open={open}
      onClose={close}
      width={420}
      align="end"
      anchor={
        <button
          type="button"
          className={cx('cy-alertbtn', `is-${tone}`)}
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={`${t('core.alerts.open')}: ${label}`}
          title={label}
        >
          <BellRing size={16} aria-hidden />
          {alerts.length > 0 && <span className="cy-alertbtn__count cy-mono">{alerts.length}</span>}
        </button>
      }
    >
      <div className="cy-alerts" role="region" aria-label={t('core.alerts.title')}>
        <header className="cy-alerts__head">{t('core.alerts.title')}</header>
        {alerts.length === 0 ? (
          <p className="cy-alerts__empty">{t('core.alerts.none')}</p>
        ) : (
          <ul className="cy-alerts__list" aria-live="polite">
            {alerts.map((a) => (
              <AlertRow key={a.id} alert={a} onGo={go} />
            ))}
          </ul>
        )}
      </div>
    </Popover>
  );
}
