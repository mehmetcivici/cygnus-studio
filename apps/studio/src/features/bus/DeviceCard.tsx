import { memo } from 'react';
import { useI18n } from '../../i18n';
import { Badge, StatusDot, cx } from '../../ui';
import { FaultList, ModelIcon, fmtFw, modelText, type DeviceView } from '../../core';
import { tBus } from './messages';
import { DeviceActions, LiveValues, RenameName, openDevice } from './parts';

const TONE = { ok: 'ok', warn: 'warn', fault: 'danger', boot: 'accent', offline: undefined } as const;

function Flags({ device }: { device: DeviceView }) {
  const { t } = useI18n();
  return (
    <>
      {device.unassigned && <Badge size="sm" tone="warn">{tBus('unresolved.unassigned')}</Badge>}
      {device.conflict && <Badge size="sm" tone="warn">{tBus('unresolved.conflict', { num: device.num })}</Badge>}
      {!device.online && <Badge size="sm">{t('status.offline')}</Badge>}
      {device.bootloader && <Badge size="sm" tone="accent">{tBus('card.bootloader')}</Badge>}
      {device.flags.enabled && <Badge size="sm" tone="danger" variant="solid">{tBus('card.enabled')}</Badge>}
      {device.flags.unsaved && <Badge size="sm" tone="caution" variant="outline">{tBus('card.unsaved')}</Badge>}
      {device.catalogStatus === 'newerCatalog' && <Badge size="sm" tone="caution" title={tBus('card.newerCatalog')}>cat+</Badge>}
      {device.catalogStatus === 'unknownModel' && <Badge size="sm" tone="caution">{tBus('card.unknownModel')}</Badge>}
    </>
  );
}

/** Grid card of one board. Memoised on the (immutable) view, so live values are its only churn. */
export const DeviceCard = memo(function DeviceCard({ device }: { device: DeviceView }) {
  const { tl } = useI18n();
  const resolved = !device.unassigned && !device.conflict;
  const model = tl(modelText(device));
  // Unnamed (or model-named) boards already show the model as their title: show the UID instead.
  const subtitle = device.name.trim() && device.name.trim() !== model ? model : device.uid48;
  return (
    <article
      className={cx('bus-card', !device.online && 'is-lost', !resolved && 'is-unresolved', device.flags.identify && 'is-identify')}
      data-tone={TONE[device.status]}
      onDoubleClick={() => resolved && openDevice(device)}
    >
      <header className="bus-card__head">
        <ModelIcon def={device.def} boxed size={18} />
        <div className="bus-card__titles">
          <RenameName device={device} className="bus-card__name" />
          <div className="bus-card__model">
            <StatusDot status={device.status} size={7} />
            <span className={subtitle === device.uid48 ? 'cy-mono' : undefined}>{subtitle}</span>
          </div>
        </div>
        <span className={cx('bus-card__num cy-mono', !resolved && 'is-bad')}>#{device.unassigned ? '—' : device.num}</span>
      </header>
      <LiveValues device={device} />
      <footer className="bus-card__foot">
        <div className="bus-card__flags">
          <Flags device={device} />
          <FaultList device={device} compact />
        </div>
        {device.fw && (
          <span className="bus-card__fw cy-mono" title={tBus('card.fw')}>
            v{fmtFw(device.fw)}
          </span>
        )}
        <DeviceActions device={device} />
      </footer>
    </article>
  );
});

/** List-view row with the same content in one line. */
export const DeviceRow = memo(function DeviceRow({ device }: { device: DeviceView }) {
  const { tl } = useI18n();
  const resolved = !device.unassigned && !device.conflict;
  return (
    <div
      className={cx('bus-row', !device.online && 'is-lost', !resolved && 'is-unresolved', device.flags.identify && 'is-identify')}
      data-tone={TONE[device.status]}
      onDoubleClick={() => resolved && openDevice(device)}
      role="row"
    >
      <StatusDot status={device.status} />
      <ModelIcon def={device.def} size={16} />
      <RenameName device={device} className="bus-row__name" />
      <span className="bus-row__model">{tl(modelText(device))}</span>
      <span className={cx('bus-row__num cy-mono', !resolved && 'is-bad')}>#{device.unassigned ? '—' : device.num}</span>
      <span className="bus-row__fw cy-mono">{device.fw ? `v${fmtFw(device.fw)}` : ''}</span>
      <span className="bus-row__flags">
        <Flags device={device} />
        <FaultList device={device} compact />
      </span>
      <span className="bus-row__live">
        <LiveValues device={device} compact />
      </span>
      <DeviceActions device={device} />
    </div>
  );
});
