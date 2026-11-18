import { Printer } from 'lucide-react';
import { closeReportPreview, tCore, useReportPreview } from '../core';
import { Modal } from '../ui';

/**
 * In-app report viewer for the online demo, where new windows and printing are refused.
 * The document runs in an iframe sandboxed without scripts (it also carries a no-script CSP).
 */
export function ReportPreview() {
  const preview = useReportPreview((s) => s.preview);
  return (
    <Modal open={preview !== null} onClose={closeReportPreview} title={tCore('demo.reportTitle')} size="lg" className="cy-report-preview">
      {preview && (
        <>
          <p className="cy-report-preview__note">
            {preview.print && <Printer size={14} aria-hidden />} {preview.print ? tCore('demo.noPrint') : tCore('demo.reportNote')}
          </p>
          <iframe className="cy-report-preview__frame" sandbox="" srcDoc={preview.doc} title={tCore('demo.reportTitle')} />
        </>
      )}
    </Modal>
  );
}
