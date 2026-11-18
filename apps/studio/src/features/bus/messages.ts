import { registerMessages } from '../../i18n';

export const tBus = registerMessages('bus', {
  tr: {
    subtitle: 'Bulunan kartlar, çakışma çözücü ve hat şeması',
    emptyTitle: 'Hatta henüz kart yok',
    emptyBody: 'Üst çubuktan simülatörü veya bir seri portu seçerek bağlanın; bulunan kartlar burada listelenir.',
  },
  en: {
    subtitle: 'Discovered devices, conflict resolver and bus diagram',
    emptyTitle: 'No devices on the bus yet',
    emptyBody: 'Connect to the simulator or a serial port from the top bar; discovered devices appear here.',
  },
});
