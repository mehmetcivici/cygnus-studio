import { registerMessages } from '../../i18n';

export const tScope = registerMessages('scope', {
  tr: {
    subtitle: 'Her karttan çoklu sinyal, kayıt ve dışa aktarma',
    emptyTitle: 'Çizilecek sinyal yok',
    emptyBody: 'Bir karttan sinyal ekleyin; duraklatma, yakınlaştırma, imleç ve CSV dışa aktarma desteklenir.',
  },
  en: {
    subtitle: 'Multi-device signals, recording and export',
    emptyTitle: 'No signals to plot',
    emptyBody: 'Add signals from a device; pause, zoom, cursor readout and CSV export are supported.',
  },
});
