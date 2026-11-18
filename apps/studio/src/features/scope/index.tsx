import { ChartSpline } from 'lucide-react';
import { EmptyState, Page } from '../../ui';
import { useI18n } from '../../i18n';
import type { FeatureProps } from '../registry';
import { tScope } from './messages';

export function ScopeScreen(_props: FeatureProps) {
  const { t } = useI18n();
  return (
    <Page title={t('nav.scope')} subtitle={tScope('subtitle')} icon={ChartSpline}>
      <EmptyState icon={ChartSpline} title={tScope('emptyTitle')} description={tScope('emptyBody')} />
    </Page>
  );
}
