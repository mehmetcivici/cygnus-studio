# Cygnus Studio

Cygnus CAN ekosistemindeki kartları bulan, yapılandıran, ayarlayan, izleyen ve güncelleyen uygulama. FRC'deki Phoenix Tuner X / REV Hardware Client'ın yaptığı işi Cygnus ürün ailesi için yapar; üzerine PID tuner ve araç yapılandırma menüsü ekler.

Fiziksel kartlar çıkana kadar her şey, kart firmware'inin davranışını taklit eden bir simülatöre karşı çalışır. Donanım geldiğinde değişen tek şey bağlantı katmanıdır.

## Ne var

| Ekran | Ne yapar |
|---|---|
| Hat | Hattaki kartları kendiliğinden bulur, kimlik çakışmasını çözer, hat şemasını ve güç özetini gösterir |
| Araç | Araç şablonu (swerve, tank, İKA, quad/hexa/okto, sabit kanat, su altı, İDA, taret, robot kol) seçilir; kartlar şemadaki yuvalara atanır (listeden, LED'le, "elle çevir / eğ" algılamasıyla); motor testi ve yön doğrulama, encoder sıfırlama; numara, ad ve hazır ayarlar tek seferde yazılır; canlı görünüm |
| Cihaz | Tek kartın canlı durumu, katalogdan üretilen ayar formu (kaydet, kayıtlıya dön, dosyaya aktar, kopyala), elle kontrol, eylemler, hatalar, öz-test |
| Tuner | Kapalı döngü kazanç ayarı: test sinyalleri, yüksek hızlı yakalama, basamak yanıtı ölçütleri, ileri besleme/sistem tanıma/röle ile kazanç önerisi, A/B koşu karşılaştırma, frekans süpürme ve Bode, yazdırılabilir rapor |
| Grafik | Birden çok karttan çoklu sinyal, imleç ölçümü, tetik, kayıt ve dışa aktarma |
| CAN İzleyici | Ham ve çözülmüş çerçeveler, süzgeç, çerçeve gönderme, hat istatistikleri |
| Firmware | `.cyfw` imajları, tek kart veya tüm kartlar için CAN üzerinden güncelleme, iptal/yeniden deneme, açılmayan kartı kurtarma (açılış kurtarma penceresi) |
| Proje | Hat ayarlarını dosyaya kaydetme, karşılaştırma ve geri yükleme, yapılandırma raporu, koda bağlan (C/Arduino/Python kimlik dosyası) |

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
npm run build:demo -w @cygnus/studio # tek dosyalı çevrimiçi demo (dist-demo/index.html; file:// ve korumalı iframe'de çalışır)
npm test               # tüm TypeScript testleri (C köprüsü derlenmişse C↔simülatör fark testleri de koşar)
npm run typecheck
make -C firmware/cycan test fuzz bridge   # C kütüphanesi testleri, fuzz, simülatör karşılaştırması için köprü
npm run tauri:dev -w @cygnus/studio  # masaüstü (Rust gerekir; bkz. apps/studio/src-tauri/README.md)
```

Katalog değişince: `npm run gen:catalog` (CATALOG.md + `cycan_catalog.h`), `npm run gen:vectors` ve `make -C firmware/cycan vectors`.

## Gerçek donanıma bağlanma

- **USB-CAN adaptör (slcan)**: CANable 2.0 sınıfı adaptörler. Tarayıcıda WebSerial (Chrome/Edge), masaüstünde yerel seri port.
- **roboRIO köprüsü**: robot kodunda `CyncoderBridge.start()` çalışıyorsa TCP 5800 üzerinden (yalnız masaüstü).
- **Cyncoder 1.4**: mevcut kartlar eski protokolleriyle tanınır (konum, hız, mıknatıs sağlığı, sıfırlama, LED). CAN numarası değiştirme henüz yok.

## Durum

Yazılım, donanım olmadan doğrulanabilecek her yerde testlidir: TypeScript birim/bütünleştirme testleri, C kütüphanesi testleri ve fuzz, aynı çerçevelerin simülatöre ve gerçek C düğümüne verilip yanıtların karşılaştırıldığı fark testi. Gerçek kartla hat denemesi henüz yapılmadı. Açık işler, yol haritası ve kartlar geldiğinde yapılacaklar `docs/PLAN.md`'dedir.
