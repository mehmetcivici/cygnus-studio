import { memo } from 'react';
import { useI18n } from '../../i18n';
import { StatusDot, cx } from '../../ui';
import { ModelIcon, displayName, modelText, useDevices, type DeviceView } from '../../core';
import { tDevice } from './messages';

const Item = memo(function Item({ device, selected, onSelect }: { device: DeviceView; selected: boolean; onSelect: (uid48: string) => void }) {
  const { lang, tl } = useI18n();
  const name = displayName(device, lang);
  const model = tl(modelText(device));
  return (
    <li>
      <button
        type="button"
        className={cx('dv-switch__item', selected && 'is-selected', !device.online && 'is-offline')}
        aria-current={selected ? 'true' : undefined}
        onClick={() => onSelect(device.uid48)}
        title={`${name} · ${model} · ${device.uid48}`}
      >
        <ModelIcon def={device.def} size={15} />
        <span className="dv-switch__text">
          <span className="dv-switch__name">{name}</span>
          {name !== model && <span className="dv-switch__model">{model}</span>}
        </span>
        <span className={cx('dv-switch__num cy-mono', (device.unassigned || device.conflict) && 'is-bad')}>#{device.unassigned ? '—' : device.num}</span>
        <StatusDot status={device.status} size={7} />
      </button>
    </li>
  );
});

/** Quick board switcher (left column on wide screens). */
export function Switcher({ selected, onSelect }: { selected: string | null; onSelect: (uid48: string) => void }) {
  const devices = useDevices();
  return (
    <nav className="dv-switch" aria-label={tDevice('switcher')}>
      <div className="dv-switch__head">
        {tDevice('switcher')} <span>{devices.length}</span>
      </div>
      <ul className="dv-switch__list">
        {devices.map((d) => (
          <Item key={d.uid48} device={d} selected={d.uid48 === selected} onSelect={onSelect} />
        ))}
      </ul>
    </nav>
  );
}
