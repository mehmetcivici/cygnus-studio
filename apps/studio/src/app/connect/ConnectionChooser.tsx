import { useState } from 'react';
import { FlaskConical, Monitor, Router, Usb } from 'lucide-react';
import { Tabs } from '../../ui';
import { useConnection } from '../../core';
import { tShell } from '../messages';
import { ScenarioGallery } from './ScenarioGallery';
import { DesktopSerialConnect, RoboRioConnect, WebSerialConnect } from './HardwareConnect';

type Tab = 'sim' | 'webserial' | 'desktop' | 'roborio';

export interface ConnectionChooserProps {
  variant?: 'compact' | 'cards';
  onStarted?: () => void;
}

/** Every way to get a bus: simulator scenarios, Web Serial, desktop serial, roboRIO bridge. */
export function ConnectionChooser({ variant = 'compact', onStarted }: ConnectionChooserProps) {
  const source = useConnection((s) => s.source);
  const initial: Tab = source?.kind === 'webserial' ? 'webserial' : source?.kind === 'tauri-serial' ? 'desktop' : source?.kind === 'roborio' ? 'roborio' : 'sim';
  const [tab, setTab] = useState<Tab>(initial);
  return (
    <div className="cy-chooser">
      <Tabs<Tab>
        variant="pill"
        value={tab}
        onChange={setTab}
        items={[
          { id: 'sim', label: tShell('conn.tabs.sim'), icon: FlaskConical },
          { id: 'webserial', label: tShell('conn.tabs.webserial'), icon: Usb },
          { id: 'desktop', label: tShell('conn.tabs.desktop'), icon: Monitor },
          { id: 'roborio', label: tShell('conn.tabs.roborio'), icon: Router },
        ]}
      />
      <div className="cy-chooser__body">
        {tab === 'sim' && <ScenarioGallery variant={variant} onStarted={onStarted} />}
        {tab === 'webserial' && <WebSerialConnect onStarted={onStarted} />}
        {tab === 'desktop' && <DesktopSerialConnect onStarted={onStarted} />}
        {tab === 'roborio' && <RoboRioConnect onStarted={onStarted} />}
      </div>
    </div>
  );
}
