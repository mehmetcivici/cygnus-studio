import { FolderKanban } from 'lucide-react';
import { EmptyState, Page } from '../../ui';
import { useI18n } from '../../i18n';
import type { FeatureProps } from '../registry';
import { tProject } from './messages';

export function ProjectScreen(_props: FeatureProps) {
  const { t } = useI18n();
  return (
    <Page title={t('nav.project')} subtitle={tProject('subtitle')} icon={FolderKanban}>
      <EmptyState icon={FolderKanban} title={tProject('emptyTitle')} description={tProject('emptyBody')} />
    </Page>
  );
}
