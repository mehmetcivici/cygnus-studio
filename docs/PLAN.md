# Cygnus Studio — İş planı ve durum

Kapsam: fiziksel kartlar çıkana kadar yapılabilecek her şey. Kartlar geldiğinde kalan iş: gerçek adaptörle hat denemesi, firmware ekibinin CyCAN'i kartlara taşıması, katalogların gerçek donanıma göre güncellenmesi.

Sunum takvimindeki karşılığı: bu çalışma **Alfa** hedefini (Şub–Nis 2027) öne çeker.

| Kod | İş paketi | Durum |
|---|---|---|
| P0 | Mimari, CyCAN v1 protokolü, cihaz isterleri | Tamam |
| P1 | Protokol çekirdeği: kimlik, codec, katalog, slcan, `.cyfw`, altın vektörler | Sürüyor |
| U0 | Arayüz temeli: tema, bileşenler, dil, kabuk, canlı grafik | Sürüyor |
| P2 | Host istemcisi: keşif, çakışma çözme, parametre, akış, firmware, sürücü soyutlaması | Bekliyor (P1) |
| S1 | Simülatör: sanal hat, sanal kartlar, fizik modelleri, senaryolar | Bekliyor (P1) |
| A1 | Uygulama çekirdeği: bağlantı, durum deposu, kayıt, Hat ve Cihaz ekranları | Bekliyor (P2, S1, U0) |
| A2 | Tuner | Bekliyor (A1) |
| A3 | Grafik + CAN İzleyici | Bekliyor (A1) |
| A4 | Firmware + Proje ekranları | Bekliyor (A1) |
| V0 | Araç şablonları paketi (`@cygnus/vehicles`) | Bekliyor (P1) |
| A5 | Araç ekranı: şablon seçimi, yuva atama, motor testi, canlı şema | Bekliyor (A1, V0) |
| H1 | Eski Cyncoder v3 sürücüsü + seri port (WebSerial) | Bekliyor (P2) |
| H2 | Tauri masaüstü kabuğu + CI | Bekliyor (A1) |
| F1 | Firmware C kütüphanesi (`firmware/cycan`) + altın vektör testleri | Bekliyor (P1) |
| Q1 | Bağımsız inceleme, bütünleşik test, ekran doğrulaması | Bekliyor |
| D1 | Canlı demo, GitHub, belgeler | Bekliyor |

## Donanım geldiğinde yapılacaklar

1. CANable 2.0 sınıfı adaptör + Cyncoder 1.4 ile eski sürücünün hat denemesi.
2. Cyncoder 1.5 firmware'ine `firmware/cycan` kütüphanesinin eklenmesi; Studio ile keşif, parametre, akış ve bootloader denemesi.
3. Her yeni kart için katalog gözden geçirme (`catalog_rev` artışı) ve simülatör modelinin gerçek ölçümlere göre ayarı.
4. Üretici kodu (MFR) için resmî başvuru sonucu tek sabitin güncellenmesi.
