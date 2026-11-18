import { registerMessages } from '../../i18n';

export const tTuner = registerMessages('tuner', {
  tr: {
    subtitle: 'Akım, hız ve konum döngüsü ayarı',
    emptyTitle: 'Ayarlanacak bir sürücü seçin',
    emptyBody: 'Döngü seçimi, hedef üreteci, kazanç düzenleme ve basamak yanıtı ölçütleri bu ekranda olacak.',
  },
  en: {
    subtitle: 'Current, velocity and position loop tuning',
    emptyTitle: 'Select a controller to tune',
    emptyBody: 'Loop selection, setpoint generator, gain editing and step-response metrics will live here.',
  },
});
