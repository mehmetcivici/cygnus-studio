import { useMemo, useState } from 'react';
import { Download, FileText, Printer } from 'lucide-react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useI18n, type Lang } from '../../i18n';
import { Button, EmptyState, Panel, SegmentedControl, toast } from '../../ui';
import { downloadFile, printReport, rawHtml, reportDocument, safeFileName, useProject } from '../../core';
import { ReportDocument } from './ReportDocument';
import { buildReport, type ReportData } from './report';
import reportCss from './report.css?inline';
import './report.css';
import { tProject } from './messages';

const PAGE_CSS = `body{margin:0;background:#e9eef5;display:flex;justify-content:center}@media print{body{background:#fff}}${reportCss}`;

/**
 * Full standalone page: the same component and stylesheet, so it prints and opens anywhere.
 * React escapes every value it renders (project and board names come from files), and the core
 * document wrapper adds a no-script CSP on top, so a crafted name cannot run in the report.
 */
export function reportHtml(data: ReportData, title: string, lang: Lang): string {
  return reportDocument(rawHtml(renderToStaticMarkup(<ReportDocument data={data} />)), { title, lang, css: PAGE_CSS });
}

export function ReportTab() {
  const { lang: uiLang } = useI18n();
  const project = useProject((s) => s.project);
  const [lang, setLang] = useState<Lang>(uiLang);
  const data = useMemo(() => buildReport(project, lang, { appVersion: __APP_VERSION__ }), [project, lang]);
  const html = (): string => reportHtml(data, `${tProject('rep2.fileTitle')} ${project.name}`.trim(), lang);
  const empty = project.bus.devices.length === 0;

  return (
    <div className="pj-stack">
      <Panel
        title={tProject('rep2.title')}
        subtitle={tProject('rep2.subtitle')}
        actions={
          <>
            <SegmentedControl<Lang>
              size="sm"
              value={lang}
              onChange={setLang}
              ariaLabel={tProject('rep2.language')}
              options={[
                { value: 'tr', label: 'TR' },
                { value: 'en', label: 'EN' },
              ]}
            />
            <Button size="sm" icon={Download} disabled={empty} onClick={() => downloadFile(`${safeFileName(project.name, 'cygnus')}-${tProject('rep2.fileSuffix')}.html`, html(), 'text/html')} data-testid="pj-report-download">
              {tProject('rep2.download')}
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon={Printer}
              disabled={empty}
              onClick={() => {
                void printReport(html());
                toast.info(tProject('rep2.printing'));
              }}
              data-testid="pj-report-print"
            >
              {tProject('rep2.print')}
            </Button>
          </>
        }
      >
        {empty ? (
          <EmptyState icon={FileText} title={tProject('rep2.empty')} description={tProject('rep2.emptyBody')} />
        ) : (
          <div className="pj-paper">
            <ReportDocument data={data} />
          </div>
        )}
      </Panel>
    </div>
  );
}
