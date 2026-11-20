# Cygnus Studio — İş planı ve durum

Kapsam: fiziksel kartlar çıkana kadar yapılabilecek her şey. Kartlar geldiğinde kalan iş: gerçek adaptörle hat denemesi, firmware ekibinin CyCAN'i kartlara taşıması, katalogların gerçek donanıma göre güncellenmesi.

Sunum takvimindeki karşılığı: bu çalışma **Alfa** hedefini (Şub–Nis 2027) öne çeker.

| Kod | İş paketi | Durum |
|---|---|---|
| P0 | Mimari, CyCAN v1 protokolü, cihaz isterleri | Tamam |
| P1 | Protokol çekirdeği, katalog, slcan, `.cyfw`, altın vektörler | Tamam |
| P2 | Host istemcisi | Tamam |
| S1 | Simülatör | Tamam |
| V0 | Araç şablonları (`@cygnus/vehicles`) | Tamam |
| F1 | Firmware C kütüphanesi (`firmware/cycan`) | Tamam (STM32 örneği gerçek HAL ile derlenmedi) |
| H1 | Eski Cyncoder v3 sürücüsü, roboRIO köprüsü, WebSerial | Tamam (SET_CONFIG yok) |
| H2 | Tauri kabuğu + CI | Tamam (pencere/paket/Actions denenmedi) |
| I1 | Host ↔ simülatör bütünleştirme | Tamam |
| U0, A1 | Arayüz temeli, uygulama çekirdeği, Hat ekranı | Tamam |
| A2–A6 | Tuner, Cihaz, Araç, Grafik, CAN İzleyici, Firmware, Proje ekranları | Tamam |
| Q1 | Bağımsız inceleme (4 ajan, 86 bulgu, 5 kritik) | Tamam (raporlar oturumda: protokol, host-sim, uygulama, tasarim) |
| Q2 | Düzeltme turu | Tamam (6 ajan, dizin bazında) |
| Q3 | Uzlaştırma ve bağımsız doğrulama | Tamam: bulguların yeniden üretimi, emniyet turu, kullanıcı yürüyüşü, çevrimiçi demo (sandbox) — ayrıntı oturumdaki `review/dogrulama.md` |
| D1 | Canlı demo yayını, GitHub'a gönderim | Tamam: demo yayında (claude.ai artifact); kod `mehmetcivici/cygnus-studio` (özel) reposunda; CI ilk çalıştırmada geçti (2026-11-20) |

Son doğrulama (2026-11-19): `npm run typecheck` temiz · 972 TypeScript testi · C kütüphanesi 48 test + fuzz (200 000 çerçeve) · `cygnus-link` 11 + kabuk 3 Rust testi, `cargo clippy -D warnings` temiz · arayüz ve demo derlemesi hatasız.

## Açık işler

1. Tuner sistem tanıma: ileri besleme koşusundan tanımada ölü zaman (θ) çoğu zaman 0 çıkıyor; τ/θ ayrımı açık döngü basamağıyla daha güvenilir.
2. Eski Cyncoder `SET_CONFIG` yükü (CAN numarası değiştirme): `can_handler.h` / `backend/can_protocol.py` gerekli.
3. Dokunma hedefleri: `--cy-h-sm` 28 px (öneri 32 px); eldivenle kullanım için "pit kipi" yok.
4. Kalabalık hatta (62 kart) zaman aşımına uğrayan kartın "kayıp" yerine "yanıt gecikiyor" gösterilmesi doğrulanmadı.
5. Tauri penceresi, paketleme ve sürüm (release) iş akışı gerçek ortamda denenmedi (CI iş akışı GitHub'da geçti); STM32 örneği gerçek HAL ile derlenmedi.

## Yol haritası

- **FRC tarzı ENABLE sinyali** (yayın, ≥10 Hz, sayaçlı; eyleyici yalnız son 100 ms'de görmüşse sürer): değerlendirildi, v1'e alınmadı. v1'de ESTOP mandalı (3 kez gönderim, ESTOP'ta REBOOT reddi) + CTRL bekçisi + nötrden başlama kuralı kullanılıyor.
- **`.cyfw` Ed25519 imza doğrulaması**: biçimde yer ayrıldı (başlık `flags` bit0 + gövde sonrası 64 bayt); v1 bootloader doğrulamıyor.
- **Heartbeat'te açılış sayacı**: kısa kesintiyi BOOT heartbeat'i kaçırılsa da ayırt etmek için.
- **Host kütüphaneleri**: Gemstone, Pixhawk (ArduPilot), Arduino.
- **Eski Cyncoder SET_CONFIG**: numara değiştirme ve yapılandırma yazma.

## Donanım geldiğinde yapılacaklar

1. CANable 2.0 sınıfı adaptör + Cyncoder 1.4 ile eski sürücünün hat denemesi.
2. Cyncoder 1.5 firmware'ine `firmware/cycan` kütüphanesinin eklenmesi; Studio ile keşif, parametre, akış ve bootloader denemesi.
3. Her yeni kart için katalog gözden geçirme (`catalog_rev` artışı) ve simülatör modelinin gerçek ölçümlere göre ayarı.
4. Üretici kodu (MFR) için resmî başvuru sonucu tek sabitin güncellenmesi.
