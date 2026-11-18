import { Network } from 'lucide-react';
import { EmptyState, Page } from '../../ui';
import { useI18n } from '../../i18n';
import type { FeatureProps } from '../registry';
import { tBus } from './messages';

export function BusScreen(_props: FeatureProps) {
  const { t } = useI18n();
  return (
    <Page title={t('nav.bus')} subtitle={tBus('subtitle')} icon={Network}>
      <EmptyState icon={Network} title={tBus('emptyTitle')} description={tBus('emptyBody')} />
    </Page>
  );
}
