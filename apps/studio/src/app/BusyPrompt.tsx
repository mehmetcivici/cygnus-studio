import { useEffect } from 'react';
import { useBusy } from '../core';
import { registerBusyPromptHost } from '../core/safety/busy';
import { useI18n } from '../i18n';
import { Button, Modal } from '../ui';

/** Answers `confirmLeave()` while a busy lock is held (firmware update, capture …). */
export function BusyPrompt() {
  const { t } = useI18n();
  const prompt = useBusy((s) => s.prompt);
  const locks = useBusy((s) => s.locks);
  useEffect(() => registerBusyPromptHost(), []);
  const reason = locks.map((l) => t(l.reasonKey, l.params)).join(', ');
  return (
    <Modal
      open={!!prompt}
      onClose={() => prompt?.resolve(false)}
      title={prompt ? t(`core.busy.${prompt.action}`) : ''}
      size="sm"
      footer={
        <>
          <Button variant="danger" onClick={() => prompt?.resolve(true)}>
            {t('core.busy.leave')}
          </Button>
          <Button variant="primary" onClick={() => prompt?.resolve(false)} autoFocus>
            {t('core.busy.stay')}
          </Button>
        </>
      }
    >
      <p>{t('core.busy.body', { reason })}</p>
    </Modal>
  );
}
