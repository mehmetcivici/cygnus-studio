# Tuner — isterler

Tuner, Cygnus Studio'nun ana ekranıdır: kapalı döngülü kartların (ESC 20A/80A, sızdırmaz servo; katalogda `tuner.loops` tanımlı her model) kazançlarını güvenli, hızlı ve ölçerek ayarlamayı sağlar. Hedef kullanıcı PID'i yeni öğrenen lise/üniversite takımıdır: araç hem yönlendirmeli hem de uzman için kısıtsız olmalı.

Modele özel kod yoktur; döngüler, kazanç parametreleri ve sinyaller katalogdan gelir.

## Yerleşim

- **Sol**: kart ve döngü seçimi (iç içe döngü şeması: akım → hız → konum; "önce iç döngü" ipucu), kazanç paneli.
- **Orta**: üstte hedef + ölçüm grafiği, altta çıkış / akım / hata grafiği (zaman ekseni ortak).
- **Sağ**: test sinyali üreteci, ölçütler, öneriler.
- **Alt**: koşu geçmişi şeridi.

## 1. Sürme güvenliği

- Sürme **basılı tutarak etkinleştirilir** (1 s); etkinken ekranın çerçevesi belirgin renk alır.
- Test sınırları: en büyük hedef genliği, en uzun test süresi, konum için hareket aralığı. Sınır dışı hedef gönderilmez.
- Otomatik kesme: kart hatası, bağlantı kopması, pencere odağının kaybı, ekran değişimi, boşluk tuşu (ACİL DURDUR).
- Etkinleştirmeden önce uyarı listesi: düşük batarya, kaydedilmemiş ayar, aktif hata, yazılım limiti kapalı.

## 2. Test sinyali

Elle (kaydırıcı + sayı + ok tuşlarıyla küçük adımlar), basamak (A → B, bekleme), kare (genlik, periyot), sinüs (genlik, frekans), rampa/trapez, süpürme (chirp, f0 → f1), tekrar sayısı. Hedefler host'tan kontrol döngüsüyle gönderilir; zamanlama ölçümleri kartın akış zaman damgasına göre yapılır (host gecikmesi ölçümü bozmaz).

## 3. Kazançlar

- Sayı alanı + ince ayar kaydırıcısı (logaritmik); değişiklik anında karta (RAM) yazılır.
- "Karta kaydet", "kayıtlı değere dön", geri al (kazanç geçmişi).
- **A/B**: iki kazanç kümesi saklanır, tek tuşla değiştirilir ve aynı test iki kümeyle arka arkaya koşturulabilir.

## 4. Yakalama

Hedef, ölçüm, çıkış, hata ve akım sinyalleri katalogdaki en küçük periyotta (en çok 1 kHz) akıtılır. Her test bir **koşu** olarak saklanır: kazançlar, sinyaller, ölçütler, not.

## 5. Basamak yanıtı ölçütleri

Her basamak için otomatik: yükselme süresi (%10–90), tepe zamanı, aşım (%), oturma süresi (%2 bandı), kalıcı durum hatası, IAE / ITAE, salınım (sönüm oranı tahmini, logaritmik azalmadan), çıkış doygunluğu (sınırda geçen süre %), ölçüm gürültüsü (RMS).
Her ölçüt iyi / orta / kötü olarak derecelendirilir ve sade dille ipucu verilir ("Aşım yüksek: Kp'yi azaltın veya Kd ekleyin", "Kalıcı hata var: Ki ekleyin veya kV'yi düzeltin", "Çıkış doyuyor: hedef, motorun verebileceğinden hızlı").

## 6. Koşu geçmişi ve karşılaştırma

Koşular küçük önizlemeyle şeritte durur; seçilenler grafikte üst üste bindirilir; ölçüt tablosu sıralanabilir; "en iyi" işaretlenir; koşunun kazançları tek tıkla geri yüklenir; CSV / JSON dışa aktarma.

## 7. Ayar yardımcısı

Öneriler hiçbir zaman kendiliğinden uygulanmaz; her öneri, tanımlanan modelle **öngörülen yanıt** eğrisiyle birlikte gösterilir ve kullanıcı uygular.

1. **İleri besleme karakterizasyonu** (hız döngüsü): yavaş rampa + basamaklarla `V = kS·sgn(ω) + kV·ω + kA·α` en küçük kareler uydurması → kS, kV, kA ve R².
2. **Sistem tanıma**: açık döngü basamaktan birinci derece + ölü zaman modeli (K, τ, θ) → SIMC kuralıyla PID önerisi; sertlik seçimi: yumuşak / dengeli / atak. Konum döngüsü için integral alan süreç kuralları.
3. **Röle deneyi** (Åström–Hägglund): sınır salınımından Ku, Tu → Ziegler–Nichols ve Tyreus–Luyben tabloları.

## 8. Frekans yanıtı (ileri)

Süpürme testinden kazanç/faz (Bode) tahmini, kazanç ve faz payı.

## 9. Rapor

Seçilen koşulardan yazdırılabilir ayar raporu (kazançlar, grafikler, ölçütler): takımların teknik raporlarına eklenebilir.

## Kısayollar

Boşluk: ACİL DURDUR · Enter: testi başlat · A/B: kazanç kümesi değiştir · ↑/↓: hedefi küçük adımla değiştir.

## Uygulama notu

Tüm analiz ve tanıma matematiği arayüzden bağımsız saf fonksiyonlardır (`features/tuner/analysis/`) ve cevabı bilinen sentetik sistemlerle (birinci/ikinci derece, ölü zamanlı) test edilir.
