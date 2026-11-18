import { useState } from 'react';
import { Badge } from '../../ui';
import { Camera, Code2, FileText, FolderKanban, GitCompareArrows, Settings2, Save } from 'lucide-react';
import { Page, Tabs, type TabItem } from '../../ui';
import { useI18n } from '../../i18n';
import { useProject } from '../../core';
import type { FeatureProps } from '../registry';
import { CodeTab } from './CodeTab';
import { CompareTab } from './CompareTab';
import { FileTab } from './FileTab';
import { ReportTab } from './ReportTab';
import { SettingsTab } from './SettingsTab';
import { SnapshotTab } from './SnapshotTab';
import { tProject } from './messages';
import './project.css';

type TabId = 'file' | 'snapshot' | 'compare' | 'code' | 'report' | 'settings';

export function ProjectScreen(_props: FeatureProps) {
  const { t } = useI18n();
  const [tab, setTab] = useState<TabId>('file');
  const name = useProject((s) => s.project.name);
  const dirty = useProject((s) => s.dirty);
  const devices = useProject((s) => s.project.bus.devices.length);
  const items: TabItem<TabId>[] = [
    { id: 'file', label: tProject('tab.file'), icon: Save },
    { id: 'snapshot', label: tProject('tab.snapshot'), icon: Camera, badge: devices || undefined },
    { id: 'compare', label: tProject('tab.compare'), icon: GitCompareArrows },
    { id: 'code', label: tProject('tab.code'), icon: Code2 },
    { id: 'report', label: tProject('tab.report'), icon: FileText },
    { id: 'settings', label: tProject('tab.settings'), icon: Settings2 },
  ];
  return (
    <Page
      title={t('nav.project')}
      subtitle={name.trim() || tProject('subtitle')}
      icon={FolderKanban}
      actions={dirty ? <Badge tone="warn">{tProject('file.dirty')}</Badge> : undefined}
      toolbar={
        <div className="pj-tabs">
          <Tabs<TabId> items={items} value={tab} onChange={setTab} ariaLabel={t('nav.project')} />
        </div>
      }
    >
      <div className="pj-screen" data-tab={tab}>
        {tab === 'file' && <FileTab />}
        {tab === 'snapshot' && <SnapshotTab />}
        {tab === 'compare' && <CompareTab />}
        {tab === 'code' && <CodeTab />}
        {tab === 'report' && <ReportTab />}
        {tab === 'settings' && <SettingsTab />}
      </div>
    </Page>
  );
}
