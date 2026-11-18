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
| Q2 | Düzeltme turu | **Sürüyor**: C kütüphanesi tamam; host, simülatör, çekirdek, ekranlar düzeltiliyor |
| D1 | Canlı demo yayını, GitHub'a gönderim | **Yapılmadı** (repo bekleniyor) |

Son doğrulama (2026-11-18): `npm run typecheck` temiz · 784 TypeScript testi · C kütüphanesi 31 test · `cygnus-link` 8 test · arayüz derlemesi hatasız.

## Açık işler (düzeltme turu)

1. Açılışta `state = BOOT` heartbeat'i (PROTOCOL §4.1) kodda yok: simülatör, C kütüphanesi ve host'a eklenecek; host önbelleği buna göre geçersiz kılacak.
2. Protokole `COMMAND LOAD_SAVED` (kalıcı bellekten yeniden yükle) eklenecek; Cihaz ekranındaki "kayıtlıya dön" buna bağlanacak.
3. Host firmware güncellemesi: `ENTER_BOOTLOADER` yeniden denemesi; son ACK kaybında heartbeat sürümünden doğrulama (şu an arayüz katmanı örtüyor).
4. Çekirdek `paramCache`: kart yeniden başlarken/kayıpken parametre okumasın.
5. Kabuk: firmware güncellemesi sırasında gezinme/bağlantı kesme kilidi; durum çubuğunda firmware yuvası.
6. Kaydedici: yüksek hız (akış) örnekleri kayda girsin.
7. Bağlantı yöneticisi: senaryo seçenekleri (`assigned: false`); Araç ekranı şu an `factoryReset` ile dolanıyor.
8. Araç şeması: swerve modül simgeleri üst üste biniyor; dar şablonlar (kol, Ackermann) küçük.
9. Tuner: sistem tanıma τ/θ ayrımı bazen karışıyor; katalogda açık döngü kipi açıkça işaretlenmeli; `StaticChart`'a logaritmik eksen.
10. CAN İzleyici 25 kartlı hatta ölçülmedi; Cihaz ekranında bootloader ve bilinmeyen model durumları denenmedi.
11. Eski Cyncoder `SET_CONFIG` yükü: `can_handler.h` / `backend/can_protocol.py` gerekli.
12. Host kütüphaneleri (Gemstone/Pixhawk/Arduino) yazılmadı.

## Donanım geldiğinde yapılacaklar

1. CANable 2.0 sınıfı adaptör + Cyncoder 1.4 ile eski sürücünün hat denemesi.
2. Cyncoder 1.5 firmware'ine `firmware/cycan` kütüphanesinin eklenmesi; Studio ile keşif, parametre, akış ve bootloader denemesi.
3. Her yeni kart için katalog gözden geçirme (`catalog_rev` artışı) ve simülatör modelinin gerçek ölçümlere göre ayarı.
4. Üretici kodu (MFR) için resmî başvuru sonucu tek sabitin güncellenmesi.
