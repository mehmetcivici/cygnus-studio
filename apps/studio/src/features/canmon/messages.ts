import { registerMessages } from '../../i18n';

export const tCanMonitor = registerMessages('canmon', {
  tr: {
    subtitle: 'Ham ve çözümlenmiş CAN çerçeveleri',
    emptyTitle: 'Çerçeve akışı yok',
    emptyBody: 'Hatta bağlandığınızda ham çerçeveler, çözümlenmiş görünüm ve hat istatistikleri burada akar.',
  },
  en: {
    subtitle: 'Raw and decoded CAN frames',
    emptyTitle: 'No frame traffic',
    emptyBody: 'Once connected, raw frames, the decoded view and bus statistics stream here.',
  },
});
