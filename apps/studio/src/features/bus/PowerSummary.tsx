import { useMemo } from 'react';
import { Unplug, Zap } from 'lucide-react';
import { useI18n } from '../../i18n';
import { BarMeter, EmptyState, Panel } from '../../ui';
import { DeviceBadge, SignalTile, useSignals, type DeviceView } from '../../core';
import { tBus } from './messages';

const POWER_KEYS = ['pdh_large', 'pdh_small'];

/** The distribution board; an offline one is still returned so its panel keeps its place (no layout jump). */
export function findPowerBoard(devices: readonly DeviceView[]): DeviceView | undefined {
  const all = devices.filter((d) => !d.unassigned && !d.conflict && d.def && POWER_KEYS.includes(d.def.key));
  return all.find((d) => d.online) ?? all[0];
}

/** Channel bars live in their own component so only they re-render with the signals. */
function ChannelBars({ device }: { device: DeviceView }) {
  const { tl } = useI18n();
  const def = device.def;
  const channels = useMemo(() => (def?.signals ?? []).filter((s) => /^ch\.\d+\.current$/.test(s.key)), [def]);
  const keys = useMemo(() => [...channels.map((c) => c.key), 'fuse.mask'], [channels]);
  const values = useSignals(device.uid48, keys);
  const fuse = values['fuse.mask'] ?? 0;
  if (channels.length === 0) return null;
  return (
    <>
      <div className="bus-power__label">{tBus('power.channels')}</div>
      <div className="bus-power__bars">
        {channels.map((c, i) => {
          const warn = device.handle.cachedParam(`ch.${i + 1}.warn_a`);
          const blown = Number.isFinite(fuse) && (fuse & (1 << i)) !== 0;
          const v = values[c.key] ?? NaN;
          return (
            <BarMeter
              key={c.key}
              value={Number.isFinite(v) ? v : null}
              max={c.range[1]}
              threshold={warn && warn > 0 ? warn : undefined}
              unit="A"
              digits={1}
              height={92}
              width={20}
              label={tBus('power.ch', { n: i + 1 })}
              tone={blown ? 'danger' : undefined}
              inactive={blown}
            />
          );
        })}
      </div>
      {fuse > 0 && Number.isFinite(fuse) && (
        <div className="bus-power__fuse">
          {tBus('power.fuse')}: {channels.filter((_, i) => fuse & (1 << i)).map((c) => tl(c.label)).join(', ')}
        </div>
      )}
    </>
  );
}

/** Input voltage, total current and per-channel bars of the bus's power distribution board. */
export function PowerSummary({ device }: { device: DeviceView }) {
  const hasPower = device.def?.signals.some((s) => s.key === 'power');
  return (
    <Panel title={tBus('power.title')} icon={Zap} actions={<DeviceBadge device={device} size="sm" showModel={false} />} className="bus-power">
      {!device.online ? (
        <EmptyState size="sm" icon={Unplug} title={tBus('power.noData')} description={tBus('power.noDataBody')} />
      ) : (
      <>
      <div className="bus-power__tiles">
        <SignalTile uid48={device.uid48} signal="input.voltage" label={tBus('power.input')} />
        <SignalTile uid48={device.uid48} signal="total.current" label={tBus('power.total')} />
        {hasPower && <SignalTile uid48={device.uid48} signal="power" label={tBus('power.power')} trend={false} />}
      </div>
      <ChannelBars device={device} />
      </>
      )}
    </Panel>
  );
}
