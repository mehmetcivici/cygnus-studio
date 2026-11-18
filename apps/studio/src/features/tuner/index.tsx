import { SlidersHorizontal } from 'lucide-react';
import { EmptyState, Page } from '../../ui';
import { useI18n } from '../../i18n';
import type { FeatureProps } from '../registry';
import { tTuner } from './messages';

export function TunerScreen(_props: FeatureProps) {
  const { t } = useI18n();
  return (
    <Page title={t('nav.tuner')} subtitle={tTuner('subtitle')} icon={SlidersHorizontal}>
      <EmptyState icon={SlidersHorizontal} title={tTuner('emptyTitle')} description={tTuner('emptyBody')} />
    </Page>
  );
}
