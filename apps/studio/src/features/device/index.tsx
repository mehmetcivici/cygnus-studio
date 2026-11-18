import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Activity, Cpu, Gamepad2, HardDriveDownload, Network, Power, SearchX, SlidersHorizontal, Stethoscope, Unplug } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Button, EmptyState, Page, Spinner, Tabs, type TabItem } from '../../ui';
import { DevicePicker, selectDevice, useConnection, useDevice, useDevices, useSelectedDevice, type DeviceView } from '../../core';
import { navigate } from '../../app/nav';
import type { FeatureProps } from '../registry';
import { DeviceHeader } from './Header';
import { Switcher } from './Switcher';
import { OverviewTab } from './tabs/OverviewTab';
import { SettingsTab } from './tabs/SettingsTab';
import { ControlTab } from './tabs/ControlTab';
import { DiagnosticsTab } from './tabs/DiagnosticsTab';
import { trackSaved } from './logic/baseline';
import { useRebooting } from './ops';
import { tDevice } from './messages';
import './device.css';

type TabId = 'overview' | 'settings' | 'control' | 'diagnostics';

function canSettings(d: DeviceView): boolean {
  return !!d.def && d.def.params.length > 0 && d.handle.capabilities.params;
}

/** Actuators only: the OLED's text frame is not something to "drive". */
function canControl(d: DeviceView): boolean {
  return !!d.def && d.handle.capabilities.control && d.def.controls.some((c) => c.format !== 'text');
}

function tabItems(d: DeviceView): TabItem<TabId>[] {
  const faults = new Set(d.faults.list.map((f) => f.key)).size;
  const items: TabItem<TabId>[] = [{ id: 'overview', label: tDevice('tab.overview'), icon: Activity }];
  items.push({ id: 'settings', label: tDevice('tab.settings'), icon: SlidersHorizontal, disabled: !canSettings(d), badge: d.flags.unsaved ? '•' : undefined });
  if (canControl(d)) items.push({ id: 'control', label: tDevice('tab.control'), icon: Gamepad2 });
  items.push({ id: 'diagnostics', label: tDevice('tab.diagnostics'), icon: Stethoscope, badge: faults > 0 ? faults : undefined });
  return items;
}

function DeviceBody({ device }: { device: DeviceView }) {
  const [tab, setTab] = useState<TabId>('overview');
  const rebooting = useRebooting((s) => s.uids.has(device.uid48));
  const items = tabItems(device);
  const current = items.find((i) => i.id === tab && !i.disabled) ? tab : 'overview';
  useEffect(() => {
    trackSaved(device.handle);
  }, [device.handle]);

  if (device.bootloader) {
    return (
      <EmptyState
        icon={HardDriveDownload}
        title={tDevice('state.inBootloader')}
        description={tDevice('state.inBootloaderBody')}
        actions={
          <Button variant="primary" icon={HardDriveDownload} onClick={() => navigate('firmware', { device: device.uid48 })}>
            {tDevice('state.toFirmware')}
          </Button>
        }
      />
    );
  }
  if (device.unassigned || device.conflict) {
    return (
      <EmptyState
        icon={Network}
        title={device.unassigned ? tDevice('state.unassigned') : tDevice('state.conflict', { num: device.num })}
        description={tDevice('state.unresolvedBody')}
        actions={
          <Button variant="primary" icon={Network} onClick={() => navigate('bus')}>
            {tDevice('state.toBus')}
          </Button>
        }
      />
    );
  }
  return (
    <>
      {!device.online && (
        <div className="dv-strip dv-strip--offline" role="status">
          <Unplug size={15} aria-hidden />
          <span>
            <strong>{tDevice('state.lost')}</strong> {tDevice('state.lostBody')}
          </span>
          <span className="dv-strip__spacer" />
          <Spinner size={14} />
        </div>
      )}
      <Tabs<TabId> items={items} value={current} onChange={setTab} ariaLabel={tDevice('tabs')} className="dv-tabs" />
      <div className={!device.online ? 'dv-content is-stale' : 'dv-content'} key={device.uid48}>
        {rebooting ? (
          <EmptyState icon={Power} title={tDevice('state.rebooting')} description={<Spinner size={18} />} />
        ) : (
          <>
        {current === 'overview' && <OverviewTab device={device} />}
        {current === 'settings' && <SettingsTab device={device} />}
        {current === 'control' && <ControlTab device={device} />}
        {current === 'diagnostics' && <DiagnosticsTab device={device} />}
          </>
        )}
      </div>
    </>
  );
}

/** One board, everything about it: live state, settings, manual control, actions and faults. */
export function DeviceScreen({ params }: FeatureProps) {
  const { t } = useI18n();
  const phase = useConnection((s) => s.phase);
  const devices = useDevices();
  const [selected] = useSelectedDevice();
  const uid = params.device ?? selected?.uid48 ?? null;
  const device = useDevice(uid);

  const open = useCallback((u: string) => {
    selectDevice(u);
    navigate('device', { device: u });
  }, []);
  // Keep the shared selection in step with the URL so Tuner/Graph open the same board.
  useEffect(() => {
    if (device && selected?.uid48 !== device.uid48) selectDevice(device.uid48);
  }, [device, selected?.uid48]);

  const picker = <DevicePicker value={device?.uid48 ?? null} onChange={open} includeOffline size="sm" width={280} ariaLabel={tDevice('switcher')} />;
  const page = (content: ReactNode) => (
    <Page title={t('nav.device')} subtitle={tDevice('subtitle')} icon={Cpu} actions={devices.length > 0 ? <div className="dv-picker">{picker}</div> : undefined}>
      {content}
    </Page>
  );

  if (devices.length === 0) {
    const connecting = phase === 'connecting' || phase === 'connected';
    return page(
      <EmptyState
        icon={connecting ? Cpu : Unplug}
        title={connecting ? tDevice('state.searching') : tDevice('state.noBus')}
        description={connecting ? <Spinner size={18} /> : tDevice('state.noBusBody')}
        actions={
          connecting ? undefined : (
            <Button variant="primary" icon={Network} onClick={() => navigate('bus')}>
              {tDevice('state.toBus')}
            </Button>
          )
        }
      />,
    );
  }

  return page(
    <div className="dv-layout">
      <Switcher selected={device?.uid48 ?? null} onSelect={open} />
      <div className="dv-main">
        {device ? (
          <>
            <DeviceHeader device={device} />
            <DeviceBody device={device} />
          </>
        ) : uid ? (
          <EmptyState icon={SearchX} title={tDevice('state.notFound')} description={tDevice('state.notFoundBody', { uid })} actions={<div className="dv-picker-inline">{picker}</div>} />
        ) : (
          <EmptyState icon={Cpu} title={tDevice('emptyTitle')} description={tDevice('emptyBody')} actions={<div className="dv-picker-inline">{picker}</div>} />
        )}
      </div>
    </div>,
  );
}
