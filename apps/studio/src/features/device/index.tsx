import { Cpu } from 'lucide-react';
import { EmptyState, Page } from '../../ui';
import { useI18n } from '../../i18n';
import type { FeatureProps } from '../registry';
import { tDevice } from './messages';

export function DeviceScreen(_props: FeatureProps) {
  const { t } = useI18n();
  return (
    <Page title={t('nav.device')} subtitle={tDevice('subtitle')} icon={Cpu}>
      <EmptyState icon={Cpu} title={tDevice('emptyTitle')} description={tDevice('emptyBody')} />
    </Page>
  );
}
