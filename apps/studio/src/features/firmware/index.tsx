import { useState } from 'react';
import { HardDriveDownload, LifeBuoy } from 'lucide-react';
import { Button, Page, Tooltip } from '../../ui';
import { useConnection } from '../../core';
import { RecoveryDialog } from './RecoveryDialog';
import { useFwUpdate } from './store';
import { useI18n } from '../../i18n';
import type { FeatureProps } from '../registry';
import { CardsPanel } from './CardsPanel';
import { Library } from './Library';
import { LogPanel, SummaryPanel } from './Summary';
import { tFirmware } from './messages';
import './firmware.css';

export function FirmwareScreen(_props: FeatureProps) {
  const { t } = useI18n();
  const [recovery, setRecovery] = useState(false);
  const connected = useConnection((s) => s.phase === 'connected');
  const running = useFwUpdate((s) => s.running);
  return (
    <Page
      title={t('nav.firmware')}
      subtitle={tFirmware('subtitle')}
      icon={HardDriveDownload}
      actions={
        <Tooltip content={tFirmware('recovery.openHint')}>
          <Button size="sm" variant="secondary" icon={LifeBuoy} disabled={!connected || running} onClick={() => setRecovery(true)} data-testid="fw-rec-open">
            {tFirmware('recovery.open')}
          </Button>
        </Tooltip>
      }
    >
      <div className="fw-layout">
        <div className="fw-col fw-col--lib">
          <Library />
        </div>
        <div className="fw-col fw-col--main">
          <CardsPanel />
          <SummaryPanel />
          <LogPanel />
        </div>
      </div>
      {recovery && <RecoveryDialog onClose={() => setRecovery(false)} />}
    </Page>
  );
}
