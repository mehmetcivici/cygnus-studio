# Cygnus cihaz kataloğu

> Bu dosya `tools/gen-catalog.ts` tarafından `packages/protocol/src/catalog` kodundan üretilir; elle düzenlemeyin.

| Model | Ad | DEVTYPE | Tür | Sürüm | Parametre | Sinyal | Durum çerçevesi | Eylem |
|---|---|---|---|---|---|---|---|---|
| 1 | [ESC 20A](#1--esc-20a) | 2 | Motor sürücü | 1 | 58 | 14 | 5 | 4 |
| 2 | [ESC 80A](#2--esc-80a) | 2 | Motor sürücü | 1 | 58 | 14 | 5 | 4 |
| 3 | [Cyncoder](#3--cyncoder) | 7 | Sensör | 1 | 15 | 7 | 2 | 2 |
| 4 | [CAN jiroskop](#4--can-jiroskop) | 4 | Sensör | 1 | 18 | 15 | 4 | 3 |
| 5 | [CAN servo kontrol, 16 kanal](#5--can-servo-kontrol-16-kanal) | 12 | Servo | 1 | 122 | 19 | 5 | 2 |
| 6 | [Sızdırmaz CAN servo](#6--sızdırmaz-can-servo) | 12 | Servo | 1 | 21 | 9 | 3 | 1 |
| 7 | [Güç dağıtım, küçük](#7--güç-dağıtım-küçük) | 8 | Güç | 1 | 5 | 5 | 2 | 0 |
| 8 | [Güç dağıtım, büyük](#8--güç-dağıtım-büyük) | 8 | Güç | 1 | 19 | 18 | 5 | 1 |
| 9 | [SoC regülatörü](#9--soc-regülatörü) | 8 | Güç | 1 | 7 | 6 | 2 | 0 |
| 10 | [CAN debug OLED](#10--can-debug-oled) | 10 | Araç | 1 | 23 | 3 | 1 | 0 |
| 11 | [USB-CAN adaptör](#11--usb-can-adaptör) | 10 | Araç | 1 | 2 | 0 | 0 | 0 |

## Ortak tanımlar

Her modele otomatik eklenen ortak parametreler: `can.data_bitrate` (0x0001), `can.termination` (0x0002), eyleyicilerde `ctrl.timeout_ms` (0x0003) ve her durum çerçevesi için `status.n.period_ms` (0x0010+n).

**Ortak hata bitleri**

| Bit | Anahtar | Ad |
|---|---|---|
| 0 | `undervolt` | Düşük gerilim |
| 1 | `overvolt` | Yüksek gerilim |
| 2 | `overcurrent` | Aşırı akım |
| 3 | `overtemp` | Aşırı sıcaklık |
| 4 | `ctrl_timeout` | Komut zaman aşımı |
| 5 | `sensor` | Sensör hatası |
| 6 | `hardware` | Donanım hatası |
| 7 | `param_crc` | Ayar belleği bozuk |
| 8 | `can_err` | CAN hatası |
| 9 | `estop` | Acil durdurma |

**Ortak komutlar**

| Komut | Anahtar | Ad |
|---|---|---|
| 1 | `reboot` | Yeniden başlat |
| 2 | `enter_bootloader` | Önyükleyiciye geç |
| 3 | `save_params` | Ayarları karta kaydet |
| 4 | `load_defaults` | Varsayılanları yükle |
| 5 | `clear_faults` | Hataları temizle |
| 6 | `self_test` | Öz-test |
| 7 | `clear_estop` | Acil durdurmayı kaldır |

**Kart durumları**

| Değer | Ad |
|---|---|
| 0 | Açılıyor |
| 1 | Önyükleyici |
| 2 | Boşta |
| 3 | Çalışıyor |
| 4 | Hata |
| 5 | Acil durdurma |

## 1 · ESC 20A

20 A sürekli akımlı fırçasız (BLDC) motor sürücü; CAN ve PWM girişi, akım/hız/konum döngüleri.

DEVTYPE **2** · anahtar `esc20a` · katalog sürümü 1 · akış en küçük periyodu 500 µs

### Parametreler

| pid | Anahtar | Ad | Tip | Birim | Aralık | Varsayılan | Grup | Bayraklar | Açıklama |
|---|---|---|---|---|---|---|---|---|---|
| 0x0100 | `motor.pole_pairs` | Kutup çifti sayısı | u32 |  | 1 … 32 | 7 | Motor | sürerken kilitli | Motorun mıknatıs kutup sayısının yarısı; hız ölçümü buna göre hesaplanır. |
| 0x0101 | `motor.invert` | Yönü ters çevir | bool |  |  | kapalı | Motor | sürerken kilitli | Pozitif komutun motoru ters yönde döndürmesini sağlar. |
| 0x0102 | `motor.gear_ratio` | Dişli oranı (motor:mekanizma) | f32 |  | 0.01 … 1000 | 1 | Motor | sürerken kilitli | Motorun bir mekanizma turu için attığı tur sayısı; konum ve hız mekanizma tarafında raporlanır. |
| 0x0103 | `motor.idle_mode` | Boşta kipi | enum |  |  | Fren | Motor |  | Komut sıfırken motorun frenleyip frenlemeyeceği. Seçenekler: 0 Fren · 1 Serbest. |
| 0x0104 | `motor.ramp_s` | Rampa süresi (0→tam) | f32 | s | 0 … 10 | 0 | Motor |  | Açık döngü çıkışın sıfırdan tama çıkması için geçen en kısa süre; 0 rampayı kapatır. |
| 0x0105 | `motor.pwm_khz` | Anahtarlama frekansı | enum |  |  | 24 kHz | Motor | sürerken kilitli, gelişmiş | Güç katının PWM frekansı; yüksek değer daha sessiz ama daha sıcak çalışır. Seçenekler: 16 16 kHz · 24 24 kHz · 32 32 kHz · 48 48 kHz. |
| 0x0106 | `motor.timing_deg` | Komütasyon avansı | f32 | ° | 0 … 30 | 15 | Motor | sürerken kilitli, gelişmiş | Sensörsüz sürüşte komütasyonun öne alınma açısı (elektriksel derece). |
| 0x0107 | `motor.startup_duty` | Kalkış gücü | f32 |  | 0.01 … 0.5 | 0.1 | Motor | gelişmiş | Sensörsüz kalkışta uygulanan görev oranı; motor kalkamıyorsa artırın. |
| 0x0108 | `motor.resistance_ohm` | Faz direnci | f32 | Ω | 0 … 10 | 0 | Motor | gelişmiş | Faz-faz direncinin yarısı; "Motor parametrelerini ölç" eylemi doldurur, 0 ölçülmedi demektir. |
| 0x0109 | `motor.kv_rpm_per_v` | Motor kV | f32 | rpm/V | 0 … 10000 | 0 | Motor | gelişmiş | Motorun volt başına yüksüz devri; "Motor parametrelerini ölç" eylemi doldurur, 0 ölçülmedi demektir. |
| 0x010A | `motor.inductance_uh` | Faz endüktansı | f32 | µH | 0 … 10000 | 0 | Motor | gelişmiş | Faz endüktansı; akım döngüsü kazanç önerisi için kullanılır, 0 ölçülmedi demektir. |
| 0x0120 | `limits.supply_current_a` | Besleme akımı sınırı | f32 | A | 1 … 40 | 20 | Sınırlar |  | Aküden çekilen akımın üst sınırı; sigortayı ve aküyü korur. |
| 0x0121 | `limits.phase_current_a` | Faz akımı sınırı | f32 | A | 1 … 40 | 30 | Sınırlar |  | Motor sargılarındaki akımın üst sınırı; torku ve motor ısınmasını sınırlar. |
| 0x0122 | `limits.undervoltage_v` | Düşük gerilim kesme | f32 | V | 5 … 24 | 6 | Sınırlar |  | Besleme bu gerilimin altına inerse çıkış kesilir; akünüze göre ayarlayın. |
| 0x0123 | `limits.overvoltage_v` | Yüksek gerilim kesme | f32 | V | 8 … 28 | 26 | Sınırlar |  | Besleme bu gerilimi aşarsa (ör. geri besleme frenlemesinde) çıkış kesilir. |
| 0x0124 | `limits.temp_c` | Sıcaklık sınırı | f32 | °C | 50 … 120 | 100 | Sınırlar |  | Güç transistörleri bu sıcaklığa yaklaşınca akım azaltılır, aşınca çıkış kesilir. |
| 0x0125 | `limits.motor_temp_c` | Motor sıcaklık sınırı | f32 | °C | 0 … 150 (0 = kapalı, en az 50) | 0 | Sınırlar |  | Motor termistörü bağlıysa bu sıcaklıkta çıkış kesilir; 0 kapalı. |
| 0x0126 | `limits.duty_max` | En yüksek görev oranı | f32 |  | 0.05 … 1 | 1 | Sınırlar |  | Her kipte uygulanabilecek en yüksek çıkış oranı. |
| 0x0127 | `limits.fwd_soft_enable` | İleri yazılım limiti etkin | bool |  |  | kapalı | Sınırlar |  | Konum ileri limiti aşınca ileri yönde sürüş engellenir. |
| 0x0128 | `limits.fwd_soft_rot` | İleri yazılım limiti | f32 | rot | -100000 … 100000 | 0 | Sınırlar |  | İleri yöndeki en büyük izinli konum (mekanizma turu). |
| 0x0129 | `limits.rev_soft_enable` | Geri yazılım limiti etkin | bool |  |  | kapalı | Sınırlar |  | Konum geri limitin altına inince geri yönde sürüş engellenir. |
| 0x012A | `limits.rev_soft_rot` | Geri yazılım limiti | f32 | rot | -100000 … 100000 | 0 | Sınırlar |  | Geri yöndeki en küçük izinli konum (mekanizma turu). |
| 0x0140 | `current.kp` | Akım döngüsü · Kp | f32 | V/A | 0 … 10 | 0.2 | Akım döngüsü |  | Akım hatasına orantılı gerilim kazancı. |
| 0x0141 | `current.ki` | Akım döngüsü · Ki | f32 | V/(A·s) | 0 … 20000 | 600 | Akım döngüsü |  | Akım hatasının integraline uygulanan kazanç; kalıcı hatayı giderir. |
| 0x0160 | `vel.kp` | Hız döngüsü · Kp | f32 | V/rpm | 0 … 1 | 0.001 | Hız döngüsü |  | Hız hatasına orantılı gerilim kazancı. |
| 0x0161 | `vel.ki` | Hız döngüsü · Ki | f32 | V/(rpm·s) | 0 … 10 | 0 | Hız döngüsü |  | Hız hatasının integraline uygulanan kazanç. |
| 0x0162 | `vel.kd` | Hız döngüsü · Kd | f32 | V/(rpm/s) | 0 … 0.1 | 0 | Hız döngüsü |  | Hız hatasının değişim hızına uygulanan kazanç; aşmayı azaltır. |
| 0x0163 | `vel.ks` | Hız döngüsü · kS (statik sürtünme) | f32 | V | 0 … 5 | 0 | Hız döngüsü |  | Hareket yönünde eklenen sabit gerilim; sürtünmeyi yenmek için gerekir. |
| 0x0164 | `vel.kv` | Hız döngüsü · kV | f32 | V/rpm | 0 … 0.1 | 0 | Hız döngüsü |  | Hedef hıza orantılı ileri besleme gerilimi; yaklaşık 1 / motor kV. |
| 0x0165 | `vel.ka` | Hız döngüsü · kA | f32 | V/(rpm/s) | 0 … 0.01 | 0 | Hız döngüsü |  | Hedef ivmeye orantılı ileri besleme gerilimi. |
| 0x0166 | `vel.i_max` | Hız döngüsü · İntegral sınırı | f32 | V | 0 … 26 | 2 | Hız döngüsü |  | İntegral teriminin katkısının üst sınırı; doymayı (windup) önler. |
| 0x0167 | `vel.out_max` | Hız döngüsü · Çıkış sınırı | f32 | V | 0 … 26 | 26 | Hız döngüsü |  | Hız döngüsünün uygulayabileceği en yüksek gerilim. |
| 0x0168 | `vel.filter_hz` | Hız filtresi | f32 | Hz | 1 … 1000 | 100 | Hız döngüsü |  | Hız ölçümüne uygulanan alçak geçiren filtrenin kesim frekansı. |
| 0x0180 | `pos.kp` | Konum döngüsü · Kp | f32 | V/rot | 0 … 1000 | 2 | Konum döngüsü |  | Konum hatasına orantılı gerilim kazancı. |
| 0x0181 | `pos.ki` | Konum döngüsü · Ki | f32 | V/(rot·s) | 0 … 1000 | 0 | Konum döngüsü |  | Konum hatasının integraline uygulanan kazanç. |
| 0x0182 | `pos.kd` | Konum döngüsü · Kd | f32 | V/(rot/s) | 0 … 100 | 0 | Konum döngüsü |  | Konum hatasının değişim hızına uygulanan kazanç; salınımı söndürür. |
| 0x0183 | `pos.i_max` | Konum döngüsü · İntegral sınırı | f32 | V | 0 … 26 | 2 | Konum döngüsü |  | İntegral teriminin katkısının üst sınırı. |
| 0x0184 | `pos.cruise_rpm` | Profil · En yüksek hız | f32 | rpm | 0 … 100000 | 0 | Konum döngüsü |  | Trapez hareket profilinin en yüksek hızı; 0 profili kapatır ve hedefe doğrudan gidilir. |
| 0x0185 | `pos.accel_rpm_s` | Profil · En yüksek ivme | f32 | rpm/s | 0 … 1000000 | 0 | Konum döngüsü |  | Trapez hareket profilinin ivmesi; 0 sınırsız ivme demektir. |
| 0x0186 | `pos.tolerance_rot` | İzin verilen hata | f32 | rot | 0 … 10 | 0.01 | Konum döngüsü |  | Hata bu değerin altındayken hedefe varılmış sayılır ve döngü çıkışı tutulur. |
| 0x01A0 | `fb.source` | Geri besleme kaynağı | enum |  |  | Sensörsüz | Geri besleme | sürerken kilitli | Hız ve konum ölçümünün nereden alınacağı. Seçenekler: 0 Sensörsüz · 1 Hall sensörleri · 2 Uzak Cyncoder. |
| 0x01A1 | `fb.remote_num` | Uzak Cyncoder numarası | u32 |  | 1 … 62 | 1 | Geri besleme | sürerken kilitli | Kaynak "Uzak Cyncoder" iken durumu dinlenecek kodlayıcının CAN numarası. |
| 0x01A2 | `fb.sensor_invert` | Sensör yönünü çevir | bool |  |  | kapalı | Geri besleme | sürerken kilitli | Sensörün saydığı yön motorun pozitif yönüne ters ise açın. |
| 0x01A3 | `fb.remote_ratio` | Uzak sensör:mekanizma oranı | f32 |  | 0.001 … 1000 | 1 | Geri besleme | sürerken kilitli | Uzak kodlayıcının bir mekanizma turu için attığı tur sayısı. |
| 0x01C0 | `pwm.enable` | PWM girişi etkin | bool |  |  | kapalı | PWM girişi |  | Kart CAN yerine servo tipi PWM sinyaliyle sürülür; CAN komutu gelirse CAN önceliklidir. |
| 0x01C1 | `pwm.min_us` | En küçük darbe | u32 | µs | 500 … 2500 | 1000 | PWM girişi |  | Tam geri (veya tek yönde sıfır) çıkışa karşılık gelen darbe genişliği. |
| 0x01C2 | `pwm.mid_us` | Orta darbe | u32 | µs | 500 … 2500 | 1500 | PWM girişi |  | Çift yönlü kipte sıfır çıkışa karşılık gelen darbe genişliği. |
| 0x01C3 | `pwm.max_us` | En büyük darbe | u32 | µs | 500 … 2500 | 2000 | PWM girişi |  | Tam ileri çıkışa karşılık gelen darbe genişliği. |
| 0x01C4 | `pwm.deadband_us` | Ölü bant | u32 | µs | 0 … 200 | 10 | PWM girişi |  | Orta darbenin çevresinde çıkışın sıfır tutulduğu bant genişliği. |
| 0x01C5 | `pwm.bidirectional` | Çift yön | bool |  |  | açık | PWM girişi |  | Açıkken orta darbe sıfırdır; kapalıyken en küçük darbe sıfır, en büyük darbe tam ileridir. |
| 0x0001 | `can.data_bitrate` | FD veri hızı | enum |  |  | 2 Mbit/s | CAN hattı | yeniden başlatma | CAN-FD veri evresinin hızı; Klasik seçilirse kart FD çerçevesi göndermez (roboRIO ve MCP2515 hatları için). Seçenekler: 0 Klasik (FD yok) · 1 2 Mbit/s · 2 5 Mbit/s · 3 8 Mbit/s. |
| 0x0002 | `can.termination` | Hat sonlandırma (120 Ω) | bool |  |  | kapalı | CAN hattı | salt-okunur | Bu kartta anahtarlanabilir sonlandırma yok; değer her zaman kapalıdır. |
| 0x0003 | `ctrl.timeout_ms` | Komut zaman aşımı | u32 | ms | 20 … 2000 | 200 | Kontrol |  | Bu süre içinde yeni kontrol çerçevesi gelmezse çıkış nötre döner ve uyarı verilir. |
| 0x0010 | `status.0.period_ms` | Durum 0 periyodu · Hızlı | u32 | ms | 0 … 60000 (0 = kapalı, en az 5) | 10 | Durum çerçeveleri |  | Hızlı çerçevesinin gönderim aralığı; 0 çerçeveyi kapatır, en az 5 ms. |
| 0x0011 | `status.1.period_ms` | Durum 1 periyodu · Konum ve besleme | u32 | ms | 0 … 60000 (0 = kapalı, en az 5) | 20 | Durum çerçeveleri |  | Konum ve besleme çerçevesinin gönderim aralığı; 0 çerçeveyi kapatır, en az 5 ms. |
| 0x0012 | `status.2.period_ms` | Durum 2 periyodu · Kapalı döngü | u32 | ms | 0 … 60000 (0 = kapalı, en az 5) | 50 | Durum çerçeveleri |  | Kapalı döngü çerçevesinin gönderim aralığı; 0 çerçeveyi kapatır, en az 5 ms. |
| 0x0013 | `status.3.period_ms` | Durum 3 periyodu · Isıl ve giriş | u32 | ms | 0 … 60000 (0 = kapalı, en az 5) | 100 | Durum çerçeveleri |  | Isıl ve giriş çerçevesinin gönderim aralığı; 0 çerçeveyi kapatır, en az 5 ms. |
| 0x0014 | `status.4.period_ms` | Durum 4 periyodu · Enerji | u32 | ms | 0 … 60000 (0 = kapalı, en az 5) | 500 | Durum çerçeveleri |  | Enerji çerçevesinin gönderim aralığı; 0 çerçeveyi kapatır, en az 5 ms. |

### Sinyaller

| sid | Anahtar | Ad | Birim | Gösterim aralığı | Basamak | Değerler |
|---|---|---|---|---|---|---|
| 1 | `bus.voltage` | Besleme gerilimi | V | 0 … 30 | 2 |  |
| 2 | `bus.current` | Besleme akımı | A | -20 … 40 | 2 |  |
| 3 | `phase.current` | Faz akımı | A | -40 … 40 | 2 |  |
| 4 | `duty` | Görev oranı |  | -1 … 1 | 3 |  |
| 5 | `velocity` | Hız | rpm | -30000 … 30000 | 1 |  |
| 6 | `position` | Konum | rot | -10 … 10 | 3 |  |
| 7 | `setpoint` | Hedef |  | -30000 … 30000 | 3 |  |
| 8 | `error` | Kapalı döngü hatası |  | -1000 … 1000 | 3 |  |
| 9 | `loop.output` | Döngü çıkışı | V | -26 … 26 | 2 |  |
| 10 | `temp.fet` | FET sıcaklığı | °C | 0 … 120 | 1 |  |
| 11 | `temp.motor` | Motor sıcaklığı | °C | 0 … 150 | 1 |  |
| 12 | `pwm.pulse` | PWM giriş darbesi | µs | 800 … 2200 | 0 |  |
| 13 | `energy` | Harcanan enerji | Wh | 0 … 100 | 2 |  |
| 14 | `ctrl.mode` | Etkin kontrol kipi |  | 0 … 5 | 0 | 0 Kapalı · 1 Görev oranı · 2 Akım · 3 Hız · 4 Konum · 5 Fren |

### Durum çerçeveleri

**STATUS/0 · Hızlı** — varsayılan periyot 10 ms (`status.0.period_ms`)

| Bayt | Bit | Tip | Sinyal | Ölçek | Sapma | Birim |
|---|---|---|---|---|---|---|
| 0 |  | f32 | `velocity` |  |  | rpm |
| 4 |  | i16 | `phase.current` | 0.01 |  | A |
| 6 |  | i16 | `duty` | 0.0001 |  |  |

**STATUS/1 · Konum ve besleme** — varsayılan periyot 20 ms (`status.1.period_ms`)

| Bayt | Bit | Tip | Sinyal | Ölçek | Sapma | Birim |
|---|---|---|---|---|---|---|
| 0 |  | f32 | `position` |  |  | rot |
| 4 |  | u16 | `bus.voltage` | 0.01 |  | V |
| 6 |  | i16 | `bus.current` | 0.01 |  | A |

**STATUS/2 · Kapalı döngü** — varsayılan periyot 50 ms (`status.2.period_ms`)

| Bayt | Bit | Tip | Sinyal | Ölçek | Sapma | Birim |
|---|---|---|---|---|---|---|
| 0 |  | f32 | `setpoint` |  |  |  |
| 4 |  | f32 | `error` |  |  |  |

**STATUS/3 · Isıl ve giriş** — varsayılan periyot 100 ms (`status.3.period_ms`)

| Bayt | Bit | Tip | Sinyal | Ölçek | Sapma | Birim |
|---|---|---|---|---|---|---|
| 0 |  | i16 | `loop.output` | 0.001 |  | V |
| 2 |  | i16 | `temp.fet` | 0.1 |  | °C |
| 4 |  | i16 | `temp.motor` | 0.1 |  | °C |
| 6 |  | u16 | `pwm.pulse` | 1 |  | µs |

**STATUS/4 · Enerji** — varsayılan periyot 500 ms (`status.4.period_ms`)

| Bayt | Bit | Tip | Sinyal | Ölçek | Sapma | Birim |
|---|---|---|---|---|---|---|
| 0 |  | f32 | `energy` |  |  | Wh |
| 4 |  | u8 | `ctrl.mode` | 1 |  |  |

### Kontrol çerçeveleri

**CTRL/0 · Sürüş komutu** — `[mode u8] [flags u8] [0 0] [value f32]`

| Kip | Anahtar | Ad | Birim | Değer aralığı |
|---|---|---|---|---|
| 0 | `off` | Kapalı (boşta) |  | — |
| 1 | `duty` | Görev oranı |  | -1 … 1 |
| 2 | `current` | Akım | A | -40 … 40 |
| 3 | `velocity` | Hız | rpm | -30000 … 30000 |
| 4 | `position` | Konum | rot | -100000 … 100000 |
| 5 | `brake` | Fren |  | — |

### Eylemler

| Komut | Anahtar | Ad | Argüman | Açıklama |
|---|---|---|---|---|
| 0x40 | `detect_direction` | Motor yönünü algıla |  | Motoru kısa süre döndürür ve sensör yönünü motor yönüyle eşleştirir. _(uzun süren, onay ister)_ |
| 0x41 | `measure_motor` | Motor parametrelerini ölç |  | Faz direncini, endüktansı ve kV değerini ölçüp ilgili ayarlara yazar; motor döner. _(uzun süren, onay ister)_ |
| 0x42 | `calibrate_pwm` | PWM girişini kalibre et |  | Kumandayı sırayla orta, tam ileri ve tam geri konuma getirin; darbe sınırları kaydedilir. _(uzun süren)_ |
| 0x43 | `set_position` | Konumu sıfırla | Yeni konum (f32, rot, -100000 … 100000) | Ölçülen konumu verilen değere (varsayılan 0) ayarlar. |

### Modele özgü hatalar

| Bit | Anahtar | Ad |
|---|---|---|
| 10 | `motor_disconnected` | Motor bağlantısı yok |
| 11 | `sensor_lost` | Sensör kaybı |
| 12 | `locked_rotor` | Kilitli rotor |
| 13 | `remote_sensor_lost` | Uzak sensör kayıp |

### Öz-test bitleri

| Bit | Anahtar | Ad |
|---|---|---|
| 0 | `gate_driver` | Kapı sürücüsü |
| 1 | `current_sense` | Akım ölçümü |
| 2 | `voltage_sense` | Gerilim ölçümü |
| 3 | `temp_sensor` | Sıcaklık sensörü |
| 4 | `hall_sensors` | Hall sensörleri |
| 5 | `param_storage` | Ayar belleği |

### Tuner döngüleri

| Döngü | Kip | Birim | Kazançlar | Hedef / ölçüm / çıkış / hata |
|---|---|---|---|---|
| Akım döngüsü | CTRL/0 kip 2 | A | kp=`current.kp` ki=`current.ki` | `setpoint` / `phase.current` / `loop.output` / `error` |
| Hız döngüsü | CTRL/0 kip 3 | rpm | kp=`vel.kp` ki=`vel.ki` kd=`vel.kd` kS=`vel.ks` kV=`vel.kv` kA=`vel.ka` iMax=`vel.i_max` outMax=`vel.out_max` | `setpoint` / `velocity` / `loop.output` / `error` |
| Konum döngüsü | CTRL/0 kip 4 | rot | kp=`pos.kp` ki=`pos.ki` kd=`pos.kd` iMax=`pos.i_max` | `setpoint` / `position` / `loop.output` / `error` |

## 2 · ESC 80A

80 A sürekli akımlı fırçasız (BLDC) motor sürücü; CAN ve PWM girişi, akım/hız/konum döngüleri.

DEVTYPE **2** · anahtar `esc80a` · katalog sürümü 1 · akış en küçük periyodu 500 µs

### Parametreler

| pid | Anahtar | Ad | Tip | Birim | Aralık | Varsayılan | Grup | Bayraklar | Açıklama |
|---|---|---|---|---|---|---|---|---|---|
| 0x0100 | `motor.pole_pairs` | Kutup çifti sayısı | u32 |  | 1 … 32 | 7 | Motor | sürerken kilitli | Motorun mıknatıs kutup sayısının yarısı; hız ölçümü buna göre hesaplanır. |
| 0x0101 | `motor.invert` | Yönü ters çevir | bool |  |  | kapalı | Motor | sürerken kilitli | Pozitif komutun motoru ters yönde döndürmesini sağlar. |
| 0x0102 | `motor.gear_ratio` | Dişli oranı (motor:mekanizma) | f32 |  | 0.01 … 1000 | 1 | Motor | sürerken kilitli | Motorun bir mekanizma turu için attığı tur sayısı; konum ve hız mekanizma tarafında raporlanır. |
| 0x0103 | `motor.idle_mode` | Boşta kipi | enum |  |  | Fren | Motor |  | Komut sıfırken motorun frenleyip frenlemeyeceği. Seçenekler: 0 Fren · 1 Serbest. |
| 0x0104 | `motor.ramp_s` | Rampa süresi (0→tam) | f32 | s | 0 … 10 | 0 | Motor |  | Açık döngü çıkışın sıfırdan tama çıkması için geçen en kısa süre; 0 rampayı kapatır. |
| 0x0105 | `motor.pwm_khz` | Anahtarlama frekansı | enum |  |  | 24 kHz | Motor | sürerken kilitli, gelişmiş | Güç katının PWM frekansı; yüksek değer daha sessiz ama daha sıcak çalışır. Seçenekler: 16 16 kHz · 24 24 kHz · 32 32 kHz · 48 48 kHz. |
| 0x0106 | `motor.timing_deg` | Komütasyon avansı | f32 | ° | 0 … 30 | 15 | Motor | sürerken kilitli, gelişmiş | Sensörsüz sürüşte komütasyonun öne alınma açısı (elektriksel derece). |
| 0x0107 | `motor.startup_duty` | Kalkış gücü | f32 |  | 0.01 … 0.5 | 0.1 | Motor | gelişmiş | Sensörsüz kalkışta uygulanan görev oranı; motor kalkamıyorsa artırın. |
| 0x0108 | `motor.resistance_ohm` | Faz direnci | f32 | Ω | 0 … 10 | 0 | Motor | gelişmiş | Faz-faz direncinin yarısı; "Motor parametrelerini ölç" eylemi doldurur, 0 ölçülmedi demektir. |
| 0x0109 | `motor.kv_rpm_per_v` | Motor kV | f32 | rpm/V | 0 … 10000 | 0 | Motor | gelişmiş | Motorun volt başına yüksüz devri; "Motor parametrelerini ölç" eylemi doldurur, 0 ölçülmedi demektir. |
| 0x010A | `motor.inductance_uh` | Faz endüktansı | f32 | µH | 0 … 10000 | 0 | Motor | gelişmiş | Faz endüktansı; akım döngüsü kazanç önerisi için kullanılır, 0 ölçülmedi demektir. |
| 0x0120 | `limits.supply_current_a` | Besleme akımı sınırı | f32 | A | 1 … 150 | 60 | Sınırlar |  | Aküden çekilen akımın üst sınırı; sigortayı ve aküyü korur. |
| 0x0121 | `limits.phase_current_a` | Faz akımı sınırı | f32 | A | 1 … 150 | 100 | Sınırlar |  | Motor sargılarındaki akımın üst sınırı; torku ve motor ısınmasını sınırlar. |
| 0x0122 | `limits.undervoltage_v` | Düşük gerilim kesme | f32 | V | 5 … 28 | 6 | Sınırlar |  | Besleme bu gerilimin altına inerse çıkış kesilir; akünüze göre ayarlayın. |
| 0x0123 | `limits.overvoltage_v` | Yüksek gerilim kesme | f32 | V | 8 … 32 | 30 | Sınırlar |  | Besleme bu gerilimi aşarsa (ör. geri besleme frenlemesinde) çıkış kesilir. |
| 0x0124 | `limits.temp_c` | Sıcaklık sınırı | f32 | °C | 50 … 120 | 100 | Sınırlar |  | Güç transistörleri bu sıcaklığa yaklaşınca akım azaltılır, aşınca çıkış kesilir. |
| 0x0125 | `limits.motor_temp_c` | Motor sıcaklık sınırı | f32 | °C | 0 … 150 (0 = kapalı, en az 50) | 0 | Sınırlar |  | Motor termistörü bağlıysa bu sıcaklıkta çıkış kesilir; 0 kapalı. |
| 0x0126 | `limits.duty_max` | En yüksek görev oranı | f32 |  | 0.05 … 1 | 1 | Sınırlar |  | Her kipte uygulanabilecek en yüksek çıkış oranı. |
| 0x0127 | `limits.fwd_soft_enable` | İleri yazılım limiti etkin | bool |  |  | kapalı | Sınırlar |  | Konum ileri limiti aşınca ileri yönde sürüş engellenir. |
| 0x0128 | `limits.fwd_soft_rot` | İleri yazılım limiti | f32 | rot | -100000 … 100000 | 0 | Sınırlar |  | İleri yöndeki en büyük izinli konum (mekanizma turu). |
| 0x0129 | `limits.rev_soft_enable` | Geri yazılım limiti etkin | bool |  |  | kapalı | Sınırlar |  | Konum geri limitin altına inince geri yönde sürüş engellenir. |
| 0x012A | `limits.rev_soft_rot` | Geri yazılım limiti | f32 | rot | -100000 … 100000 | 0 | Sınırlar |  | Geri yöndeki en küçük izinli konum (mekanizma turu). |
| 0x0140 | `current.kp` | Akım döngüsü · Kp | f32 | V/A | 0 … 10 | 0.06 | Akım döngüsü |  | Akım hatasına orantılı gerilim kazancı. |
| 0x0141 | `current.ki` | Akım döngüsü · Ki | f32 | V/(A·s) | 0 … 20000 | 120 | Akım döngüsü |  | Akım hatasının integraline uygulanan kazanç; kalıcı hatayı giderir. |
| 0x0160 | `vel.kp` | Hız döngüsü · Kp | f32 | V/rpm | 0 … 1 | 0.002 | Hız döngüsü |  | Hız hatasına orantılı gerilim kazancı. |
| 0x0161 | `vel.ki` | Hız döngüsü · Ki | f32 | V/(rpm·s) | 0 … 10 | 0 | Hız döngüsü |  | Hız hatasının integraline uygulanan kazanç. |
| 0x0162 | `vel.kd` | Hız döngüsü · Kd | f32 | V/(rpm/s) | 0 … 0.1 | 0 | Hız döngüsü |  | Hız hatasının değişim hızına uygulanan kazanç; aşmayı azaltır. |
| 0x0163 | `vel.ks` | Hız döngüsü · kS (statik sürtünme) | f32 | V | 0 … 5 | 0 | Hız döngüsü |  | Hareket yönünde eklenen sabit gerilim; sürtünmeyi yenmek için gerekir. |
| 0x0164 | `vel.kv` | Hız döngüsü · kV | f32 | V/rpm | 0 … 0.1 | 0 | Hız döngüsü |  | Hedef hıza orantılı ileri besleme gerilimi; yaklaşık 1 / motor kV. |
| 0x0165 | `vel.ka` | Hız döngüsü · kA | f32 | V/(rpm/s) | 0 … 0.01 | 0 | Hız döngüsü |  | Hedef ivmeye orantılı ileri besleme gerilimi. |
| 0x0166 | `vel.i_max` | Hız döngüsü · İntegral sınırı | f32 | V | 0 … 30 | 2 | Hız döngüsü |  | İntegral teriminin katkısının üst sınırı; doymayı (windup) önler. |
| 0x0167 | `vel.out_max` | Hız döngüsü · Çıkış sınırı | f32 | V | 0 … 30 | 30 | Hız döngüsü |  | Hız döngüsünün uygulayabileceği en yüksek gerilim. |
| 0x0168 | `vel.filter_hz` | Hız filtresi | f32 | Hz | 1 … 1000 | 100 | Hız döngüsü |  | Hız ölçümüne uygulanan alçak geçiren filtrenin kesim frekansı. |
| 0x0180 | `pos.kp` | Konum döngüsü · Kp | f32 | V/rot | 0 … 1000 | 2 | Konum döngüsü |  | Konum hatasına orantılı gerilim kazancı. |
| 0x0181 | `pos.ki` | Konum döngüsü · Ki | f32 | V/(rot·s) | 0 … 1000 | 0 | Konum döngüsü |  | Konum hatasının integraline uygulanan kazanç. |
| 0x0182 | `pos.kd` | Konum döngüsü · Kd | f32 | V/(rot/s) | 0 … 100 | 0 | Konum döngüsü |  | Konum hatasının değişim hızına uygulanan kazanç; salınımı söndürür. |
| 0x0183 | `pos.i_max` | Konum döngüsü · İntegral sınırı | f32 | V | 0 … 30 | 2 | Konum döngüsü |  | İntegral teriminin katkısının üst sınırı. |
| 0x0184 | `pos.cruise_rpm` | Profil · En yüksek hız | f32 | rpm | 0 … 100000 | 0 | Konum döngüsü |  | Trapez hareket profilinin en yüksek hızı; 0 profili kapatır ve hedefe doğrudan gidilir. |
| 0x0185 | `pos.accel_rpm_s` | Profil · En yüksek ivme | f32 | rpm/s | 0 … 1000000 | 0 | Konum döngüsü |  | Trapez hareket profilinin ivmesi; 0 sınırsız ivme demektir. |
| 0x0186 | `pos.tolerance_rot` | İzin verilen hata | f32 | rot | 0 … 10 | 0.01 | Konum döngüsü |  | Hata bu değerin altındayken hedefe varılmış sayılır ve döngü çıkışı tutulur. |
| 0x01A0 | `fb.source` | Geri besleme kaynağı | enum |  |  | Sensörsüz | Geri besleme | sürerken kilitli | Hız ve konum ölçümünün nereden alınacağı. Seçenekler: 0 Sensörsüz · 1 Hall sensörleri · 2 Uzak Cyncoder. |
| 0x01A1 | `fb.remote_num` | Uzak Cyncoder numarası | u32 |  | 1 … 62 | 1 | Geri besleme | sürerken kilitli | Kaynak "Uzak Cyncoder" iken durumu dinlenecek kodlayıcının CAN numarası. |
| 0x01A2 | `fb.sensor_invert` | Sensör yönünü çevir | bool |  |  | kapalı | Geri besleme | sürerken kilitli | Sensörün saydığı yön motorun pozitif yönüne ters ise açın. |
| 0x01A3 | `fb.remote_ratio` | Uzak sensör:mekanizma oranı | f32 |  | 0.001 … 1000 | 1 | Geri besleme | sürerken kilitli | Uzak kodlayıcının bir mekanizma turu için attığı tur sayısı. |
| 0x01C0 | `pwm.enable` | PWM girişi etkin | bool |  |  | kapalı | PWM girişi |  | Kart CAN yerine servo tipi PWM sinyaliyle sürülür; CAN komutu gelirse CAN önceliklidir. |
| 0x01C1 | `pwm.min_us` | En küçük darbe | u32 | µs | 500 … 2500 | 1000 | PWM girişi |  | Tam geri (veya tek yönde sıfır) çıkışa karşılık gelen darbe genişliği. |
| 0x01C2 | `pwm.mid_us` | Orta darbe | u32 | µs | 500 … 2500 | 1500 | PWM girişi |  | Çift yönlü kipte sıfır çıkışa karşılık gelen darbe genişliği. |
| 0x01C3 | `pwm.max_us` | En büyük darbe | u32 | µs | 500 … 2500 | 2000 | PWM girişi |  | Tam ileri çıkışa karşılık gelen darbe genişliği. |
| 0x01C4 | `pwm.deadband_us` | Ölü bant | u32 | µs | 0 … 200 | 10 | PWM girişi |  | Orta darbenin çevresinde çıkışın sıfır tutulduğu bant genişliği. |
| 0x01C5 | `pwm.bidirectional` | Çift yön | bool |  |  | açık | PWM girişi |  | Açıkken orta darbe sıfırdır; kapalıyken en küçük darbe sıfır, en büyük darbe tam ileridir. |
| 0x0001 | `can.data_bitrate` | FD veri hızı | enum |  |  | 2 Mbit/s | CAN hattı | yeniden başlatma | CAN-FD veri evresinin hızı; Klasik seçilirse kart FD çerçevesi göndermez (roboRIO ve MCP2515 hatları için). Seçenekler: 0 Klasik (FD yok) · 1 2 Mbit/s · 2 5 Mbit/s · 3 8 Mbit/s. |
| 0x0002 | `can.termination` | Hat sonlandırma (120 Ω) | bool |  |  | kapalı | CAN hattı | salt-okunur | Bu kartta anahtarlanabilir sonlandırma yok; değer her zaman kapalıdır. |
| 0x0003 | `ctrl.timeout_ms` | Komut zaman aşımı | u32 | ms | 20 … 2000 | 200 | Kontrol |  | Bu süre içinde yeni kontrol çerçevesi gelmezse çıkış nötre döner ve uyarı verilir. |
| 0x0010 | `status.0.period_ms` | Durum 0 periyodu · Hızlı | u32 | ms | 0 … 60000 (0 = kapalı, en az 5) | 10 | Durum çerçeveleri |  | Hızlı çerçevesinin gönderim aralığı; 0 çerçeveyi kapatır, en az 5 ms. |
| 0x0011 | `status.1.period_ms` | Durum 1 periyodu · Konum ve besleme | u32 | ms | 0 … 60000 (0 = kapalı, en az 5) | 20 | Durum çerçeveleri |  | Konum ve besleme çerçevesinin gönderim aralığı; 0 çerçeveyi kapatır, en az 5 ms. |
| 0x0012 | `status.2.period_ms` | Durum 2 periyodu · Kapalı döngü | u32 | ms | 0 … 60000 (0 = kapalı, en az 5) | 50 | Durum çerçeveleri |  | Kapalı döngü çerçevesinin gönderim aralığı; 0 çerçeveyi kapatır, en az 5 ms. |
| 0x0013 | `status.3.period_ms` | Durum 3 periyodu · Isıl ve giriş | u32 | ms | 0 … 60000 (0 = kapalı, en az 5) | 100 | Durum çerçeveleri |  | Isıl ve giriş çerçevesinin gönderim aralığı; 0 çerçeveyi kapatır, en az 5 ms. |
| 0x0014 | `status.4.period_ms` | Durum 4 periyodu · Enerji | u32 | ms | 0 … 60000 (0 = kapalı, en az 5) | 500 | Durum çerçeveleri |  | Enerji çerçevesinin gönderim aralığı; 0 çerçeveyi kapatır, en az 5 ms. |

### Sinyaller

| sid | Anahtar | Ad | Birim | Gösterim aralığı | Basamak | Değerler |
|---|---|---|---|---|---|---|
| 1 | `bus.voltage` | Besleme gerilimi | V | 0 … 34 | 2 |  |
| 2 | `bus.current` | Besleme akımı | A | -80 … 150 | 2 |  |
| 3 | `phase.current` | Faz akımı | A | -150 … 150 | 2 |  |
| 4 | `duty` | Görev oranı |  | -1 … 1 | 3 |  |
| 5 | `velocity` | Hız | rpm | -10000 … 10000 | 1 |  |
| 6 | `position` | Konum | rot | -10 … 10 | 3 |  |
| 7 | `setpoint` | Hedef |  | -10000 … 10000 | 3 |  |
| 8 | `error` | Kapalı döngü hatası |  | -1000 … 1000 | 3 |  |
| 9 | `loop.output` | Döngü çıkışı | V | -30 … 30 | 2 |  |
| 10 | `temp.fet` | FET sıcaklığı | °C | 0 … 120 | 1 |  |
| 11 | `temp.motor` | Motor sıcaklığı | °C | 0 … 150 | 1 |  |
| 12 | `pwm.pulse` | PWM giriş darbesi | µs | 800 … 2200 | 0 |  |
| 13 | `energy` | Harcanan enerji | Wh | 0 … 100 | 2 |  |
| 14 | `ctrl.mode` | Etkin kontrol kipi |  | 0 … 5 | 0 | 0 Kapalı · 1 Görev oranı · 2 Akım · 3 Hız · 4 Konum · 5 Fren |

### Durum çerçeveleri

**STATUS/0 · Hızlı** — varsayılan periyot 10 ms (`status.0.period_ms`)

| Bayt | Bit | Tip | Sinyal | Ölçek | Sapma | Birim |
|---|---|---|---|---|---|---|
| 0 |  | f32 | `velocity` |  |  | rpm |
| 4 |  | i16 | `phase.current` | 0.01 |  | A |
| 6 |  | i16 | `duty` | 0.0001 |  |  |

**STATUS/1 · Konum ve besleme** — varsayılan periyot 20 ms (`status.1.period_ms`)

| Bayt | Bit | Tip | Sinyal | Ölçek | Sapma | Birim |
|---|---|---|---|---|---|---|
| 0 |  | f32 | `position` |  |  | rot |
| 4 |  | u16 | `bus.voltage` | 0.01 |  | V |
| 6 |  | i16 | `bus.current` | 0.01 |  | A |

**STATUS/2 · Kapalı döngü** — varsayılan periyot 50 ms (`status.2.period_ms`)

| Bayt | Bit | Tip | Sinyal | Ölçek | Sapma | Birim |
|---|---|---|---|---|---|---|
| 0 |  | f32 | `setpoint` |  |  |  |
| 4 |  | f32 | `error` |  |  |  |

**STATUS/3 · Isıl ve giriş** — varsayılan periyot 100 ms (`status.3.period_ms`)

| Bayt | Bit | Tip | Sinyal | Ölçek | Sapma | Birim |
|---|---|---|---|---|---|---|
| 0 |  | i16 | `loop.output` | 0.001 |  | V |
| 2 |  | i16 | `temp.fet` | 0.1 |  | °C |
| 4 |  | i16 | `temp.motor` | 0.1 |  | °C |
| 6 |  | u16 | `pwm.pulse` | 1 |  | µs |

**STATUS/4 · Enerji** — varsayılan periyot 500 ms (`status.4.period_ms`)

| Bayt | Bit | Tip | Sinyal | Ölçek | Sapma | Birim |
|---|---|---|---|---|---|---|
| 0 |  | f32 | `energy` |  |  | Wh |
| 4 |  | u8 | `ctrl.mode` | 1 |  |  |

### Kontrol çerçeveleri

**CTRL/0 · Sürüş komutu** — `[mode u8] [flags u8] [0 0] [value f32]`

| Kip | Anahtar | Ad | Birim | Değer aralığı |
|---|---|---|---|---|
| 0 | `off` | Kapalı (boşta) |  | — |
| 1 | `duty` | Görev oranı |  | -1 … 1 |
| 2 | `current` | Akım | A | -150 … 150 |
| 3 | `velocity` | Hız | rpm | -10000 … 10000 |
| 4 | `position` | Konum | rot | -100000 … 100000 |
| 5 | `brake` | Fren |  | — |

### Eylemler

| Komut | Anahtar | Ad | Argüman | Açıklama |
|---|---|---|---|---|
| 0x40 | `detect_direction` | Motor yönünü algıla |  | Motoru kısa süre döndürür ve sensör yönünü motor yönüyle eşleştirir. _(uzun süren, onay ister)_ |
| 0x41 | `measure_motor` | Motor parametrelerini ölç |  | Faz direncini, endüktansı ve kV değerini ölçüp ilgili ayarlara yazar; motor döner. _(uzun süren, onay ister)_ |
| 0x42 | `calibrate_pwm` | PWM girişini kalibre et |  | Kumandayı sırayla orta, tam ileri ve tam geri konuma getirin; darbe sınırları kaydedilir. _(uzun süren)_ |
| 0x43 | `set_position` | Konumu sıfırla | Yeni konum (f32, rot, -100000 … 100000) | Ölçülen konumu verilen değere (varsayılan 0) ayarlar. |

### Modele özgü hatalar

| Bit | Anahtar | Ad |
|---|---|---|
| 10 | `motor_disconnected` | Motor bağlantısı yok |
| 11 | `sensor_lost` | Sensör kaybı |
| 12 | `locked_rotor` | Kilitli rotor |
| 13 | `remote_sensor_lost` | Uzak sensör kayıp |

### Öz-test bitleri

| Bit | Anahtar | Ad |
|---|---|---|
| 0 | `gate_driver` | Kapı sürücüsü |
| 1 | `current_sense` | Akım ölçümü |
| 2 | `voltage_sense` | Gerilim ölçümü |
| 3 | `temp_sensor` | Sıcaklık sensörü |
| 4 | `hall_sensors` | Hall sensörleri |
| 5 | `param_storage` | Ayar belleği |

### Tuner döngüleri

| Döngü | Kip | Birim | Kazançlar | Hedef / ölçüm / çıkış / hata |
|---|---|---|---|---|
| Akım döngüsü | CTRL/0 kip 2 | A | kp=`current.kp` ki=`current.ki` | `setpoint` / `phase.current` / `loop.output` / `error` |
| Hız döngüsü | CTRL/0 kip 3 | rpm | kp=`vel.kp` ki=`vel.ki` kd=`vel.kd` kS=`vel.ks` kV=`vel.kv` kA=`vel.ka` iMax=`vel.i_max` outMax=`vel.out_max` | `setpoint` / `velocity` / `loop.output` / `error` |
| Konum döngüsü | CTRL/0 kip 4 | rot | kp=`pos.kp` ki=`pos.ki` kd=`pos.kd` iMax=`pos.i_max` | `setpoint` / `position` / `loop.output` / `error` |

## 3 · Cyncoder

Manyetik mutlak kodlayıcı; mutlak ve çok turlu konum, hız ve mıknatıs durumu bildirir.

DEVTYPE **7** · anahtar `cyncoder` · katalog sürümü 1 · akış en küçük periyodu 1000 µs

### Parametreler

| pid | Anahtar | Ad | Tip | Birim | Aralık | Varsayılan | Grup | Bayraklar | Açıklama |
|---|---|---|---|---|---|---|---|---|---|
| 0x0100 | `enc.zero_offset_rot` | Sıfır ofseti | f32 | rot | 0 … 1 | 0 | Kodlayıcı |  | Ham mutlak açıdan çıkarılan değer; "Buradan sıfırla" eylemi doldurur. |
| 0x0101 | `enc.invert` | Yönü ters çevir | bool |  |  | kapalı | Kodlayıcı |  | Saat yönünde dönüşün pozitif sayılmasını sağlar. |
| 0x0102 | `enc.abs_range` | Mutlak aralık | enum |  |  | 0 … 1 tur | Kodlayıcı |  | Mutlak konumun 0..1 tur mu yoksa −0,5..+0,5 tur mu bildirileceği. Seçenekler: 0 0 … 1 tur · 1 −0,5 … +0,5 tur. |
| 0x0103 | `enc.ratio` | Sensör:mekanizma oranı | f32 |  | 0.001 … 1000 | 1 | Kodlayıcı |  | Sensörün bir mekanizma turu için attığı tur; çok turlu konum ve hız mekanizma turu olarak verilir. |
| 0x0104 | `enc.vel_window_ms` | Hız filtresi penceresi | u32 | ms | 1 … 100 | 10 | Kodlayıcı |  | Hızın hesaplandığı zaman penceresi; uzun pencere daha düzgün ama daha gecikmeli sonuç verir. |
| 0x0105 | `enc.boot_position` | Açılışta konum | enum |  |  | Mutlak açıdan | Kodlayıcı |  | Açılışta çok turlu konumun mutlak açıdan mı başlayacağı yoksa sıfırdan mı. Seçenekler: 0 Mutlak açıdan · 1 Sıfırdan. |
| 0x0120 | `mag.hysteresis` | Açı histerezisi | enum |  |  | Kapalı | Mıknatıs ve sensör | gelişmiş | Duran mıknatısta çıkışın titremesini önleyen histerezis (en düşük anlamlı bit). Seçenekler: 0 Kapalı · 1 1 LSB · 2 2 LSB · 3 3 LSB. |
| 0x0121 | `mag.slow_filter` | Sensör yavaş filtresi | enum |  |  | 4× | Mıknatıs ve sensör | gelişmiş | Sensör içindeki ortalama filtresi; yüksek değer daha az gürültü, daha fazla gecikme. Seçenekler: 0 16× · 1 8× · 2 4× · 3 2×. |
| 0x0122 | `mag.fast_threshold` | Hızlı filtre eşiği | u32 |  | 0 … 7 | 0 | Mıknatıs ve sensör | gelişmiş | Hızlı dönüşte yavaş filtrenin devreden çıkacağı eşik; 0 hızlı filtreyi kapatır. |
| 0x0123 | `mag.agc_strong` | "Çok güçlü" eşiği (AGC) | u32 |  | 0 … 255 | 20 | Mıknatıs ve sensör | gelişmiş | Kazanç (AGC) bu değerin altına inerse mıknatıs çok yakın sayılır. |
| 0x0124 | `mag.agc_weak` | "Zayıf" eşiği (AGC) | u32 |  | 0 … 255 | 220 | Mıknatıs ve sensör | gelişmiş | Kazanç (AGC) bu değerin üstüne çıkarsa mıknatıs zayıf veya uzak sayılır. |
| 0x0001 | `can.data_bitrate` | FD veri hızı | enum |  |  | 2 Mbit/s | CAN hattı | yeniden başlatma | CAN-FD veri evresinin hızı; Klasik seçilirse kart FD çerçevesi göndermez (roboRIO ve MCP2515 hatları için). Seçenekler: 0 Klasik (FD yok) · 1 2 Mbit/s · 2 5 Mbit/s · 3 8 Mbit/s. |
| 0x0002 | `can.termination` | Hat sonlandırma (120 Ω) | bool |  |  | kapalı | CAN hattı | salt-okunur | Bu kartta anahtarlanabilir sonlandırma yok; değer her zaman kapalıdır. |
| 0x0010 | `status.0.period_ms` | Durum 0 periyodu · Konum ve hız | u32 | ms | 0 … 60000 (0 = kapalı, en az 5) | 10 | Durum çerçeveleri |  | Konum ve hız çerçevesinin gönderim aralığı; 0 çerçeveyi kapatır, en az 5 ms. |
| 0x0011 | `status.1.period_ms` | Durum 1 periyodu · Mutlak ve mıknatıs | u32 | ms | 0 … 60000 (0 = kapalı, en az 5) | 20 | Durum çerçeveleri |  | Mutlak ve mıknatıs çerçevesinin gönderim aralığı; 0 çerçeveyi kapatır, en az 5 ms. |

### Sinyaller

| sid | Anahtar | Ad | Birim | Gösterim aralığı | Basamak | Değerler |
|---|---|---|---|---|---|---|
| 1 | `abs.position` | Mutlak konum | rot | -0.5 … 1 | 4 |  |
| 2 | `position` | Çok turlu konum | rot | -10 … 10 | 4 |  |
| 3 | `velocity` | Hız | rpm | -6000 … 6000 | 1 |  |
| 4 | `magnet.agc` | Mıknatıs alan şiddeti (AGC) |  | 0 … 255 | 0 |  |
| 5 | `magnet.status` | Mıknatıs durumu |  | 0 … 3 | 0 | 0 İyi · 1 Zayıf · 2 Çok güçlü · 3 Yok |
| 6 | `raw.angle` | Ham açı |  | 0 … 4095 | 0 |  |
| 7 | `temp` | Kart sıcaklığı | °C | 0 … 100 | 0 |  |

### Durum çerçeveleri

**STATUS/0 · Konum ve hız** — varsayılan periyot 10 ms (`status.0.period_ms`)

| Bayt | Bit | Tip | Sinyal | Ölçek | Sapma | Birim |
|---|---|---|---|---|---|---|
| 0 |  | f32 | `position` |  |  | rot |
| 4 |  | f32 | `velocity` |  |  | rpm |

**STATUS/1 · Mutlak ve mıknatıs** — varsayılan periyot 20 ms (`status.1.period_ms`)

| Bayt | Bit | Tip | Sinyal | Ölçek | Sapma | Birim |
|---|---|---|---|---|---|---|
| 0 |  | f32 | `abs.position` |  |  | rot |
| 4 | 0..11 | u16 | `raw.angle` | 1 |  |  |
| 4 | 12..13 | u16 | `magnet.status` | 1 |  |  |
| 6 |  | u8 | `magnet.agc` | 1 |  |  |
| 7 |  | i8 | `temp` | 1 |  | °C |

### Kontrol çerçeveleri

_Yok (eyleyici değil)._

### Eylemler

| Komut | Anahtar | Ad | Argüman | Açıklama |
|---|---|---|---|---|
| 0x40 | `zero_here` | Buradan sıfırla |  | Şu anki mutlak açıyı sıfır ofseti olarak yazar; kalıcı olması için kaydedin. |
| 0x41 | `reset_turns` | Çok turlu sayacı sıfırla |  | Çok turlu konumu mutlak açıya geri çeker; tur sayısı sıfırlanır. |

### Modele özgü hatalar

| Bit | Anahtar | Ad |
|---|---|---|
| 10 | `magnet_missing` | Mıknatıs yok |
| 11 | `magnet_weak` | Mıknatıs zayıf |
| 12 | `magnet_strong` | Mıknatıs çok güçlü |

### Öz-test bitleri

| Bit | Anahtar | Ad |
|---|---|---|
| 0 | `sensor_comm` | Sensör iletişimi |
| 1 | `magnet` | Mıknatıs |
| 2 | `param_storage` | Ayar belleği |

## 4 · CAN jiroskop

Sensör füzyonlu ataletsel ölçüm birimi; yaw, pitch, roll, açısal hız ve ivme bildirir.

DEVTYPE **4** · anahtar `gyro` · katalog sürümü 1 · akış en küçük periyodu 1000 µs

### Parametreler

| pid | Anahtar | Ad | Tip | Birim | Aralık | Varsayılan | Grup | Bayraklar | Açıklama |
|---|---|---|---|---|---|---|---|---|---|
| 0x0100 | `mount.yaw_deg` | Montaj · Yaw ofseti | f32 | ° | -180 … 180 | 0 | Montaj |  | Kartın robota göre yaw yönündeki dönüklüğü. |
| 0x0101 | `mount.pitch_deg` | Montaj · Pitch ofseti | f32 | ° | -180 … 180 | 0 | Montaj |  | Kartın robota göre pitch yönündeki eğikliği; "Seviyeyi sıfırla" doldurur. |
| 0x0102 | `mount.roll_deg` | Montaj · Roll ofseti | f32 | ° | -180 … 180 | 0 | Montaj |  | Kartın robota göre roll yönündeki eğikliği; "Seviyeyi sıfırla" doldurur. |
| 0x0110 | `fusion.mode` | Füzyon kipi | enum |  |  | 6 eksen | Füzyon ve kalibrasyon |  | 6 eksen yalnızca jiroskop ve ivmeölçeri, 9 eksen ayrıca manyetometreyi kullanır. Seçenekler: 0 6 eksen · 1 9 eksen (pusulalı). |
| 0x0111 | `fusion.cal_on_boot` | Açılışta sapma kalibrasyonu | bool |  |  | açık | Füzyon ve kalibrasyon |  | Açılışta kart hareketsizken jiroskop sapmasını otomatik ölçer. |
| 0x0112 | `fusion.cal_time_s` | Kalibrasyon süresi | f32 | s | 1 … 30 | 4 | Füzyon ve kalibrasyon |  | Sapma kalibrasyonunun sürdüğü zaman; uzun süre daha az kayma demektir. |
| 0x0113 | `fusion.motion_dps` | Hareket algılama eşiği | f32 | dps | 0.1 … 20 | 2 | Füzyon ve kalibrasyon | gelişmiş | Kalibrasyon sırasında bu açısal hız aşılırsa kalibrasyon iptal edilir. |
| 0x0114 | `fusion.yaw_invert` | Yaw yönünü çevir | bool |  |  | kapalı | Füzyon ve kalibrasyon |  | Saat yönünde dönüşün pozitif yaw sayılmasını sağlar. |
| 0x0115 | `fusion.yaw_wrap` | Yaw biçimi | enum |  |  | Sürekli | Füzyon ve kalibrasyon |  | Yaw sürekli birikir mi yoksa −180..+180 aralığına mı sarılır. Seçenekler: 0 Sürekli · 1 −180 … +180. |
| 0x0120 | `imu.gyro_range` | Jiroskop aralığı | enum |  |  | ±2000 dps | Sensör | yeniden başlatma | Ölçülebilecek en yüksek açısal hız; küçük aralık daha hassastır. Seçenekler: 250 ±250 dps · 500 ±500 dps · 1000 ±1000 dps · 2000 ±2000 dps. |
| 0x0121 | `imu.accel_range` | İvmeölçer aralığı | enum |  |  | ±8 g | Sensör | yeniden başlatma | Ölçülebilecek en yüksek ivme; çarpışmalar için geniş aralık seçin. Seçenekler: 2 ±2 g · 4 ±4 g · 8 ±8 g · 16 ±16 g. |
| 0x0122 | `imu.lpf_hz` | Alçak geçiren filtre | enum |  |  | 92 Hz | Sensör |  | Ham sensör verisine uygulanan filtrenin kesim frekansı. Seçenekler: 10 10 Hz · 20 20 Hz · 41 41 Hz · 92 92 Hz · 184 184 Hz. |
| 0x0001 | `can.data_bitrate` | FD veri hızı | enum |  |  | 2 Mbit/s | CAN hattı | yeniden başlatma | CAN-FD veri evresinin hızı; Klasik seçilirse kart FD çerçevesi göndermez (roboRIO ve MCP2515 hatları için). Seçenekler: 0 Klasik (FD yok) · 1 2 Mbit/s · 2 5 Mbit/s · 3 8 Mbit/s. |
| 0x0002 | `can.termination` | Hat sonlandırma (120 Ω) | bool |  |  | kapalı | CAN hattı | salt-okunur | Bu kartta anahtarlanabilir sonlandırma yok; değer her zaman kapalıdır. |
| 0x0010 | `status.0.period_ms` | Durum 0 periyodu · Yönelim | u32 | ms | 0 … 60000 (0 = kapalı, en az 5) | 10 | Durum çerçeveleri |  | Yönelim çerçevesinin gönderim aralığı; 0 çerçeveyi kapatır, en az 5 ms. |
| 0x0011 | `status.1.period_ms` | Durum 1 periyodu · Açısal hız | u32 | ms | 0 … 60000 (0 = kapalı, en az 5) | 10 | Durum çerçeveleri |  | Açısal hız çerçevesinin gönderim aralığı; 0 çerçeveyi kapatır, en az 5 ms. |
| 0x0012 | `status.2.period_ms` | Durum 2 periyodu · İvme | u32 | ms | 0 … 60000 (0 = kapalı, en az 5) | 20 | Durum çerçeveleri |  | İvme çerçevesinin gönderim aralığı; 0 çerçeveyi kapatır, en az 5 ms. |
| 0x0013 | `status.3.period_ms` | Durum 3 periyodu · Kuaterniyon | u32 | ms | 0 … 60000 (0 = kapalı, en az 5) | 20 | Durum çerçeveleri |  | Kuaterniyon çerçevesinin gönderim aralığı; 0 çerçeveyi kapatır, en az 5 ms. |

### Sinyaller

| sid | Anahtar | Ad | Birim | Gösterim aralığı | Basamak | Değerler |
|---|---|---|---|---|---|---|
| 1 | `yaw` | Yaw | ° | -180 … 180 | 2 |  |
| 2 | `pitch` | Pitch | ° | -90 … 90 | 2 |  |
| 3 | `roll` | Roll | ° | -180 … 180 | 2 |  |
| 4 | `gyro.x` | Açısal hız X | dps | -2000 … 2000 | 1 |  |
| 5 | `gyro.y` | Açısal hız Y | dps | -2000 … 2000 | 1 |  |
| 6 | `gyro.z` | Açısal hız Z | dps | -2000 … 2000 | 1 |  |
| 7 | `accel.x` | İvme X | g | -16 … 16 | 3 |  |
| 8 | `accel.y` | İvme Y | g | -16 … 16 | 3 |  |
| 9 | `accel.z` | İvme Z | g | -16 … 16 | 3 |  |
| 10 | `quat.w` | Kuaterniyon w |  | -1 … 1 | 4 |  |
| 11 | `quat.x` | Kuaterniyon x |  | -1 … 1 | 4 |  |
| 12 | `quat.y` | Kuaterniyon y |  | -1 … 1 | 4 |  |
| 13 | `quat.z` | Kuaterniyon z |  | -1 … 1 | 4 |  |
| 14 | `temp` | Sıcaklık | °C | 0 … 85 | 0 |  |
| 15 | `cal.status` | Kalibrasyon durumu |  | 0 … 3 | 0 | 0 Kalibre edilmedi · 1 Kalibre ediliyor · 2 Kalibre · 3 Hareket nedeniyle başarısız |

### Durum çerçeveleri

**STATUS/0 · Yönelim** — varsayılan periyot 10 ms (`status.0.period_ms`)

| Bayt | Bit | Tip | Sinyal | Ölçek | Sapma | Birim |
|---|---|---|---|---|---|---|
| 0 |  | f32 | `yaw` |  |  | ° |
| 4 |  | i16 | `pitch` | 0.01 |  | ° |
| 6 |  | i16 | `roll` | 0.01 |  | ° |

**STATUS/1 · Açısal hız** — varsayılan periyot 10 ms (`status.1.period_ms`)

| Bayt | Bit | Tip | Sinyal | Ölçek | Sapma | Birim |
|---|---|---|---|---|---|---|
| 0 |  | i16 | `gyro.x` | 0.1 |  | dps |
| 2 |  | i16 | `gyro.y` | 0.1 |  | dps |
| 4 |  | i16 | `gyro.z` | 0.1 |  | dps |
| 6 | 0..1 | u8 | `cal.status` | 1 |  |  |
| 7 |  | i8 | `temp` | 1 |  | °C |

**STATUS/2 · İvme** — varsayılan periyot 20 ms (`status.2.period_ms`)

| Bayt | Bit | Tip | Sinyal | Ölçek | Sapma | Birim |
|---|---|---|---|---|---|---|
| 0 |  | i16 | `accel.x` | 0.001 |  | g |
| 2 |  | i16 | `accel.y` | 0.001 |  | g |
| 4 |  | i16 | `accel.z` | 0.001 |  | g |

**STATUS/3 · Kuaterniyon** — varsayılan periyot 20 ms (`status.3.period_ms`)

| Bayt | Bit | Tip | Sinyal | Ölçek | Sapma | Birim |
|---|---|---|---|---|---|---|
| 0 |  | i16 | `quat.w` | 0.00006103516 |  |  |
| 2 |  | i16 | `quat.x` | 0.00006103516 |  |  |
| 4 |  | i16 | `quat.y` | 0.00006103516 |  |  |
| 6 |  | i16 | `quat.z` | 0.00006103516 |  |  |

### Kontrol çerçeveleri

_Yok (eyleyici değil)._

### Eylemler

| Komut | Anahtar | Ad | Argüman | Açıklama |
|---|---|---|---|---|
| 0x40 | `calibrate` | Sapmayı kalibre et |  | Kartı tamamen hareketsiz tutun; jiroskop sapması ölçülür. _(uzun süren)_ |
| 0x41 | `set_yaw` | Yaw'ı sıfırla | Yeni yaw (f32, °, -360 … 360) | Yaw'ı verilen değere (varsayılan 0) ayarlar. |
| 0x42 | `level_here` | Seviyeyi sıfırla |  | Şu anki pitch ve roll değerlerini montaj ofsetine yazar; robot düz zeminde olmalı. _(onay ister)_ |

### Modele özgü hatalar

| Bit | Anahtar | Ad |
|---|---|---|
| 10 | `cal_motion` | Kalibrasyon sırasında hareket |
| 11 | `saturation` | Sensör doygunluğu |

### Öz-test bitleri

| Bit | Anahtar | Ad |
|---|---|---|
| 0 | `gyro` | Jiroskop |
| 1 | `accel` | İvmeölçer |
| 2 | `magnetometer` | Manyetometre |
| 3 | `param_storage` | Ayar belleği |

## 5 · CAN servo kontrol, 16 kanal

16 kanallı servo darbe üreteci; kanal başına sınırlar, güvenli konum ve hız sınırı.

DEVTYPE **12** · anahtar `servo16` · katalog sürümü 1 · akış en küçük periyodu 1000 µs

### Parametreler

| pid | Anahtar | Ad | Tip | Birim | Aralık | Varsayılan | Grup | Bayraklar | Açıklama |
|---|---|---|---|---|---|---|---|---|---|
| 0x0100 | `servo.pwm_hz` | PWM frekansı | u32 | Hz | 50 … 333 | 50 | Genel | sürerken kilitli | Tüm kanalların darbe tekrarlama frekansı; analog servolar için 50 Hz kullanın. |
| 0x0101 | `servo.rail_uv_warn_v` | Servo rayı düşük gerilim uyarısı | f32 | V | 3 … 12 | 4.5 | Genel |  | Servo besleme rayı bu gerilimin altına inerse uyarı verilir. |
| 0x0200 | `ch.1.enable` | Kanal 1 · Etkin | bool |  |  | açık | Kanallar |  | Kapalı kanal darbe üretmez. |
| 0x0201 | `ch.1.min_us` | Kanal 1 · En küçük darbe | u32 | µs | 400 … 2600 | 1000 | Kanallar |  | Çıkışın inebileceği en kısa darbe; servonun mekanik sınırını korur. |
| 0x0202 | `ch.1.center_us` | Kanal 1 · Orta darbe | u32 | µs | 400 … 2600 | 1500 | Kanallar |  | "Tüm kanalları ortala" eyleminde ve ters çevirmede kullanılan orta nokta. |
| 0x0203 | `ch.1.max_us` | Kanal 1 · En büyük darbe | u32 | µs | 400 … 2600 | 2000 | Kanallar |  | Çıkışın çıkabileceği en uzun darbe; servonun mekanik sınırını korur. |
| 0x0204 | `ch.1.failsafe_us` | Kanal 1 · Güvenli darbe | u32 | µs | 0 … 2600 (0 = kapalı, en az 400) | 0 | Kanallar |  | Komut zaman aşımında uygulanacak darbe; 0 çıkışı kapatır. |
| 0x0205 | `ch.1.invert` | Kanal 1 · Ters çevir | bool |  |  | kapalı | Kanallar |  | Komutu orta darbeye göre aynalar. |
| 0x0206 | `ch.1.speed_us_s` | Kanal 1 · Hız sınırı | u32 | µs/s | 0 … 100000 | 0 | Kanallar | gelişmiş | Darbenin saniyede en çok ne kadar değişebileceği; 0 sınırsız. |
| 0x0210 | `ch.2.enable` | Kanal 2 · Etkin | bool |  |  | açık | Kanallar |  | Kapalı kanal darbe üretmez. |
| 0x0211 | `ch.2.min_us` | Kanal 2 · En küçük darbe | u32 | µs | 400 … 2600 | 1000 | Kanallar |  | Çıkışın inebileceği en kısa darbe; servonun mekanik sınırını korur. |
| 0x0212 | `ch.2.center_us` | Kanal 2 · Orta darbe | u32 | µs | 400 … 2600 | 1500 | Kanallar |  | "Tüm kanalları ortala" eyleminde ve ters çevirmede kullanılan orta nokta. |
| 0x0213 | `ch.2.max_us` | Kanal 2 · En büyük darbe | u32 | µs | 400 … 2600 | 2000 | Kanallar |  | Çıkışın çıkabileceği en uzun darbe; servonun mekanik sınırını korur. |
| 0x0214 | `ch.2.failsafe_us` | Kanal 2 · Güvenli darbe | u32 | µs | 0 … 2600 (0 = kapalı, en az 400) | 0 | Kanallar |  | Komut zaman aşımında uygulanacak darbe; 0 çıkışı kapatır. |
| 0x0215 | `ch.2.invert` | Kanal 2 · Ters çevir | bool |  |  | kapalı | Kanallar |  | Komutu orta darbeye göre aynalar. |
| 0x0216 | `ch.2.speed_us_s` | Kanal 2 · Hız sınırı | u32 | µs/s | 0 … 100000 | 0 | Kanallar | gelişmiş | Darbenin saniyede en çok ne kadar değişebileceği; 0 sınırsız. |
| 0x0220 | `ch.3.enable` | Kanal 3 · Etkin | bool |  |  | açık | Kanallar |  | Kapalı kanal darbe üretmez. |
| 0x0221 | `ch.3.min_us` | Kanal 3 · En küçük darbe | u32 | µs | 400 … 2600 | 1000 | Kanallar |  | Çıkışın inebileceği en kısa darbe; servonun mekanik sınırını korur. |
| 0x0222 | `ch.3.center_us` | Kanal 3 · Orta darbe | u32 | µs | 400 … 2600 | 1500 | Kanallar |  | "Tüm kanalları ortala" eyleminde ve ters çevirmede kullanılan orta nokta. |
| 0x0223 | `ch.3.max_us` | Kanal 3 · En büyük darbe | u32 | µs | 400 … 2600 | 2000 | Kanallar |  | Çıkışın çıkabileceği en uzun darbe; servonun mekanik sınırını korur. |
| 0x0224 | `ch.3.failsafe_us` | Kanal 3 · Güvenli darbe | u32 | µs | 0 … 2600 (0 = kapalı, en az 400) | 0 | Kanallar |  | Komut zaman aşımında uygulanacak darbe; 0 çıkışı kapatır. |
| 0x0225 | `ch.3.invert` | Kanal 3 · Ters çevir | bool |  |  | kapalı | Kanallar |  | Komutu orta darbeye göre aynalar. |
| 0x0226 | `ch.3.speed_us_s` | Kanal 3 · Hız sınırı | u32 | µs/s | 0 … 100000 | 0 | Kanallar | gelişmiş | Darbenin saniyede en çok ne kadar değişebileceği; 0 sınırsız. |
| 0x0230 | `ch.4.enable` | Kanal 4 · Etkin | bool |  |  | açık | Kanallar |  | Kapalı kanal darbe üretmez. |
| 0x0231 | `ch.4.min_us` | Kanal 4 · En küçük darbe | u32 | µs | 400 … 2600 | 1000 | Kanallar |  | Çıkışın inebileceği en kısa darbe; servonun mekanik sınırını korur. |
| 0x0232 | `ch.4.center_us` | Kanal 4 · Orta darbe | u32 | µs | 400 … 2600 | 1500 | Kanallar |  | "Tüm kanalları ortala" eyleminde ve ters çevirmede kullanılan orta nokta. |
| 0x0233 | `ch.4.max_us` | Kanal 4 · En büyük darbe | u32 | µs | 400 … 2600 | 2000 | Kanallar |  | Çıkışın çıkabileceği en uzun darbe; servonun mekanik sınırını korur. |
| 0x0234 | `ch.4.failsafe_us` | Kanal 4 · Güvenli darbe | u32 | µs | 0 … 2600 (0 = kapalı, en az 400) | 0 | Kanallar |  | Komut zaman aşımında uygulanacak darbe; 0 çıkışı kapatır. |
| 0x0235 | `ch.4.invert` | Kanal 4 · Ters çevir | bool |  |  | kapalı | Kanallar |  | Komutu orta darbeye göre aynalar. |
| 0x0236 | `ch.4.speed_us_s` | Kanal 4 · Hız sınırı | u32 | µs/s | 0 … 100000 | 0 | Kanallar | gelişmiş | Darbenin saniyede en çok ne kadar değişebileceği; 0 sınırsız. |
| 0x0240 | `ch.5.enable` | Kanal 5 · Etkin | bool |  |  | açık | Kanallar |  | Kapalı kanal darbe üretmez. |
| 0x0241 | `ch.5.min_us` | Kanal 5 · En küçük darbe | u32 | µs | 400 … 2600 | 1000 | Kanallar |  | Çıkışın inebileceği en kısa darbe; servonun mekanik sınırını korur. |
| 0x0242 | `ch.5.center_us` | Kanal 5 · Orta darbe | u32 | µs | 400 … 2600 | 1500 | Kanallar |  | "Tüm kanalları ortala" eyleminde ve ters çevirmede kullanılan orta nokta. |
| 0x0243 | `ch.5.max_us` | Kanal 5 · En büyük darbe | u32 | µs | 400 … 2600 | 2000 | Kanallar |  | Çıkışın çıkabileceği en uzun darbe; servonun mekanik sınırını korur. |
| 0x0244 | `ch.5.failsafe_us` | Kanal 5 · Güvenli darbe | u32 | µs | 0 … 2600 (0 = kapalı, en az 400) | 0 | Kanallar |  | Komut zaman aşımında uygulanacak darbe; 0 çıkışı kapatır. |
| 0x0245 | `ch.5.invert` | Kanal 5 · Ters çevir | bool |  |  | kapalı | Kanallar |  | Komutu orta darbeye göre aynalar. |
| 0x0246 | `ch.5.speed_us_s` | Kanal 5 · Hız sınırı | u32 | µs/s | 0 … 100000 | 0 | Kanallar | gelişmiş | Darbenin saniyede en çok ne kadar değişebileceği; 0 sınırsız. |
| 0x0250 | `ch.6.enable` | Kanal 6 · Etkin | bool |  |  | açık | Kanallar |  | Kapalı kanal darbe üretmez. |
| 0x0251 | `ch.6.min_us` | Kanal 6 · En küçük darbe | u32 | µs | 400 … 2600 | 1000 | Kanallar |  | Çıkışın inebileceği en kısa darbe; servonun mekanik sınırını korur. |
| 0x0252 | `ch.6.center_us` | Kanal 6 · Orta darbe | u32 | µs | 400 … 2600 | 1500 | Kanallar |  | "Tüm kanalları ortala" eyleminde ve ters çevirmede kullanılan orta nokta. |
| 0x0253 | `ch.6.max_us` | Kanal 6 · En büyük darbe | u32 | µs | 400 … 2600 | 2000 | Kanallar |  | Çıkışın çıkabileceği en uzun darbe; servonun mekanik sınırını korur. |
| 0x0254 | `ch.6.failsafe_us` | Kanal 6 · Güvenli darbe | u32 | µs | 0 … 2600 (0 = kapalı, en az 400) | 0 | Kanallar |  | Komut zaman aşımında uygulanacak darbe; 0 çıkışı kapatır. |
| 0x0255 | `ch.6.invert` | Kanal 6 · Ters çevir | bool |  |  | kapalı | Kanallar |  | Komutu orta darbeye göre aynalar. |
| 0x0256 | `ch.6.speed_us_s` | Kanal 6 · Hız sınırı | u32 | µs/s | 0 … 100000 | 0 | Kanallar | gelişmiş | Darbenin saniyede en çok ne kadar değişebileceği; 0 sınırsız. |
| 0x0260 | `ch.7.enable` | Kanal 7 · Etkin | bool |  |  | açık | Kanallar |  | Kapalı kanal darbe üretmez. |
| 0x0261 | `ch.7.min_us` | Kanal 7 · En küçük darbe | u32 | µs | 400 … 2600 | 1000 | Kanallar |  | Çıkışın inebileceği en kısa darbe; servonun mekanik sınırını korur. |
| 0x0262 | `ch.7.center_us` | Kanal 7 · Orta darbe | u32 | µs | 400 … 2600 | 1500 | Kanallar |  | "Tüm kanalları ortala" eyleminde ve ters çevirmede kullanılan orta nokta. |
| 0x0263 | `ch.7.max_us` | Kanal 7 · En büyük darbe | u32 | µs | 400 … 2600 | 2000 | Kanallar |  | Çıkışın çıkabileceği en uzun darbe; servonun mekanik sınırını korur. |
| 0x0264 | `ch.7.failsafe_us` | Kanal 7 · Güvenli darbe | u32 | µs | 0 … 2600 (0 = kapalı, en az 400) | 0 | Kanallar |  | Komut zaman aşımında uygulanacak darbe; 0 çıkışı kapatır. |
| 0x0265 | `ch.7.invert` | Kanal 7 · Ters çevir | bool |  |  | kapalı | Kanallar |  | Komutu orta darbeye göre aynalar. |
| 0x0266 | `ch.7.speed_us_s` | Kanal 7 · Hız sınırı | u32 | µs/s | 0 … 100000 | 0 | Kanallar | gelişmiş | Darbenin saniyede en çok ne kadar değişebileceği; 0 sınırsız. |
| 0x0270 | `ch.8.enable` | Kanal 8 · Etkin | bool |  |  | açık | Kanallar |  | Kapalı kanal darbe üretmez. |
| 0x0271 | `ch.8.min_us` | Kanal 8 · En küçük darbe | u32 | µs | 400 … 2600 | 1000 | Kanallar |  | Çıkışın inebileceği en kısa darbe; servonun mekanik sınırını korur. |
| 0x0272 | `ch.8.center_us` | Kanal 8 · Orta darbe | u32 | µs | 400 … 2600 | 1500 | Kanallar |  | "Tüm kanalları ortala" eyleminde ve ters çevirmede kullanılan orta nokta. |
| 0x0273 | `ch.8.max_us` | Kanal 8 · En büyük darbe | u32 | µs | 400 … 2600 | 2000 | Kanallar |  | Çıkışın çıkabileceği en uzun darbe; servonun mekanik sınırını korur. |
| 0x0274 | `ch.8.failsafe_us` | Kanal 8 · Güvenli darbe | u32 | µs | 0 … 2600 (0 = kapalı, en az 400) | 0 | Kanallar |  | Komut zaman aşımında uygulanacak darbe; 0 çıkışı kapatır. |
| 0x0275 | `ch.8.invert` | Kanal 8 · Ters çevir | bool |  |  | kapalı | Kanallar |  | Komutu orta darbeye göre aynalar. |
| 0x0276 | `ch.8.speed_us_s` | Kanal 8 · Hız sınırı | u32 | µs/s | 0 … 100000 | 0 | Kanallar | gelişmiş | Darbenin saniyede en çok ne kadar değişebileceği; 0 sınırsız. |
| 0x0280 | `ch.9.enable` | Kanal 9 · Etkin | bool |  |  | açık | Kanallar |  | Kapalı kanal darbe üretmez. |
| 0x0281 | `ch.9.min_us` | Kanal 9 · En küçük darbe | u32 | µs | 400 … 2600 | 1000 | Kanallar |  | Çıkışın inebileceği en kısa darbe; servonun mekanik sınırını korur. |
| 0x0282 | `ch.9.center_us` | Kanal 9 · Orta darbe | u32 | µs | 400 … 2600 | 1500 | Kanallar |  | "Tüm kanalları ortala" eyleminde ve ters çevirmede kullanılan orta nokta. |
| 0x0283 | `ch.9.max_us` | Kanal 9 · En büyük darbe | u32 | µs | 400 … 2600 | 2000 | Kanallar |  | Çıkışın çıkabileceği en uzun darbe; servonun mekanik sınırını korur. |
| 0x0284 | `ch.9.failsafe_us` | Kanal 9 · Güvenli darbe | u32 | µs | 0 … 2600 (0 = kapalı, en az 400) | 0 | Kanallar |  | Komut zaman aşımında uygulanacak darbe; 0 çıkışı kapatır. |
| 0x0285 | `ch.9.invert` | Kanal 9 · Ters çevir | bool |  |  | kapalı | Kanallar |  | Komutu orta darbeye göre aynalar. |
| 0x0286 | `ch.9.speed_us_s` | Kanal 9 · Hız sınırı | u32 | µs/s | 0 … 100000 | 0 | Kanallar | gelişmiş | Darbenin saniyede en çok ne kadar değişebileceği; 0 sınırsız. |
| 0x0290 | `ch.10.enable` | Kanal 10 · Etkin | bool |  |  | açık | Kanallar |  | Kapalı kanal darbe üretmez. |
| 0x0291 | `ch.10.min_us` | Kanal 10 · En küçük darbe | u32 | µs | 400 … 2600 | 1000 | Kanallar |  | Çıkışın inebileceği en kısa darbe; servonun mekanik sınırını korur. |
| 0x0292 | `ch.10.center_us` | Kanal 10 · Orta darbe | u32 | µs | 400 … 2600 | 1500 | Kanallar |  | "Tüm kanalları ortala" eyleminde ve ters çevirmede kullanılan orta nokta. |
| 0x0293 | `ch.10.max_us` | Kanal 10 · En büyük darbe | u32 | µs | 400 … 2600 | 2000 | Kanallar |  | Çıkışın çıkabileceği en uzun darbe; servonun mekanik sınırını korur. |
| 0x0294 | `ch.10.failsafe_us` | Kanal 10 · Güvenli darbe | u32 | µs | 0 … 2600 (0 = kapalı, en az 400) | 0 | Kanallar |  | Komut zaman aşımında uygulanacak darbe; 0 çıkışı kapatır. |
| 0x0295 | `ch.10.invert` | Kanal 10 · Ters çevir | bool |  |  | kapalı | Kanallar |  | Komutu orta darbeye göre aynalar. |
| 0x0296 | `ch.10.speed_us_s` | Kanal 10 · Hız sınırı | u32 | µs/s | 0 … 100000 | 0 | Kanallar | gelişmiş | Darbenin saniyede en çok ne kadar değişebileceği; 0 sınırsız. |
| 0x02A0 | `ch.11.enable` | Kanal 11 · Etkin | bool |  |  | açık | Kanallar |  | Kapalı kanal darbe üretmez. |
| 0x02A1 | `ch.11.min_us` | Kanal 11 · En küçük darbe | u32 | µs | 400 … 2600 | 1000 | Kanallar |  | Çıkışın inebileceği en kısa darbe; servonun mekanik sınırını korur. |
| 0x02A2 | `ch.11.center_us` | Kanal 11 · Orta darbe | u32 | µs | 400 … 2600 | 1500 | Kanallar |  | "Tüm kanalları ortala" eyleminde ve ters çevirmede kullanılan orta nokta. |
| 0x02A3 | `ch.11.max_us` | Kanal 11 · En büyük darbe | u32 | µs | 400 … 2600 | 2000 | Kanallar |  | Çıkışın çıkabileceği en uzun darbe; servonun mekanik sınırını korur. |
| 0x02A4 | `ch.11.failsafe_us` | Kanal 11 · Güvenli darbe | u32 | µs | 0 … 2600 (0 = kapalı, en az 400) | 0 | Kanallar |  | Komut zaman aşımında uygulanacak darbe; 0 çıkışı kapatır. |
| 0x02A5 | `ch.11.invert` | Kanal 11 · Ters çevir | bool |  |  | kapalı | Kanallar |  | Komutu orta darbeye göre aynalar. |
| 0x02A6 | `ch.11.speed_us_s` | Kanal 11 · Hız sınırı | u32 | µs/s | 0 … 100000 | 0 | Kanallar | gelişmiş | Darbenin saniyede en çok ne kadar değişebileceği; 0 sınırsız. |
| 0x02B0 | `ch.12.enable` | Kanal 12 · Etkin | bool |  |  | açık | Kanallar |  | Kapalı kanal darbe üretmez. |
| 0x02B1 | `ch.12.min_us` | Kanal 12 · En küçük darbe | u32 | µs | 400 … 2600 | 1000 | Kanallar |  | Çıkışın inebileceği en kısa darbe; servonun mekanik sınırını korur. |
| 0x02B2 | `ch.12.center_us` | Kanal 12 · Orta darbe | u32 | µs | 400 … 2600 | 1500 | Kanallar |  | "Tüm kanalları ortala" eyleminde ve ters çevirmede kullanılan orta nokta. |
| 0x02B3 | `ch.12.max_us` | Kanal 12 · En büyük darbe | u32 | µs | 400 … 2600 | 2000 | Kanallar |  | Çıkışın çıkabileceği en uzun darbe; servonun mekanik sınırını korur. |
| 0x02B4 | `ch.12.failsafe_us` | Kanal 12 · Güvenli darbe | u32 | µs | 0 … 2600 (0 = kapalı, en az 400) | 0 | Kanallar |  | Komut zaman aşımında uygulanacak darbe; 0 çıkışı kapatır. |
| 0x02B5 | `ch.12.invert` | Kanal 12 · Ters çevir | bool |  |  | kapalı | Kanallar |  | Komutu orta darbeye göre aynalar. |
| 0x02B6 | `ch.12.speed_us_s` | Kanal 12 · Hız sınırı | u32 | µs/s | 0 … 100000 | 0 | Kanallar | gelişmiş | Darbenin saniyede en çok ne kadar değişebileceği; 0 sınırsız. |
| 0x02C0 | `ch.13.enable` | Kanal 13 · Etkin | bool |  |  | açık | Kanallar |  | Kapalı kanal darbe üretmez. |
| 0x02C1 | `ch.13.min_us` | Kanal 13 · En küçük darbe | u32 | µs | 400 … 2600 | 1000 | Kanallar |  | Çıkışın inebileceği en kısa darbe; servonun mekanik sınırını korur. |
| 0x02C2 | `ch.13.center_us` | Kanal 13 · Orta darbe | u32 | µs | 400 … 2600 | 1500 | Kanallar |  | "Tüm kanalları ortala" eyleminde ve ters çevirmede kullanılan orta nokta. |
| 0x02C3 | `ch.13.max_us` | Kanal 13 · En büyük darbe | u32 | µs | 400 … 2600 | 2000 | Kanallar |  | Çıkışın çıkabileceği en uzun darbe; servonun mekanik sınırını korur. |
| 0x02C4 | `ch.13.failsafe_us` | Kanal 13 · Güvenli darbe | u32 | µs | 0 … 2600 (0 = kapalı, en az 400) | 0 | Kanallar |  | Komut zaman aşımında uygulanacak darbe; 0 çıkışı kapatır. |
| 0x02C5 | `ch.13.invert` | Kanal 13 · Ters çevir | bool |  |  | kapalı | Kanallar |  | Komutu orta darbeye göre aynalar. |
| 0x02C6 | `ch.13.speed_us_s` | Kanal 13 · Hız sınırı | u32 | µs/s | 0 … 100000 | 0 | Kanallar | gelişmiş | Darbenin saniyede en çok ne kadar değişebileceği; 0 sınırsız. |
| 0x02D0 | `ch.14.enable` | Kanal 14 · Etkin | bool |  |  | açık | Kanallar |  | Kapalı kanal darbe üretmez. |
| 0x02D1 | `ch.14.min_us` | Kanal 14 · En küçük darbe | u32 | µs | 400 … 2600 | 1000 | Kanallar |  | Çıkışın inebileceği en kısa darbe; servonun mekanik sınırını korur. |
| 0x02D2 | `ch.14.center_us` | Kanal 14 · Orta darbe | u32 | µs | 400 … 2600 | 1500 | Kanallar |  | "Tüm kanalları ortala" eyleminde ve ters çevirmede kullanılan orta nokta. |
| 0x02D3 | `ch.14.max_us` | Kanal 14 · En büyük darbe | u32 | µs | 400 … 2600 | 2000 | Kanallar |  | Çıkışın çıkabileceği en uzun darbe; servonun mekanik sınırını korur. |
| 0x02D4 | `ch.14.failsafe_us` | Kanal 14 · Güvenli darbe | u32 | µs | 0 … 2600 (0 = kapalı, en az 400) | 0 | Kanallar |  | Komut zaman aşımında uygulanacak darbe; 0 çıkışı kapatır. |
| 0x02D5 | `ch.14.invert` | Kanal 14 · Ters çevir | bool |  |  | kapalı | Kanallar |  | Komutu orta darbeye göre aynalar. |
| 0x02D6 | `ch.14.speed_us_s` | Kanal 14 · Hız sınırı | u32 | µs/s | 0 … 100000 | 0 | Kanallar | gelişmiş | Darbenin saniyede en çok ne kadar değişebileceği; 0 sınırsız. |
| 0x02E0 | `ch.15.enable` | Kanal 15 · Etkin | bool |  |  | açık | Kanallar |  | Kapalı kanal darbe üretmez. |
| 0x02E1 | `ch.15.min_us` | Kanal 15 · En küçük darbe | u32 | µs | 400 … 2600 | 1000 | Kanallar |  | Çıkışın inebileceği en kısa darbe; servonun mekanik sınırını korur. |
| 0x02E2 | `ch.15.center_us` | Kanal 15 · Orta darbe | u32 | µs | 400 … 2600 | 1500 | Kanallar |  | "Tüm kanalları ortala" eyleminde ve ters çevirmede kullanılan orta nokta. |
| 0x02E3 | `ch.15.max_us` | Kanal 15 · En büyük darbe | u32 | µs | 400 … 2600 | 2000 | Kanallar |  | Çıkışın çıkabileceği en uzun darbe; servonun mekanik sınırını korur. |
| 0x02E4 | `ch.15.failsafe_us` | Kanal 15 · Güvenli darbe | u32 | µs | 0 … 2600 (0 = kapalı, en az 400) | 0 | Kanallar |  | Komut zaman aşımında uygulanacak darbe; 0 çıkışı kapatır. |
| 0x02E5 | `ch.15.invert` | Kanal 15 · Ters çevir | bool |  |  | kapalı | Kanallar |  | Komutu orta darbeye göre aynalar. |
| 0x02E6 | `ch.15.speed_us_s` | Kanal 15 · Hız sınırı | u32 | µs/s | 0 … 100000 | 0 | Kanallar | gelişmiş | Darbenin saniyede en çok ne kadar değişebileceği; 0 sınırsız. |
| 0x02F0 | `ch.16.enable` | Kanal 16 · Etkin | bool |  |  | açık | Kanallar |  | Kapalı kanal darbe üretmez. |
| 0x02F1 | `ch.16.min_us` | Kanal 16 · En küçük darbe | u32 | µs | 400 … 2600 | 1000 | Kanallar |  | Çıkışın inebileceği en kısa darbe; servonun mekanik sınırını korur. |
| 0x02F2 | `ch.16.center_us` | Kanal 16 · Orta darbe | u32 | µs | 400 … 2600 | 1500 | Kanallar |  | "Tüm kanalları ortala" eyleminde ve ters çevirmede kullanılan orta nokta. |
| 0x02F3 | `ch.16.max_us` | Kanal 16 · En büyük darbe | u32 | µs | 400 … 2600 | 2000 | Kanallar |  | Çıkışın çıkabileceği en uzun darbe; servonun mekanik sınırını korur. |
| 0x02F4 | `ch.16.failsafe_us` | Kanal 16 · Güvenli darbe | u32 | µs | 0 … 2600 (0 = kapalı, en az 400) | 0 | Kanallar |  | Komut zaman aşımında uygulanacak darbe; 0 çıkışı kapatır. |
| 0x02F5 | `ch.16.invert` | Kanal 16 · Ters çevir | bool |  |  | kapalı | Kanallar |  | Komutu orta darbeye göre aynalar. |
| 0x02F6 | `ch.16.speed_us_s` | Kanal 16 · Hız sınırı | u32 | µs/s | 0 … 100000 | 0 | Kanallar | gelişmiş | Darbenin saniyede en çok ne kadar değişebileceği; 0 sınırsız. |
| 0x0001 | `can.data_bitrate` | FD veri hızı | enum |  |  | 2 Mbit/s | CAN hattı | yeniden başlatma | CAN-FD veri evresinin hızı; Klasik seçilirse kart FD çerçevesi göndermez (roboRIO ve MCP2515 hatları için). Seçenekler: 0 Klasik (FD yok) · 1 2 Mbit/s · 2 5 Mbit/s · 3 8 Mbit/s. |
| 0x0002 | `can.termination` | Hat sonlandırma (120 Ω) | bool |  |  | kapalı | CAN hattı | salt-okunur | Bu kartta anahtarlanabilir sonlandırma yok; değer her zaman kapalıdır. |
| 0x0003 | `ctrl.timeout_ms` | Komut zaman aşımı | u32 | ms | 20 … 2000 | 200 | Kontrol |  | Bu süre içinde yeni kontrol çerçevesi gelmezse çıkış nötre döner ve uyarı verilir. |
| 0x0010 | `status.0.period_ms` | Durum 0 periyodu · Güç | u32 | ms | 0 … 60000 (0 = kapalı, en az 5) | 50 | Durum çerçeveleri |  | Güç çerçevesinin gönderim aralığı; 0 çerçeveyi kapatır, en az 5 ms. |
| 0x0011 | `status.1.period_ms` | Durum 1 periyodu · Kanal 1–4 | u32 | ms | 0 … 60000 (0 = kapalı, en az 5) | 100 | Durum çerçeveleri |  | Kanal 1–4 çerçevesinin gönderim aralığı; 0 çerçeveyi kapatır, en az 5 ms. |
| 0x0012 | `status.2.period_ms` | Durum 2 periyodu · Kanal 5–8 | u32 | ms | 0 … 60000 (0 = kapalı, en az 5) | 100 | Durum çerçeveleri |  | Kanal 5–8 çerçevesinin gönderim aralığı; 0 çerçeveyi kapatır, en az 5 ms. |
| 0x0013 | `status.3.period_ms` | Durum 3 periyodu · Kanal 9–12 | u32 | ms | 0 … 60000 (0 = kapalı, en az 5) | 100 | Durum çerçeveleri |  | Kanal 9–12 çerçevesinin gönderim aralığı; 0 çerçeveyi kapatır, en az 5 ms. |
| 0x0014 | `status.4.period_ms` | Durum 4 periyodu · Kanal 13–16 | u32 | ms | 0 … 60000 (0 = kapalı, en az 5) | 100 | Durum çerçeveleri |  | Kanal 13–16 çerçevesinin gönderim aralığı; 0 çerçeveyi kapatır, en az 5 ms. |

### Sinyaller

| sid | Anahtar | Ad | Birim | Gösterim aralığı | Basamak | Değerler |
|---|---|---|---|---|---|---|
| 1 | `rail.voltage` | Servo rayı gerilimi | V | 0 … 12 | 2 |  |
| 2 | `rail.current` | Toplam akım | A | 0 … 20 | 2 |  |
| 3 | `ch.1.pulse` | Kanal 1 darbesi | µs | 500 … 2500 | 0 |  |
| 4 | `ch.2.pulse` | Kanal 2 darbesi | µs | 500 … 2500 | 0 |  |
| 5 | `ch.3.pulse` | Kanal 3 darbesi | µs | 500 … 2500 | 0 |  |
| 6 | `ch.4.pulse` | Kanal 4 darbesi | µs | 500 … 2500 | 0 |  |
| 7 | `ch.5.pulse` | Kanal 5 darbesi | µs | 500 … 2500 | 0 |  |
| 8 | `ch.6.pulse` | Kanal 6 darbesi | µs | 500 … 2500 | 0 |  |
| 9 | `ch.7.pulse` | Kanal 7 darbesi | µs | 500 … 2500 | 0 |  |
| 10 | `ch.8.pulse` | Kanal 8 darbesi | µs | 500 … 2500 | 0 |  |
| 11 | `ch.9.pulse` | Kanal 9 darbesi | µs | 500 … 2500 | 0 |  |
| 12 | `ch.10.pulse` | Kanal 10 darbesi | µs | 500 … 2500 | 0 |  |
| 13 | `ch.11.pulse` | Kanal 11 darbesi | µs | 500 … 2500 | 0 |  |
| 14 | `ch.12.pulse` | Kanal 12 darbesi | µs | 500 … 2500 | 0 |  |
| 15 | `ch.13.pulse` | Kanal 13 darbesi | µs | 500 … 2500 | 0 |  |
| 16 | `ch.14.pulse` | Kanal 14 darbesi | µs | 500 … 2500 | 0 |  |
| 17 | `ch.15.pulse` | Kanal 15 darbesi | µs | 500 … 2500 | 0 |  |
| 18 | `ch.16.pulse` | Kanal 16 darbesi | µs | 500 … 2500 | 0 |  |
| 19 | `temp` | Kart sıcaklığı | °C | 0 … 100 | 1 |  |

### Durum çerçeveleri

**STATUS/0 · Güç** — varsayılan periyot 50 ms (`status.0.period_ms`)

| Bayt | Bit | Tip | Sinyal | Ölçek | Sapma | Birim |
|---|---|---|---|---|---|---|
| 0 |  | u16 | `rail.voltage` | 0.001 |  | V |
| 2 |  | u16 | `rail.current` | 0.001 |  | A |
| 4 |  | i16 | `temp` | 0.1 |  | °C |

**STATUS/1 · Kanal 1–4** — varsayılan periyot 100 ms (`status.1.period_ms`)

| Bayt | Bit | Tip | Sinyal | Ölçek | Sapma | Birim |
|---|---|---|---|---|---|---|
| 0 |  | u16 | `ch.1.pulse` | 1 |  | µs |
| 2 |  | u16 | `ch.2.pulse` | 1 |  | µs |
| 4 |  | u16 | `ch.3.pulse` | 1 |  | µs |
| 6 |  | u16 | `ch.4.pulse` | 1 |  | µs |

**STATUS/2 · Kanal 5–8** — varsayılan periyot 100 ms (`status.2.period_ms`)

| Bayt | Bit | Tip | Sinyal | Ölçek | Sapma | Birim |
|---|---|---|---|---|---|---|
| 0 |  | u16 | `ch.5.pulse` | 1 |  | µs |
| 2 |  | u16 | `ch.6.pulse` | 1 |  | µs |
| 4 |  | u16 | `ch.7.pulse` | 1 |  | µs |
| 6 |  | u16 | `ch.8.pulse` | 1 |  | µs |

**STATUS/3 · Kanal 9–12** — varsayılan periyot 100 ms (`status.3.period_ms`)

| Bayt | Bit | Tip | Sinyal | Ölçek | Sapma | Birim |
|---|---|---|---|---|---|---|
| 0 |  | u16 | `ch.9.pulse` | 1 |  | µs |
| 2 |  | u16 | `ch.10.pulse` | 1 |  | µs |
| 4 |  | u16 | `ch.11.pulse` | 1 |  | µs |
| 6 |  | u16 | `ch.12.pulse` | 1 |  | µs |

**STATUS/4 · Kanal 13–16** — varsayılan periyot 100 ms (`status.4.period_ms`)

| Bayt | Bit | Tip | Sinyal | Ölçek | Sapma | Birim |
|---|---|---|---|---|---|---|
| 0 |  | u16 | `ch.13.pulse` | 1 |  | µs |
| 2 |  | u16 | `ch.14.pulse` | 1 |  | µs |
| 4 |  | u16 | `ch.15.pulse` | 1 |  | µs |
| 6 |  | u16 | `ch.16.pulse` | 1 |  | µs |

### Kontrol çerçeveleri

**CTRL/0 · Kanal 1–4 darbeleri** — `[u16 µs × 4]`, kanal 1–4; 0 = kanal kapalı

**CTRL/1 · Kanal 5–8 darbeleri** — `[u16 µs × 4]`, kanal 5–8; 0 = kanal kapalı

**CTRL/2 · Kanal 9–12 darbeleri** — `[u16 µs × 4]`, kanal 9–12; 0 = kanal kapalı

**CTRL/3 · Kanal 13–16 darbeleri** — `[u16 µs × 4]`, kanal 13–16; 0 = kanal kapalı

### Eylemler

| Komut | Anahtar | Ad | Argüman | Açıklama |
|---|---|---|---|---|
| 0x40 | `center_all` | Tüm kanalları ortala |  | Etkin kanalların hepsini orta darbeye getirir. _(onay ister)_ |
| 0x41 | `disable_all` | Tüm kanalları kapat |  | Bütün kanallarda darbe üretimini durdurur. |

### Modele özgü hatalar

| Bit | Anahtar | Ad |
|---|---|---|
| 10 | `rail_overcurrent` | Servo rayı aşırı akım |

### Öz-test bitleri

| Bit | Anahtar | Ad |
|---|---|---|
| 0 | `pwm_driver` | PWM üreteci |
| 1 | `rail_sense` | Ray gerilimi ölçümü |
| 2 | `current_sense` | Akım ölçümü |
| 3 | `param_storage` | Ayar belleği |

## 6 · Sızdırmaz CAN servo

Suya dayanıklı akıllı servo; konum, hız ve görev oranı kipleri, akım sınırı ve sızıntı algılama.

DEVTYPE **12** · anahtar `sealed_servo` · katalog sürümü 1 · akış en küçük periyodu 1000 µs

### Parametreler

| pid | Anahtar | Ad | Tip | Birim | Aralık | Varsayılan | Grup | Bayraklar | Açıklama |
|---|---|---|---|---|---|---|---|---|---|
| 0x0100 | `pos.kp` | Konum döngüsü · Kp | f32 | 1/° | 0 … 1 | 0.02 | Konum döngüsü |  | Açı hatasına orantılı çıkış kazancı. |
| 0x0101 | `pos.ki` | Konum döngüsü · Ki | f32 | 1/(°·s) | 0 … 10 | 0 | Konum döngüsü |  | Açı hatasının integraline uygulanan kazanç. |
| 0x0102 | `pos.kd` | Konum döngüsü · Kd | f32 | 1/(°/s) | 0 … 0.1 | 0.0005 | Konum döngüsü |  | Açı hatasının değişim hızına uygulanan kazanç; salınımı söndürür. |
| 0x0103 | `pos.i_max` | Konum döngüsü · İntegral sınırı | f32 |  | 0 … 1 | 0.2 | Konum döngüsü |  | İntegral teriminin katkısının üst sınırı (görev oranı). |
| 0x0104 | `pos.tolerance_deg` | İzin verilen hata | f32 | ° | 0 … 10 | 0.5 | Konum döngüsü |  | Hata bu değerin altındayken hedefe varılmış sayılır. |
| 0x0110 | `motion.max_speed_dps` | En yüksek hız | f32 | °/s | 1 … 2000 | 360 | Hareket |  | Konum kipinde hareket profilinin hız sınırı. |
| 0x0111 | `motion.max_accel_dps2` | En yüksek ivme | f32 | °/s² | 0 … 100000 | 2000 | Hareket |  | Hareket profilinin ivme sınırı; 0 sınırsız. |
| 0x0112 | `motion.zero_offset_deg` | Sıfır ofseti | f32 | ° | -180 … 180 | 0 | Hareket |  | Ham açıdan çıkarılan değer; "Buradan sıfırla" eylemi doldurur. |
| 0x0113 | `motion.invert` | Yönü ters çevir | bool |  |  | kapalı | Hareket | sürerken kilitli | Pozitif komutun servoyu ters yönde döndürmesini sağlar. |
| 0x0114 | `motion.continuous` | Sürekli dönüş kipi | bool |  |  | kapalı | Hareket | sürerken kilitli | Açı limitleri yerine sınırsız dönüşe izin verir; konum çok turlu sayılır. |
| 0x0115 | `motion.idle_mode` | Boşta kipi | enum |  |  | Fren | Hareket |  | Kapalı kipte motorun frenleyip frenlemeyeceği. Seçenekler: 0 Fren · 1 Serbest. |
| 0x0120 | `limits.current_a` | Akım (tork) sınırı | f32 | A | 0.1 … 10 | 3 | Sınırlar |  | Motor akımının üst sınırı; servonun uygulayabileceği torku sınırlar. |
| 0x0121 | `limits.min_angle_deg` | En küçük açı | f32 | ° | -360 … 360 | -135 | Sınırlar |  | Konum komutunun inebileceği en küçük açı. |
| 0x0122 | `limits.max_angle_deg` | En büyük açı | f32 | ° | -360 … 360 | 135 | Sınırlar |  | Konum komutunun çıkabileceği en büyük açı. |
| 0x0123 | `limits.temp_c` | Sıcaklık sınırı | f32 | °C | 40 … 100 | 80 | Sınırlar |  | Servo bu sıcaklığı aşarsa akım azaltılır ve uyarı verilir. |
| 0x0001 | `can.data_bitrate` | FD veri hızı | enum |  |  | 2 Mbit/s | CAN hattı | yeniden başlatma | CAN-FD veri evresinin hızı; Klasik seçilirse kart FD çerçevesi göndermez (roboRIO ve MCP2515 hatları için). Seçenekler: 0 Klasik (FD yok) · 1 2 Mbit/s · 2 5 Mbit/s · 3 8 Mbit/s. |
| 0x0002 | `can.termination` | Hat sonlandırma (120 Ω) | bool |  |  | kapalı | CAN hattı | salt-okunur | Bu kartta anahtarlanabilir sonlandırma yok; değer her zaman kapalıdır. |
| 0x0003 | `ctrl.timeout_ms` | Komut zaman aşımı | u32 | ms | 20 … 2000 | 200 | Kontrol |  | Bu süre içinde yeni kontrol çerçevesi gelmezse çıkış nötre döner ve uyarı verilir. |
| 0x0010 | `status.0.period_ms` | Durum 0 periyodu · Hızlı | u32 | ms | 0 … 60000 (0 = kapalı, en az 5) | 10 | Durum çerçeveleri |  | Hızlı çerçevesinin gönderim aralığı; 0 çerçeveyi kapatır, en az 5 ms. |
| 0x0011 | `status.1.period_ms` | Durum 1 periyodu · Kapalı döngü | u32 | ms | 0 … 60000 (0 = kapalı, en az 5) | 50 | Durum çerçeveleri |  | Kapalı döngü çerçevesinin gönderim aralığı; 0 çerçeveyi kapatır, en az 5 ms. |
| 0x0012 | `status.2.period_ms` | Durum 2 periyodu · Güç ve ısı | u32 | ms | 0 … 60000 (0 = kapalı, en az 5) | 100 | Durum çerçeveleri |  | Güç ve ısı çerçevesinin gönderim aralığı; 0 çerçeveyi kapatır, en az 5 ms. |

### Sinyaller

| sid | Anahtar | Ad | Birim | Gösterim aralığı | Basamak | Değerler |
|---|---|---|---|---|---|---|
| 1 | `position` | Konum | ° | -180 … 180 | 1 |  |
| 2 | `velocity` | Hız | °/s | -720 … 720 | 1 |  |
| 3 | `setpoint` | Hedef |  | -180 … 180 | 1 |  |
| 4 | `error` | Hata |  | -90 … 90 | 2 |  |
| 5 | `current` | Akım | A | -10 … 10 | 2 |  |
| 6 | `voltage` | Gerilim | V | 0 … 16 | 2 |  |
| 7 | `temp` | Sıcaklık | °C | 0 … 100 | 1 |  |
| 8 | `output` | Çıkış |  | -1 … 1 | 3 |  |
| 9 | `ctrl.mode` | Etkin kontrol kipi |  | 0 … 3 | 0 | 0 Kapalı · 1 Konum · 2 Hız · 3 Görev oranı |

### Durum çerçeveleri

**STATUS/0 · Hızlı** — varsayılan periyot 10 ms (`status.0.period_ms`)

| Bayt | Bit | Tip | Sinyal | Ölçek | Sapma | Birim |
|---|---|---|---|---|---|---|
| 0 |  | f32 | `position` |  |  | ° |
| 4 |  | i16 | `velocity` | 0.1 |  | °/s |
| 6 |  | i16 | `current` | 0.001 |  | A |

**STATUS/1 · Kapalı döngü** — varsayılan periyot 50 ms (`status.1.period_ms`)

| Bayt | Bit | Tip | Sinyal | Ölçek | Sapma | Birim |
|---|---|---|---|---|---|---|
| 0 |  | f32 | `setpoint` |  |  |  |
| 4 |  | f32 | `error` |  |  |  |

**STATUS/2 · Güç ve ısı** — varsayılan periyot 100 ms (`status.2.period_ms`)

| Bayt | Bit | Tip | Sinyal | Ölçek | Sapma | Birim |
|---|---|---|---|---|---|---|
| 0 |  | i16 | `output` | 0.0001 |  |  |
| 2 |  | u16 | `voltage` | 0.01 |  | V |
| 4 |  | i16 | `temp` | 0.1 |  | °C |
| 6 |  | u8 | `ctrl.mode` | 1 |  |  |

### Kontrol çerçeveleri

**CTRL/0 · Sürüş komutu** — `[mode u8] [flags u8] [0 0] [value f32]`

| Kip | Anahtar | Ad | Birim | Değer aralığı |
|---|---|---|---|---|
| 0 | `off` | Kapalı |  | — |
| 1 | `position` | Konum | ° | -360 … 360 |
| 2 | `velocity` | Hız | °/s | -2000 … 2000 |
| 3 | `duty` | Görev oranı |  | -1 … 1 |

### Eylemler

| Komut | Anahtar | Ad | Argüman | Açıklama |
|---|---|---|---|---|
| 0x40 | `zero_here` | Buradan sıfırla |  | Şu anki açıyı sıfır ofseti olarak yazar; kalıcı olması için kaydedin. |

### Modele özgü hatalar

| Bit | Anahtar | Ad |
|---|---|---|
| 10 | `stall` | Sıkışma |
| 11 | `water_leak` | Su sızıntısı algılandı |

### Öz-test bitleri

| Bit | Anahtar | Ad |
|---|---|---|
| 0 | `motor_driver` | Motor sürücüsü |
| 1 | `position_sensor` | Konum sensörü |
| 2 | `leak_sensor` | Sızıntı sensörü |
| 3 | `param_storage` | Ayar belleği |

### Tuner döngüleri

| Döngü | Kip | Birim | Kazançlar | Hedef / ölçüm / çıkış / hata |
|---|---|---|---|---|
| Konum döngüsü | CTRL/0 kip 1 | ° | kp=`pos.kp` ki=`pos.ki` kd=`pos.kd` iMax=`pos.i_max` | `setpoint` / `position` / `output` / `error` |

## 7 · Güç dağıtım, küçük

4 çıkışlı küçük güç dağıtım kartı (yer tutucu katalog).

DEVTYPE **8** · anahtar `pdh_small` · katalog sürümü 1 · akış en küçük periyodu 2000 µs

### Parametreler

| pid | Anahtar | Ad | Tip | Birim | Aralık | Varsayılan | Grup | Bayraklar | Açıklama |
|---|---|---|---|---|---|---|---|---|---|
| 0x0100 | `power.uv_warn_v` | Düşük gerilim uyarı eşiği | f32 | V | 5 … 30 | 10.5 | Güç |  | Giriş gerilimi bu değerin altına inerse düşük gerilim uyarısı verilir. |
| 0x0001 | `can.data_bitrate` | FD veri hızı | enum |  |  | 2 Mbit/s | CAN hattı | yeniden başlatma | CAN-FD veri evresinin hızı; Klasik seçilirse kart FD çerçevesi göndermez (roboRIO ve MCP2515 hatları için). Seçenekler: 0 Klasik (FD yok) · 1 2 Mbit/s · 2 5 Mbit/s · 3 8 Mbit/s. |
| 0x0002 | `can.termination` | Hat sonlandırma (120 Ω) | bool |  |  | kapalı | CAN hattı | salt-okunur | Bu kartta anahtarlanabilir sonlandırma yok; değer her zaman kapalıdır. |
| 0x0010 | `status.0.period_ms` | Durum 0 periyodu · Güç | u32 | ms | 0 … 60000 (0 = kapalı, en az 5) | 100 | Durum çerçeveleri |  | Güç çerçevesinin gönderim aralığı; 0 çerçeveyi kapatır, en az 5 ms. |
| 0x0011 | `status.1.period_ms` | Durum 1 periyodu · Sigortalar | u32 | ms | 0 … 60000 (0 = kapalı, en az 5) | 500 | Durum çerçeveleri |  | Sigortalar çerçevesinin gönderim aralığı; 0 çerçeveyi kapatır, en az 5 ms. |

### Sinyaller

| sid | Anahtar | Ad | Birim | Gösterim aralığı | Basamak | Değerler |
|---|---|---|---|---|---|---|
| 1 | `input.voltage` | Giriş gerilimi | V | 0 … 16 | 2 |  |
| 2 | `total.current` | Toplam akım | A | 0 … 60 | 2 |  |
| 3 | `rail5.voltage` | 5 V ray gerilimi | V | 0 … 6 | 2 |  |
| 4 | `rail12.voltage` | 12 V ray gerilimi | V | 0 … 14 | 2 |  |
| 5 | `fuse.mask` | Atan sigortalar |  | 0 … 15 | 0 | bit0 Kanal 1 sigortası · bit1 Kanal 2 sigortası · bit2 Kanal 3 sigortası · bit3 Kanal 4 sigortası |

### Durum çerçeveleri

**STATUS/0 · Güç** — varsayılan periyot 100 ms (`status.0.period_ms`)

| Bayt | Bit | Tip | Sinyal | Ölçek | Sapma | Birim |
|---|---|---|---|---|---|---|
| 0 |  | u16 | `input.voltage` | 0.01 |  | V |
| 2 |  | u16 | `total.current` | 0.01 |  | A |
| 4 |  | u16 | `rail5.voltage` | 0.001 |  | V |
| 6 |  | u16 | `rail12.voltage` | 0.001 |  | V |

**STATUS/1 · Sigortalar** — varsayılan periyot 500 ms (`status.1.period_ms`)

| Bayt | Bit | Tip | Sinyal | Ölçek | Sapma | Birim |
|---|---|---|---|---|---|---|
| 0 | 0..3 | u8 | `fuse.mask` | 1 |  |  |

### Kontrol çerçeveleri

_Yok (eyleyici değil)._

### Eylemler

_Yalnızca ortak komutlar._

### Modele özgü hatalar

| Bit | Anahtar | Ad |
|---|---|---|
| 10 | `fuse_blown` | Sigorta attı |

### Öz-test bitleri

| Bit | Anahtar | Ad |
|---|---|---|
| 0 | `current_sense` | Akım ölçümü |
| 1 | `rail_sense` | Ray gerilimleri |

## 8 · Güç dağıtım, büyük

8 sigortalı güç kanalı, 5 V ve 12 V yardımcı çıkış; kanal başına akım ölçümü.

DEVTYPE **8** · anahtar `pdh_large` · katalog sürümü 1 · akış en küçük periyodu 1000 µs

### Parametreler

| pid | Anahtar | Ad | Tip | Birim | Aralık | Varsayılan | Grup | Bayraklar | Açıklama |
|---|---|---|---|---|---|---|---|---|---|
| 0x0100 | `power.uv_warn_v` | Düşük gerilim uyarı eşiği | f32 | V | 5 … 30 | 10.5 | Güç |  | Giriş gerilimi bu değerin altına inerse düşük gerilim uyarısı verilir. |
| 0x0101 | `power.total_warn_a` | Toplam akım uyarı eşiği | f32 | A | 1 … 300 | 120 | Güç |  | Toplam akım bu değeri aşarsa uyarı verilir; ana sigortanın altında tutun. |
| 0x0110 | `ch.1.warn_a` | Kanal 1 · Uyarı akımı | f32 | A | 0 … 40 | 30 | Kanallar |  | Kanal akımı bu değeri aşarsa uyarı verilir; 0 uyarıyı kapatır. |
| 0x0111 | `ch.2.warn_a` | Kanal 2 · Uyarı akımı | f32 | A | 0 … 40 | 30 | Kanallar |  | Kanal akımı bu değeri aşarsa uyarı verilir; 0 uyarıyı kapatır. |
| 0x0112 | `ch.3.warn_a` | Kanal 3 · Uyarı akımı | f32 | A | 0 … 40 | 30 | Kanallar |  | Kanal akımı bu değeri aşarsa uyarı verilir; 0 uyarıyı kapatır. |
| 0x0113 | `ch.4.warn_a` | Kanal 4 · Uyarı akımı | f32 | A | 0 … 40 | 30 | Kanallar |  | Kanal akımı bu değeri aşarsa uyarı verilir; 0 uyarıyı kapatır. |
| 0x0114 | `ch.5.warn_a` | Kanal 5 · Uyarı akımı | f32 | A | 0 … 40 | 30 | Kanallar |  | Kanal akımı bu değeri aşarsa uyarı verilir; 0 uyarıyı kapatır. |
| 0x0115 | `ch.6.warn_a` | Kanal 6 · Uyarı akımı | f32 | A | 0 … 40 | 30 | Kanallar |  | Kanal akımı bu değeri aşarsa uyarı verilir; 0 uyarıyı kapatır. |
| 0x0116 | `ch.7.warn_a` | Kanal 7 · Uyarı akımı | f32 | A | 0 … 40 | 30 | Kanallar |  | Kanal akımı bu değeri aşarsa uyarı verilir; 0 uyarıyı kapatır. |
| 0x0117 | `ch.8.warn_a` | Kanal 8 · Uyarı akımı | f32 | A | 0 … 40 | 30 | Kanallar |  | Kanal akımı bu değeri aşarsa uyarı verilir; 0 uyarıyı kapatır. |
| 0x0120 | `aux.5v_enable` | 5 V yardımcı çıkış etkin | bool |  |  | açık | Yardımcı çıkışlar |  | 5 V · 1 A yardımcı çıkışı açar veya kapatır. |
| 0x0121 | `aux.12v_enable` | 12 V yardımcı çıkış etkin | bool |  |  | açık | Yardımcı çıkışlar |  | 12 V · 1 A yardımcı çıkışı açar veya kapatır. |
| 0x0001 | `can.data_bitrate` | FD veri hızı | enum |  |  | 2 Mbit/s | CAN hattı | yeniden başlatma | CAN-FD veri evresinin hızı; Klasik seçilirse kart FD çerçevesi göndermez (roboRIO ve MCP2515 hatları için). Seçenekler: 0 Klasik (FD yok) · 1 2 Mbit/s · 2 5 Mbit/s · 3 8 Mbit/s. |
| 0x0002 | `can.termination` | Hat sonlandırma (120 Ω) | bool |  |  | kapalı | CAN hattı |  | Kart hattın ucundaysa açın; hatta tam iki sonlandırma olmalıdır. |
| 0x0010 | `status.0.period_ms` | Durum 0 periyodu · Kanal 1–4 akımı | u32 | ms | 0 … 60000 (0 = kapalı, en az 5) | 20 | Durum çerçeveleri |  | Kanal 1–4 akımı çerçevesinin gönderim aralığı; 0 çerçeveyi kapatır, en az 5 ms. |
| 0x0011 | `status.1.period_ms` | Durum 1 periyodu · Kanal 5–8 akımı | u32 | ms | 0 … 60000 (0 = kapalı, en az 5) | 20 | Durum çerçeveleri |  | Kanal 5–8 akımı çerçevesinin gönderim aralığı; 0 çerçeveyi kapatır, en az 5 ms. |
| 0x0012 | `status.2.period_ms` | Durum 2 periyodu · Toplam | u32 | ms | 0 … 60000 (0 = kapalı, en az 5) | 50 | Durum çerçeveleri |  | Toplam çerçevesinin gönderim aralığı; 0 çerçeveyi kapatır, en az 5 ms. |
| 0x0013 | `status.3.period_ms` | Durum 3 periyodu · Yardımcı raylar | u32 | ms | 0 … 60000 (0 = kapalı, en az 5) | 200 | Durum çerçeveleri |  | Yardımcı raylar çerçevesinin gönderim aralığı; 0 çerçeveyi kapatır, en az 5 ms. |
| 0x0014 | `status.4.period_ms` | Durum 4 periyodu · Enerji | u32 | ms | 0 … 60000 (0 = kapalı, en az 5) | 1000 | Durum çerçeveleri |  | Enerji çerçevesinin gönderim aralığı; 0 çerçeveyi kapatır, en az 5 ms. |

### Sinyaller

| sid | Anahtar | Ad | Birim | Gösterim aralığı | Basamak | Değerler |
|---|---|---|---|---|---|---|
| 1 | `input.voltage` | Giriş gerilimi | V | 0 … 16 | 2 |  |
| 2 | `total.current` | Toplam akım | A | 0 … 200 | 1 |  |
| 3 | `ch.1.current` | Kanal 1 akımı | A | 0 … 40 | 2 |  |
| 4 | `ch.2.current` | Kanal 2 akımı | A | 0 … 40 | 2 |  |
| 5 | `ch.3.current` | Kanal 3 akımı | A | 0 … 40 | 2 |  |
| 6 | `ch.4.current` | Kanal 4 akımı | A | 0 … 40 | 2 |  |
| 7 | `ch.5.current` | Kanal 5 akımı | A | 0 … 40 | 2 |  |
| 8 | `ch.6.current` | Kanal 6 akımı | A | 0 … 40 | 2 |  |
| 9 | `ch.7.current` | Kanal 7 akımı | A | 0 … 40 | 2 |  |
| 10 | `ch.8.current` | Kanal 8 akımı | A | 0 … 40 | 2 |  |
| 11 | `fuse.mask` | Atan sigortalar |  | 0 … 255 | 0 | bit0 Kanal 1 sigortası · bit1 Kanal 2 sigortası · bit2 Kanal 3 sigortası · bit3 Kanal 4 sigortası · bit4 Kanal 5 sigortası · bit5 Kanal 6 sigortası · bit6 Kanal 7 sigortası · bit7 Kanal 8 sigortası |
| 12 | `aux5.voltage` | 5 V ray gerilimi | V | 0 … 6 | 3 |  |
| 13 | `aux5.current` | 5 V ray akımı | A | 0 … 1.5 | 3 |  |
| 14 | `aux12.voltage` | 12 V ray gerilimi | V | 0 … 14 | 3 |  |
| 15 | `aux12.current` | 12 V ray akımı | A | 0 … 1.5 | 3 |  |
| 16 | `temp` | Kart sıcaklığı | °C | 0 … 100 | 0 |  |
| 17 | `energy` | Harcanan enerji | Wh | 0 … 200 | 2 |  |
| 18 | `power` | Anlık güç | W | 0 … 2500 | 0 |  |

### Durum çerçeveleri

**STATUS/0 · Kanal 1–4 akımı** — varsayılan periyot 20 ms (`status.0.period_ms`)

| Bayt | Bit | Tip | Sinyal | Ölçek | Sapma | Birim |
|---|---|---|---|---|---|---|
| 0 |  | u16 | `ch.1.current` | 0.01 |  | A |
| 2 |  | u16 | `ch.2.current` | 0.01 |  | A |
| 4 |  | u16 | `ch.3.current` | 0.01 |  | A |
| 6 |  | u16 | `ch.4.current` | 0.01 |  | A |

**STATUS/1 · Kanal 5–8 akımı** — varsayılan periyot 20 ms (`status.1.period_ms`)

| Bayt | Bit | Tip | Sinyal | Ölçek | Sapma | Birim |
|---|---|---|---|---|---|---|
| 0 |  | u16 | `ch.5.current` | 0.01 |  | A |
| 2 |  | u16 | `ch.6.current` | 0.01 |  | A |
| 4 |  | u16 | `ch.7.current` | 0.01 |  | A |
| 6 |  | u16 | `ch.8.current` | 0.01 |  | A |

**STATUS/2 · Toplam** — varsayılan periyot 50 ms (`status.2.period_ms`)

| Bayt | Bit | Tip | Sinyal | Ölçek | Sapma | Birim |
|---|---|---|---|---|---|---|
| 0 |  | u16 | `input.voltage` | 0.01 |  | V |
| 2 |  | u16 | `total.current` | 0.01 |  | A |
| 4 |  | u16 | `power` | 1 |  | W |
| 6 |  | u8 | `fuse.mask` | 1 |  |  |
| 7 |  | i8 | `temp` | 1 |  | °C |

**STATUS/3 · Yardımcı raylar** — varsayılan periyot 200 ms (`status.3.period_ms`)

| Bayt | Bit | Tip | Sinyal | Ölçek | Sapma | Birim |
|---|---|---|---|---|---|---|
| 0 |  | u16 | `aux5.voltage` | 0.001 |  | V |
| 2 |  | u16 | `aux5.current` | 0.001 |  | A |
| 4 |  | u16 | `aux12.voltage` | 0.001 |  | V |
| 6 |  | u16 | `aux12.current` | 0.001 |  | A |

**STATUS/4 · Enerji** — varsayılan periyot 1000 ms (`status.4.period_ms`)

| Bayt | Bit | Tip | Sinyal | Ölçek | Sapma | Birim |
|---|---|---|---|---|---|---|
| 0 |  | f32 | `energy` |  |  | Wh |

### Kontrol çerçeveleri

_Yok (eyleyici değil)._

### Eylemler

| Komut | Anahtar | Ad | Argüman | Açıklama |
|---|---|---|---|---|
| 0x40 | `reset_energy` | Enerji sayacını sıfırla |  | Harcanan enerji sayacını sıfırlar. |

### Modele özgü hatalar

| Bit | Anahtar | Ad |
|---|---|---|
| 10 | `fuse_blown` | Sigorta attı |
| 11 | `aux_overcurrent` | Yardımcı ray aşırı akım |

### Öz-test bitleri

| Bit | Anahtar | Ad |
|---|---|---|
| 0 | `current_sense` | Akım sensörleri |
| 1 | `rail_sense` | Ray gerilimleri |
| 2 | `fuse_sense` | Sigorta algılama |

## 9 · SoC regülatörü

Yardımcı bilgisayarlar (SoC) için kararlı besleme; 5, 12 veya 19 V çıkışlı varyantlar.

DEVTYPE **8** · anahtar `soc_reg` · katalog sürümü 1 · akış en küçük periyodu 1000 µs

### Parametreler

| pid | Anahtar | Ad | Tip | Birim | Aralık | Varsayılan | Grup | Bayraklar | Açıklama |
|---|---|---|---|---|---|---|---|---|---|
| 0x0100 | `reg.output_v` | Çıkış gerilimi | enum |  |  | 12 V | Güç | salt-okunur | Kartın donanım varyantıyla belirlenen çıkış gerilimi. Seçenekler: 5 5 V · 12 12 V · 19 19 V. |
| 0x0101 | `reg.uvlo_v` | Düşük giriş gerilimi kesme | f32 | V | 5 … 30 | 6.5 | Güç |  | Giriş bu gerilimin altına inerse çıkış kapatılır. |
| 0x0102 | `reg.current_warn_a` | Çıkış akımı uyarı eşiği | f32 | A | 0.1 … 10 | 4 | Güç |  | Çıkış akımı bu değeri aşarsa uyarı verilir. |
| 0x0001 | `can.data_bitrate` | FD veri hızı | enum |  |  | 2 Mbit/s | CAN hattı | yeniden başlatma | CAN-FD veri evresinin hızı; Klasik seçilirse kart FD çerçevesi göndermez (roboRIO ve MCP2515 hatları için). Seçenekler: 0 Klasik (FD yok) · 1 2 Mbit/s · 2 5 Mbit/s · 3 8 Mbit/s. |
| 0x0002 | `can.termination` | Hat sonlandırma (120 Ω) | bool |  |  | kapalı | CAN hattı | salt-okunur | Bu kartta anahtarlanabilir sonlandırma yok; değer her zaman kapalıdır. |
| 0x0010 | `status.0.period_ms` | Durum 0 periyodu · Güç | u32 | ms | 0 … 60000 (0 = kapalı, en az 5) | 50 | Durum çerçeveleri |  | Güç çerçevesinin gönderim aralığı; 0 çerçeveyi kapatır, en az 5 ms. |
| 0x0011 | `status.1.period_ms` | Durum 1 periyodu · Isıl ve sayaç | u32 | ms | 0 … 60000 (0 = kapalı, en az 5) | 1000 | Durum çerçeveleri |  | Isıl ve sayaç çerçevesinin gönderim aralığı; 0 çerçeveyi kapatır, en az 5 ms. |

### Sinyaller

| sid | Anahtar | Ad | Birim | Gösterim aralığı | Basamak | Değerler |
|---|---|---|---|---|---|---|
| 1 | `input.voltage` | Giriş gerilimi | V | 0 … 16 | 2 |  |
| 2 | `output.voltage` | Çıkış gerilimi | V | 0 … 20 | 3 |  |
| 3 | `output.current` | Çıkış akımı | A | 0 … 6 | 3 |  |
| 4 | `output.ripple` | Çıkış dalgalanması (tepe-tepe) | mV | 0 … 200 | 1 |  |
| 5 | `temp` | Sıcaklık | °C | 0 … 100 | 1 |  |
| 6 | `brownout.count` | Gerilim düşmesi sayacı |  | 0 … 100 | 0 |  |

### Durum çerçeveleri

**STATUS/0 · Güç** — varsayılan periyot 50 ms (`status.0.period_ms`)

| Bayt | Bit | Tip | Sinyal | Ölçek | Sapma | Birim |
|---|---|---|---|---|---|---|
| 0 |  | u16 | `input.voltage` | 0.01 |  | V |
| 2 |  | u16 | `output.voltage` | 0.001 |  | V |
| 4 |  | u16 | `output.current` | 0.001 |  | A |
| 6 |  | u16 | `output.ripple` | 0.1 |  | mV |

**STATUS/1 · Isıl ve sayaç** — varsayılan periyot 1000 ms (`status.1.period_ms`)

| Bayt | Bit | Tip | Sinyal | Ölçek | Sapma | Birim |
|---|---|---|---|---|---|---|
| 0 |  | i16 | `temp` | 0.1 |  | °C |
| 2 |  | u32 | `brownout.count` | 1 |  |  |

### Kontrol çerçeveleri

_Yok (eyleyici değil)._

### Eylemler

_Yalnızca ortak komutlar._

### Modele özgü hatalar

| Bit | Anahtar | Ad |
|---|---|---|
| 10 | `output_overcurrent` | Çıkış aşırı akım |
| 11 | `output_out_of_regulation` | Çıkış düzensiz |

### Öz-test bitleri

| Bit | Anahtar | Ad |
|---|---|---|
| 0 | `output_sense` | Çıkış gerilimi ölçümü |
| 1 | `current_sense` | Akım ölçümü |

## 10 · CAN debug OLED

Hattaki kartları ve seçilen değerleri gösteren küçük ekran; bilgisayarsız hızlı kontrol için.

DEVTYPE **10** · anahtar `oled` · katalog sürümü 1 · akış en küçük periyodu 10000 µs

### Parametreler

| pid | Anahtar | Ad | Tip | Birim | Aralık | Varsayılan | Grup | Bayraklar | Açıklama |
|---|---|---|---|---|---|---|---|---|---|
| 0x0100 | `oled.brightness` | Parlaklık | u32 | % | 0 … 100 | 80 | Ekran |  | Ekran parlaklığı; düşük değer ekran ömrünü uzatır. |
| 0x0101 | `oled.rotation` | Ekran yönü | enum |  |  | Normal | Ekran |  | Kart ters monte edildiyse ekranı 180° döndürün. Seçenekler: 0 Normal · 1 180° döndürülmüş. |
| 0x0102 | `oled.page_s` | Otomatik sayfa geçişi | f32 | s | 0 … 60 | 5 | Ekran |  | Sayfalar arasında otomatik geçiş süresi; 0 geçişi kapatır. |
| 0x0103 | `oled.overview_enable` | Genel durum sayfası | bool |  |  | açık | Ekran |  | Hattaki kartları ve hatalarını listeleyen sayfayı gösterir. |
| 0x0110 | `watch.1.devtype` | İzleme 1 · Kaynak cihaz tipi | u32 |  | 0 … 31 | 0 | İzleme yuvaları |  | İzlenecek kartın DEVTYPE değeri; 0 yuvayı boşaltır. |
| 0x0111 | `watch.1.num` | İzleme 1 · Kaynak numara | u32 |  | 1 … 62 | 1 | İzleme yuvaları |  | İzlenecek kartın CAN numarası. |
| 0x0112 | `watch.1.frame` | İzleme 1 · Durum çerçevesi | u32 |  | 0 … 15 | 0 | İzleme yuvaları |  | Değerin okunacağı STATUS çerçeve numarası. |
| 0x0113 | `watch.1.field` | İzleme 1 · Alan no | u32 |  | 0 … 15 | 0 | İzleme yuvaları |  | Çerçevedeki alanın katalog sırası (0 ilk alan). |
| 0x0114 | `watch.2.devtype` | İzleme 2 · Kaynak cihaz tipi | u32 |  | 0 … 31 | 0 | İzleme yuvaları |  | İzlenecek kartın DEVTYPE değeri; 0 yuvayı boşaltır. |
| 0x0115 | `watch.2.num` | İzleme 2 · Kaynak numara | u32 |  | 1 … 62 | 1 | İzleme yuvaları |  | İzlenecek kartın CAN numarası. |
| 0x0116 | `watch.2.frame` | İzleme 2 · Durum çerçevesi | u32 |  | 0 … 15 | 0 | İzleme yuvaları |  | Değerin okunacağı STATUS çerçeve numarası. |
| 0x0117 | `watch.2.field` | İzleme 2 · Alan no | u32 |  | 0 … 15 | 0 | İzleme yuvaları |  | Çerçevedeki alanın katalog sırası (0 ilk alan). |
| 0x0118 | `watch.3.devtype` | İzleme 3 · Kaynak cihaz tipi | u32 |  | 0 … 31 | 0 | İzleme yuvaları |  | İzlenecek kartın DEVTYPE değeri; 0 yuvayı boşaltır. |
| 0x0119 | `watch.3.num` | İzleme 3 · Kaynak numara | u32 |  | 1 … 62 | 1 | İzleme yuvaları |  | İzlenecek kartın CAN numarası. |
| 0x011A | `watch.3.frame` | İzleme 3 · Durum çerçevesi | u32 |  | 0 … 15 | 0 | İzleme yuvaları |  | Değerin okunacağı STATUS çerçeve numarası. |
| 0x011B | `watch.3.field` | İzleme 3 · Alan no | u32 |  | 0 … 15 | 0 | İzleme yuvaları |  | Çerçevedeki alanın katalog sırası (0 ilk alan). |
| 0x011C | `watch.4.devtype` | İzleme 4 · Kaynak cihaz tipi | u32 |  | 0 … 31 | 0 | İzleme yuvaları |  | İzlenecek kartın DEVTYPE değeri; 0 yuvayı boşaltır. |
| 0x011D | `watch.4.num` | İzleme 4 · Kaynak numara | u32 |  | 1 … 62 | 1 | İzleme yuvaları |  | İzlenecek kartın CAN numarası. |
| 0x011E | `watch.4.frame` | İzleme 4 · Durum çerçevesi | u32 |  | 0 … 15 | 0 | İzleme yuvaları |  | Değerin okunacağı STATUS çerçeve numarası. |
| 0x011F | `watch.4.field` | İzleme 4 · Alan no | u32 |  | 0 … 15 | 0 | İzleme yuvaları |  | Çerçevedeki alanın katalog sırası (0 ilk alan). |
| 0x0001 | `can.data_bitrate` | FD veri hızı | enum |  |  | 2 Mbit/s | CAN hattı | yeniden başlatma | CAN-FD veri evresinin hızı; Klasik seçilirse kart FD çerçevesi göndermez (roboRIO ve MCP2515 hatları için). Seçenekler: 0 Klasik (FD yok) · 1 2 Mbit/s · 2 5 Mbit/s · 3 8 Mbit/s. |
| 0x0002 | `can.termination` | Hat sonlandırma (120 Ω) | bool |  |  | kapalı | CAN hattı | salt-okunur | Bu kartta anahtarlanabilir sonlandırma yok; değer her zaman kapalıdır. |
| 0x0010 | `status.0.period_ms` | Durum 0 periyodu · Hat istatistiği | u32 | ms | 0 … 60000 (0 = kapalı, en az 5) | 500 | Durum çerçeveleri |  | Hat istatistiği çerçevesinin gönderim aralığı; 0 çerçeveyi kapatır, en az 5 ms. |

### Sinyaller

| sid | Anahtar | Ad | Birim | Gösterim aralığı | Basamak | Değerler |
|---|---|---|---|---|---|---|
| 1 | `bus.devices` | Görülen cihaz sayısı |  | 0 … 64 | 0 |  |
| 2 | `bus.load` | Hat yükü | % | 0 … 100 | 1 |  |
| 3 | `bus.error_frames` | Hata çerçevesi sayısı |  | 0 … 1000 | 0 |  |

### Durum çerçeveleri

**STATUS/0 · Hat istatistiği** — varsayılan periyot 500 ms (`status.0.period_ms`)

| Bayt | Bit | Tip | Sinyal | Ölçek | Sapma | Birim |
|---|---|---|---|---|---|---|
| 0 |  | u8 | `bus.devices` | 1 |  |  |
| 2 |  | u16 | `bus.load` | 0.01 |  | % |
| 4 |  | u32 | `bus.error_frames` | 1 |  |  |

### Kontrol çerçeveleri

**CTRL/0 · Metin yaz** — `[line u8] [col u8] [6 ASCII]`; NUL baytları çizilmez

### Eylemler

_Yalnızca ortak komutlar._

### Modele özgü hatalar

_Yok._

### Öz-test bitleri

| Bit | Anahtar | Ad |
|---|---|---|
| 0 | `display` | Ekran |
| 1 | `param_storage` | Ayar belleği |

## 11 · USB-CAN adaptör

Bilgisayarı CAN hattına bağlayan slcan uyumlu adaptör; hat istatistikleri adaptörden okunur.

DEVTYPE **10** · anahtar `usbcan` · katalog sürümü 1 · akış en küçük periyodu 10000 µs

### Parametreler

| pid | Anahtar | Ad | Tip | Birim | Aralık | Varsayılan | Grup | Bayraklar | Açıklama |
|---|---|---|---|---|---|---|---|---|---|
| 0x0001 | `can.data_bitrate` | FD veri hızı | enum |  |  | 2 Mbit/s | CAN hattı | yeniden başlatma | CAN-FD veri evresinin hızı; Klasik seçilirse kart FD çerçevesi göndermez (roboRIO ve MCP2515 hatları için). Seçenekler: 0 Klasik (FD yok) · 1 2 Mbit/s · 2 5 Mbit/s · 3 8 Mbit/s. |
| 0x0002 | `can.termination` | Hat sonlandırma (120 Ω) | bool |  |  | kapalı | CAN hattı |  | Kart hattın ucundaysa açın; hatta tam iki sonlandırma olmalıdır. |

### Sinyaller

_Yok._

### Durum çerçeveleri

_Yok._

### Kontrol çerçeveleri

_Yok (eyleyici değil)._

### Eylemler

_Yalnızca ortak komutlar._

### Modele özgü hatalar

_Yok._

### Öz-test bitleri

_Yok._
