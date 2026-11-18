import { HardDriveDownload } from 'lucide-react';
import { Page } from '../../ui';
import { useI18n } from '../../i18n';
import type { FeatureProps } from '../registry';
import { CardsPanel } from './CardsPanel';
import { Library } from './Library';
import { LogPanel, SummaryPanel } from './Summary';
import { tFirmware } from './messages';
import './firmware.css';

export function FirmwareScreen(_props: FeatureProps) {
  const { t } = useI18n();
  return (
    <Page title={t('nav.firmware')} subtitle={tFirmware('subtitle')} icon={HardDriveDownload}>
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
    </Page>
  );
}
