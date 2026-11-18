# Cygnus Studio

Cygnus CAN ekosistemindeki kartları bulan, yapılandıran, ayarlayan, izleyen ve güncelleyen uygulama. FRC'deki Phoenix Tuner X / REV Hardware Client'ın yaptığı işi Cygnus ürün ailesi için yapar; üzerine PID tuner ve araç yapılandırma menüsü ekler.

Fiziksel kartlar çıkana kadar her şey, kart firmware'inin davranışını taklit eden bir simülatöre karşı çalışır. Donanım geldiğinde değişen tek şey bağlantı katmanıdır.

## Ne var

| Ekran | Ne yapar |
|---|---|
| Hat | Hattaki kartları kendiliğinden bulur, kimlik çakışmasını çözer, hat şemasını ve güç özetini gösterir |
| Araç | Araç şablonu (swerve, tank, İKA, quad/hexa/okto, sabit kanat, su altı, İDA, taret, robot kol) seçilir; kartlar şase şemasındaki yuvalara atanır; numara, ad ve hazır ayarlar tek seferde yazılır |
| Cihaz | Tek kartın canlı durumu, katalogdan üretilen ayar formu, elle kontrol, eylemler, hatalar, öz-test |
| Tuner | Kapalı döngü kazanç ayarı: test sinyalleri, yüksek hızlı yakalama, basamak yanıtı ölçütleri, koşu karşılaştırma, kazanç önerisi |
| Grafik | Birden çok karttan çoklu sinyal, imleç ölçümü, tetik, kayıt ve dışa aktarma |
| CAN İzleyici | Ham ve çözülmüş çerçeveler, süzgeç, çerçeve gönderme, hat istatistikleri |
| Firmware | `.cyfw` imajları, tek kart veya tüm kartlar için CAN üzerinden güncelleme |
| Proje | Hat ayarlarını dosyaya kaydetme, karşılaştırma ve geri yükleme, yapılandırma raporu |

## Depo

```
docs/                 PROTOCOL.md (CyCAN v1) · DEVICES.md · CATALOG.md · ARCHITECTURE.md · VEHICLES.md · TUNER.md · PLAN.md
packages/protocol/    Kimlik düzeni, codec'ler, cihaz kataloğu, slcan, host istemcisi, eski Cyncoder v3 sürücüsü
packages/simulator/   Sanal hat, sanal kartlar, fizik modelleri, senaryolar
packages/vehicles/    Araç şablonları ve yapılandırma planlayıcısı
apps/studio/          React arayüz + Tauri masaüstü kabuğu (src-tauri/)
firmware/cycan/       Kartlar için taşınabilir C kütüphanesi (CyCAN düğüm tarafı + bootloader)
tools/                Katalogdan belge ve C başlığı üreten betikler
```

## Çalıştırma

Gereken: Node 22+.

```
npm install
npm run dev            # tarayıcıda, simülatörle
npm test               # tüm TypeScript testleri
npm run typecheck
make -C firmware/cycan test          # C kütüphanesi testleri
npm run tauri:dev -w @cygnus/studio  # masaüstü (Rust gerekir; bkz. apps/studio/src-tauri/README.md)
```

Katalog değişince: `npm run gen:catalog` (CATALOG.md + `cycan_catalog.h`) ve `npm run gen:vectors`.

## Gerçek donanıma bağlanma

- **USB-CAN adaptör (slcan)**: CANable 2.0 sınıfı adaptörler. Tarayıcıda WebSerial (Chrome/Edge), masaüstünde yerel seri port.
- **roboRIO köprüsü**: robot kodunda `CyncoderBridge.start()` çalışıyorsa TCP 5800 üzerinden (yalnız masaüstü).
- **Cyncoder 1.4**: mevcut kartlar eski protokolleriyle tanınır (konum, hız, mıknatıs sağlığı, sıfırlama, LED). CAN numarası değiştirme henüz yok.

## Durum

Yazılım, donanım olmadan doğrulanabilecek her yerde testlidir; gerçek kartla hat denemesi henüz yapılmadı. Kartlar geldiğinde yapılacaklar `docs/PLAN.md` sonundadır.
