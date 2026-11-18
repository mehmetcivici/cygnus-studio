import { ScrollText } from 'lucide-react';
import { EmptyState, Page } from '../../ui';
import { useI18n } from '../../i18n';
import type { FeatureProps } from '../registry';
import { tCanMonitor } from './messages';

export function CanMonitorScreen(_props: FeatureProps) {
  const { t } = useI18n();
  return (
    <Page title={t('nav.canmon')} subtitle={tCanMonitor('subtitle')} icon={ScrollText}>
      <EmptyState icon={ScrollText} title={tCanMonitor('emptyTitle')} description={tCanMonitor('emptyBody')} />
    </Page>
  );
}
