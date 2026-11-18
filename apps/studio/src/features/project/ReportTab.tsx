import { useMemo, useState } from 'react';
import { Download, FileText, Printer } from 'lucide-react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useI18n, type Lang } from '../../i18n';
import { Button, EmptyState, Panel, SegmentedControl, toast } from '../../ui';
import { downloadFile, safeFileName, useProject } from '../../core';
import { ReportDocument } from './ReportDocument';
import { buildReport } from './report';
import reportCss from './report.css?inline';
import './report.css';
import { tProject } from './messages';

/** Full standalone page: the same component and stylesheet, so it prints and opens anywhere. */
function standaloneHtml(markup: string, title: string, lang: Lang): string {
  return `<!doctype html>\n<html lang="${lang}"><head><meta charset="utf-8"><title>${title.replace(/[<&]/g, '')}</title><style>body{margin:0;background:#e9eef5;display:flex;justify-content:center}@media print{body{background:#fff}}${reportCss}</style></head><body>${markup}</body></html>\n`;
}

function printHtml(html: string): void {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  if (!doc || !frame.contentWindow) {
    frame.remove();
    return;
  }
  doc.open();
  doc.write(html);
  doc.close();
  // Fonts and layout settle on the next frame; removal waits for the dialog to close.
  frame.contentWindow.addEventListener('afterprint', () => frame.remove());
  window.setTimeout(() => frame.contentWindow?.print(), 150);
}

export function ReportTab() {
  const { lang: uiLang } = useI18n();
  const project = useProject((s) => s.project);
  const [lang, setLang] = useState<Lang>(uiLang);
  const data = useMemo(() => buildReport(project, lang, { appVersion: __APP_VERSION__ }), [project, lang]);
  const html = (): string => standaloneHtml(renderToStaticMarkup(<ReportDocument data={data} />), `${tProject('rep2.fileTitle')} ${project.name}`.trim(), lang);
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
                printHtml(html());
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
