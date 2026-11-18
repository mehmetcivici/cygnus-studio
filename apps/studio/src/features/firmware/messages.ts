import { registerMessages } from '../../i18n';

export const tFirmware = registerMessages('firmware', {
  tr: {
    subtitle: 'Firmware yükleme ve sürüm karşılaştırma',
    emptyTitle: 'Firmware dosyası seçilmedi',
    emptyBody: '.cyfw dosyası yükleyin; tek kartı ya da aynı modeldeki tüm kartları güncelleyebilirsiniz.',
  },
  en: {
    subtitle: 'Firmware upload and version comparison',
    emptyTitle: 'No firmware file selected',
    emptyBody: 'Load a .cyfw file to update one device or every device of the same model.',
  },
});
