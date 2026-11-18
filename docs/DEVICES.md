# Cihaz kataloğu isterleri

Bu belge `packages/protocol/src/catalog/` altındaki katalogların **isterlerini** verir. Kesin `pid`, `sid`, bayt yerleşimi ve varsayılanlar katalog kodundadır; `docs/CATALOG.md` o koddan üretilir.

Sunumda kartların MCU, sensör ve elektriksel ayrıntıları yoktur. Buradaki parametre/sinyal kümeleri, ürünün amacı ve muadillerinden (CTRE, REV, BLHeli, Pigeon, PCA9685) yola çıkan **mühendislik önerisidir**; firmware ekibi donanım netleşince `catalog_rev` artırarak günceller.

Genel kurallar:

- Her parametre: `key` (noktalı, ör. `vel.kp`), tip, birim, min/max/adım, varsayılan, grup, TR+EN etiket ve kısa yardım metni. Bayraklar: `readOnly`, `rebootRequired`, `lockedWhileEnabled`, `advanced`.
- Her sinyal: `sid`, `key`, birim, TR+EN etiket, gösterim aralığı ve basamak sayısı.
- Durum çerçeveleri en çok 8 bayt; sık değişen sinyaller çerçeve 0'da.
- Açısal birimler: konum **tur** (rot), hız **dev/dk** (rpm); jiroskop ve servo açıları **derece**.
- Etiketler sade Türkçe; kısaltma yerine anlaşılır ad ("Hız döngüsü · Kp").

## 1 · ESC 20A (model 1) ve 2 · ESC 80A (model 2) — DEVTYPE 2

Aynı katalog şablonu; fark akım sınırları (20 A / 80 A sürekli) ve varsayılanlar. BLDC, CAN + PWM girişi.

**Kontrol** `CTRL/0 SET` kipleri: 0 Kapalı (boşta) · 1 Görev oranı (−1..1) · 2 Akım (A) · 3 Hız (rpm) · 4 Konum (tur) · 5 Fren.

**Parametreler**
- Motor: kutup çifti sayısı, yön çevir, dişli oranı (motor:mekanizma), boşta kipi (fren/serbest), rampa süresi (0→tam, s).
- Sınırlar: besleme akımı sınırı, faz akımı sınırı, düşük gerilim kesme, yüksek gerilim kesme, sıcaklık sınırı, ileri/geri yazılım konum limiti (etkin + değer).
- Akım döngüsü: Kp, Ki.
- Hız döngüsü: Kp, Ki, Kd, kS (statik sürtünme, V), kV (V/rpm), kA, integral sınırı, çıkış sınırı, hız filtresi (Hz).
- Konum döngüsü: Kp, Ki, Kd, en yüksek hız, en yüksek ivme (trapez profil), izin verilen hata.
- Geri besleme: kaynak (0 sensörsüz · 1 hall · 2 uzak Cyncoder), uzak Cyncoder numarası, sensör yönü.
- PWM girişi: etkin, en küçük/orta/en büyük darbe (µs), ölü bant, çift yön.
- Ortak: `ctrl.timeout_ms`, `status.n.period_ms`, `can.*`.

**Sinyaller**: besleme gerilimi, besleme akımı, faz akımı, görev oranı, hız, konum, hedef (setpoint), kapalı döngü hatası, döngü çıkışı, FET sıcaklığı, motor sıcaklığı, PWM giriş darbesi, harcanan enerji (Wh).

**Eylemler**: motor yönünü algıla, motor parametrelerini ölç (direnç/kV), PWM girişini kalibre et, konumu sıfırla.
**Modele özgü hatalar**: motor bağlantısı yok, sensör kaybı, kilitli rotor, uzak sensör kayıp.
**Tuner döngüleri**: akım, hız, konum.

## 3 · Cyncoder (model 3) — DEVTYPE 7

**Parametreler**: sıfır ofseti (tur), yön çevir, mutlak aralık (0..1 / ±0,5), sensör:mekanizma oranı, hız filtresi penceresi (ms), açılışta konum (mutlak / sıfır), durum periyotları.
**Sinyaller**: mutlak konum (tur), çok turlu konum (tur), hız (rpm), mıknatıs alan şiddeti (AGC 0–255), mıknatıs durumu (iyi / zayıf / çok güçlü / yok), ham açı (0–4095), kart sıcaklığı.
**Eylemler**: buradan sıfırla, çok turlu sayacı sıfırla.
**Modele özgü hatalar**: mıknatıs yok, mıknatıs zayıf, mıknatıs çok güçlü.

## 4 · CAN gyro (model 4) — DEVTYPE 4

**Parametreler**: montaj yönü (yaw/pitch/roll ofseti, derece), füzyon kipi (6 eksen / 9 eksen), açılışta otomatik sapma kalibrasyonu, sapma (yaw) yönü çevir, jiroskop aralığı (dps), ivmeölçer aralığı (g), alçak geçiren filtre (Hz), durum periyotları.
**Sinyaller**: yaw, pitch, roll (derece), açısal hız X/Y/Z (dps), ivme X/Y/Z (g), kuaterniyon w/x/y/z, sıcaklık, kalibrasyon durumu.
**Eylemler**: sapmayı kalibre et (sabit tut), yaw'ı sıfırla, seviyeyi sıfırla.
**Modele özgü hatalar**: kalibrasyon sırasında hareket, sensör doygunluğu.

## 5 · CAN servo kontrol, 16 kanal (model 5) — DEVTYPE 12

**Kontrol**: `CTRL/0..3` = dörder kanal `[u16 µs × 4]` (0 = kanal kapalı).
**Parametreler**: PWM frekansı (50–333 Hz), kanal başına: etkin, en küçük/orta/en büyük darbe, güvenli (failsafe) darbe, ters çevir, hız sınırı (µs/s); servo rayı düşük gerilim uyarısı.
**Sinyaller**: servo rayı gerilimi, toplam akım, kanal 1–16 çıkış darbesi (µs), kart sıcaklığı.
**Eylemler**: tüm kanalları ortala, tüm kanalları kapat.
**Modele özgü hatalar**: servo rayı aşırı akım.

## 6 · Sızdırmaz CAN servo (model 6) — DEVTYPE 12

**Kontrol** `CTRL/0 SET` kipleri: 0 Kapalı · 1 Konum (derece) · 2 Hız (derece/s) · 3 Görev oranı.
**Parametreler**: konum Kp/Ki/Kd, en yüksek hız, en yüksek ivme, akım (tork) sınırı, en küçük/en büyük açı limiti, sıfır ofseti, yön çevir, sürekli dönüş kipi, sıcaklık sınırı.
**Sinyaller**: konum, hız, hedef, hata, akım, gerilim, sıcaklık, çıkış.
**Eylemler**: buradan sıfırla.
**Modele özgü hatalar**: sıkışma (stall), su sızıntısı algılandı.
**Tuner döngüleri**: konum.

## 7 · Güç dağıtım, küçük (model 7) — DEVTYPE 8

Sunumda CAN belirtilmemiş; katalogda yer tutucu, 4 çıkış. Sinyaller: giriş gerilimi, toplam akım, 5 V ve 12 V ray gerilimi, atan sigorta maskesi. Parametre: düşük gerilim uyarı eşiği.

## 8 · Güç dağıtım, büyük (model 8) — DEVTYPE 8

8 güç kanalı + 5 V·1 A ve 12 V·1 A yardımcı çıkış; hat başı sigorta; `can.termination` anahtarlanabilir.
**Parametreler**: kanal başına uyarı akımı eşiği (A), düşük gerilim uyarı eşiği, toplam akım uyarı eşiği, yardımcı 5 V / 12 V çıkış etkin, durum periyotları.
**Sinyaller**: giriş gerilimi, toplam akım, kanal 1–8 akımı, atan sigorta maskesi, 5 V ve 12 V ray gerilimi/akımı, kart sıcaklığı, harcanan enerji (Wh), anlık güç (W).
**Eylemler**: enerji sayacını sıfırla.
**Öz-test bitleri**: akım sensörleri, ray gerilimleri, sigorta algılama.
**Modele özgü hatalar**: sigorta attı, yardımcı ray aşırı akım.

## 9 · SoC regülatörü (model 9) — DEVTYPE 8

**Parametreler**: çıkış gerilimi (salt-okunur; 5/12/19 V model varyantı), düşük giriş gerilimi kesme, çıkış akımı uyarı eşiği.
**Sinyaller**: giriş gerilimi, çıkış gerilimi, çıkış akımı, çıkış dalgalanması (mV tepe-tepe), sıcaklık, gerilim düşmesi (brownout) sayacı.
**Modele özgü hatalar**: çıkış aşırı akım, çıkış düzensiz.

## 10 · CAN debug OLED (model 10) — DEVTYPE 10

**Kontrol**: `CTRL/0 TEXT` `[line u8] [col u8] [6 ASCII]`.
**Parametreler**: parlaklık, ekran yönü, otomatik sayfa geçiş süresi, 4 izleme yuvası (her biri: kaynak DEVTYPE, kaynak NUM, STATUS çerçeve no, alan no), genel durum sayfası etkin.
**Sinyaller**: görülen cihaz sayısı, hat yükü (%), hata çerçevesi sayısı.

## 11 · USB-CAN adaptör (model 11) — DEVTYPE 10

Aktarım katmanıdır (slcan). Katalogda yalnızca kimlik bilgisi; hat istatistikleri (yük, hata sayaçları) adaptörden okunur.
