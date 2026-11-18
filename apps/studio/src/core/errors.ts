import { isCyError } from '@cygnus/protocol';
import { hasMessage, t, tl, type Lang } from '../i18n';

/**
 * One readable sentence for any failure of the host client: the board's own status label for
 * rejections (catalog text), a reason for host-side validation, the code otherwise.
 */
export function describeError(e: unknown, lang?: Lang): string {
  if (isCyError(e)) {
    if (e.code === 'REJECTED') {
      const label = e.statusLabel;
      return t('core.err.REJECTED', { status: label ? tl(label, lang) : String(e.status ?? '?') }, lang);
    }
    if (e.reason && hasMessage(`core.err.reason.${e.reason}`)) return t(`core.err.reason.${e.reason}`, undefined, lang);
    if (hasMessage(`core.err.${e.code}`)) return t(`core.err.${e.code}`, undefined, lang);
  }
  if (e instanceof Error) {
    if (hasMessage(`core.err.${e.message}`)) return t(`core.err.${e.message}`, undefined, lang);
    return e.message;
  }
  return String(e);
}
