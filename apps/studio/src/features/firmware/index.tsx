import { HardDriveDownload } from 'lucide-react';
import { EmptyState, Page } from '../../ui';
import { useI18n } from '../../i18n';
import type { FeatureProps } from '../registry';
import { tFirmware } from './messages';

export function FirmwareScreen(_props: FeatureProps) {
  const { t } = useI18n();
  return (
    <Page title={t('nav.firmware')} subtitle={tFirmware('subtitle')} icon={HardDriveDownload}>
      <EmptyState icon={HardDriveDownload} title={tFirmware('emptyTitle')} description={tFirmware('emptyBody')} />
    </Page>
  );
}
