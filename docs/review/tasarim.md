# Cygnus Studio: kullanılabilirlik, görsel tasarım, dil ve erişilebilirlik incelemesi (`tasarim`)

Yöntem: Uygulama dev sunucuda (5212) açıldı. Playwright ile TR koyu 1440×900'de baştan sona kullanıldı. Seçilen ekranlar EN, açık tema ve 1100×700'de ayrıca denendi. Bütün ekran görüntüleri `/tmp/review-tasarim/` altında, bulgularda dosya adlarıyla verildi. Kontrast oranları `tokens.css` değerlerinden WCAG formülüyle hesaplandı. Hedef boyutu ve yazı boyutu çalışan sayfada DOM'dan ölçüldü.

## İlk 10 saniye

Uygulama karşılama ekranı göstermeden doğrudan "Simülatör · Tüm cihazlar" senaryosuna bağlanıyor. Hat şeması, güç özeti ve 12 kart kartı dolu ve hareketli; ilk bakışta etkileyici. Ne var ki ekranın simülasyon olduğu yalnız küçük bir "Simülatör" yazısından anlaşılıyor. Yeni gelen biri için sonraki adım da belirsiz: "Aracını kur" ya da "PID ayarla" gibi bir çağrı yok. Üstelik ESC 80A kimse sürmeden 1.200 rpm dönüyor (bkz. B1). Karşılama metni yalnız bağlantı kesildiğinde görünüyor (`35-disconnected-bus.png`).

---

## Bulgular (ekrana göre)

### Genel: sürme güvenliği

**B1 [Önemli] "Gösteri hareketi" motoru ACİL DURDUR'dan sonra da döndürüyor.**
- Ekran ve öğe: Hat ve Cihaz ekranlarında ESC 80A kartının "Hız" değeri.
- İlgili dosya: `apps/studio/src/core/connection/manager.ts` (`startAmbient`).
- Ne gördüm: İlk açılışta ESC 80A 1.200 rpm gösteriyor, faz akımı −22 A. ACİL DURDUR'a basıldıktan sonra bütün kartlarda "Acil durdurma" rozeti varken aynı kart 1.203 rpm göstermeye devam ediyor. Bir yatırımcı ya da mentor bunu "acil durdur çalışmıyor" diye okur.
- Kanıt: `01-first-5s.png`, `33-estop.png`, `90-en-tuner.png`.
- Düzeltme: ACİL DURDUR'da ve sürme oturumu açılınca `setAmbient(false)` çağrılsın. Gösteri dönüşü motor miline değil, yalnız encoder'ın bağlı olduğu ayrı bir mile uygulansın. Gösteri açıkken Hat başlığına "Gösteri hareketi: mil dışarıdan çevriliyor" rozeti konsun.

**B2 [Önemli] Cihaz › Eylemler'deki iki eylem motoru sürme etkinleştirmesi olmadan döndürüyor.**
- Ekran ve öğe: "Motor yönünü algıla" ve "Motor parametrelerini ölç".
- İlgili dosya: `features/device/tabs/DiagnosticsTab.tsx` (`action.confirm` → yalnız modal onay).
- Ne gördüm: Bu iki eylemin tek güvencesi bir onay penceresi. Basılı tutarak etkinleştirme, sürme oturumu ya da "Sürüş etkin" göstergesi yok. Uygulamanın başka her yerinde hareket için 1 s basılı tutma isteniyor.
- Kanıt: `63-action-confirm.png`. Kodda `useDriveSession` kullanılmıyor (grep ile doğrulandı).
- Düzeltme: Bu eylemleri `useDriveSession('device')` + `ArmButton` arkasına alın. Onay penceresine "Mekanizmayı serbest bırakın, teker yerden kesik olsun" uyarısını ekleyin.

**B3 [Önemli] "Sürüş etkin" çerçevesi yalnız Tuner'de var.**
- Ekran ve öğe: Araç › motor testi ve Cihaz › Kontrol.
- İlgili dosyalar: `features/vehicle/MotorTest.tsx` (DriveBanner yok), çerçeve stili yalnız `tuner.css` `.tuner.is-armed` içinde.
- Ne gördüm: Araç ekranında sürme etkinken tek işaret üst çubuktaki küçük "Sürüş etkin" hapı. `docs/TUNER.md` §1 "etkinken ekranın çerçevesi belirgin renk alır" diyor.
- Kanıt: `11-armed.png` ile `42-tuner-armed.png` karşılaştırması.
- Düzeltme: Çerçeve ve şerit `Shell` düzeyinde `useDrive().armed` ile verilsin (her ekranda aynı görünüm). `MotorTest`'e `DriveBanner` eklensin.

**B4 [Önemli] Tuner'in varsayılan testi yeni başlayan için fazla agresif.**
- Ekran ve öğe: Tuner › Test sinyali (Kol eklemi tezgâhı).
- İlgili dosya: `features/tuner/controller.tsx:125` (`maxAmplitude * 0.4`).
- Ne gördüm: Kol tezgâhı açılınca Akım döngüsü seçili geliyor ve basamak B = 50 A. Bu, 100 A sınırın %40'ı. Etkinleştirip Enter'a basan acemi, yerçekimli kola 50 A basamak uyguluyor; ben de böyle koştum. Volan için açık döngü karakterizasyonu da motoru iki yönde ±2.000 rpm'e çıkarıyor, ama "Çalıştır" düğmesi bunu önceden söylemiyor.
- Kanıt: `51-arm-pos.png`, `54-report.png`, `48-ff-result.png`.
- Düzeltme: İlk koşu sınırın %10'u olsun, sonra kademeli büyüsün. Senaryoda/şablonda konum encoder'ı varsa Konum döngüsü seçili açılsın. Karakterizasyon kartına "≈12 s, iki yönde en çok 2.000 rpm" özeti eklensin.

### Hata ve sınır durumları

**B5 [Önemli] Hat kısa devresinde uygulama yeşil "BAĞLI" kalıyor ve tanı vermiyor.**
- Ekran ve öğe: Hat ekranı, üst çubuk, durum çubuğu.
- Ne gördüm: Kısa devrede çerçeve/s 1'e, kart sayısı 0'a düşüyor ama bağlantı noktası yeşil kalıyor. "Sonlandırma: 2 × 120 Ω" rozeti de yeşil kalıyor. Güç özeti paneli kayboluyor ve düzen zıplıyor. "Kısa devre" metni yalnız simülatörün açılır penceresinde var (`app/BusHealth.tsx:76`).
- Kanıt: `32-short.png`.
- Düzeltme: Bütün kartlar aynı anda kaybolur ve çerçeve/s ≈ 0 olursa Hat ekranının üstünde kırmızı bir bant gösterin: "Hattan çerçeve gelmiyor: CAN_H/CAN_L kısa devre, kopuk kablo ya da adaptör". Altına üç maddelik bir kontrol listesi koyun, durum çubuğu noktasını kırmızıya çevirin. Güç özeti panelinin yeri korunsun, içinde "veri yok" yazsın.

**B6 [Önemli] Tek kart kaybı sessiz geçiyor.**
- Ekran ve öğe: Hat › kart kartı ve sayaç.
- Ne gördüm: Kablosu çekilen ESC 80A yalnız soluklaşıyor ve gri "Çevrim dışı" yazısı alıyor; toast ya da renk uyarısı yok. Başlık "12/12 kart" derken durum çubuğu "11 kart" diyor.
- Kanıt: `30-cable-pulled-bus.png`.
- Düzeltme: Kayıp kartın kenarı turuncu/kırmızı olsun ve "Kayıp · 3 s önce" yazsın. Tek seferlik bir toast gösterilsin. Sayaç "11/12 çevrimiçi" biçimine geçsin.

**B7 [Önemli] Sigorta atması ile o kanaldan beslenen kartın kaybı birbirine bağlanmıyor.**
- Ekran ve öğe: Hat › Güç dağıtım kartı ve ESC 20A kartı.
- Ne gördüm: Güç dağıtım kartında "Sigorta attı" yazıyor ama hangi kanal olduğu yok. Aynı anda kaybolan ESC 20A'nın nedeni gösterilmiyor; kullanıcı iki ayrı sorun sanıyor.
- Kanıt: `31-fuse.png`.
- Düzeltme: Güç özetinde K1 sütunu kırmızı ve "Sigorta" etiketli olsun. Kayıp kartta "Olası neden: Güç dağıtım K1 sigortası attı" yazsın (simülasyondaki besleme eşlemesi ya da Araç yapılandırması kullanılabilir).

**B8 [Önemli] Kalabalık hatta (62 kart) aşırı yük "kayıp kart" gibi görünüyor.**
- Ekran ve öğe: Hat ekranı, üst çubuk.
- Ne gördüm: Yük %99, "205 zaman aşımı". 10 kart "kayıp" görünüyor ama aslında çerçeve alamıyor. Otomatik çöz 50 karttan birini çözemedi. Kullanıcıya yük için açıklama ya da öneri verilmiyor.
- Kanıt: `103-crowded-bus.png`, `103b-crowded-scroll.png`.
- Düzeltme: Yük %80'i geçince Hat bandında "Hat doymuş: STATUS/akış hızlarını düşürün" yazsın ve tek tıklık bir eylem sunulsun. Zaman aşımına uğrayan kart "kayıp" değil "yanıt gecikiyor" olarak gösterilsin.

### Hat ekranı

**B9 [Küçük] Çözülmemiş kartlarda önerilen numaralar birbirleriyle çakışıyor; liste sayfayı kaplıyor.**
- Ne gördüm: Fabrika senaryosunda iki ESC 80A'ya da "1" öneriliyor. 50 kartta her satıra "3" yazılmış; tek tek "Ata" denirse çakışma üretiliyor. 50 satırlık liste katlanmıyor.
- Kanıt: `03-fresh.png`, `100-crowded.png`.
- İlgili dosya: `features/bus/Unresolved.tsx`.
- Düzeltme: Önerileri birbirine göre dağıtın (ilk boş, sonraki boş, …). 8 satırdan sonra "+42 kart daha · Otomatik çöz" diye katlayın.

**B10 [Küçük] Hat şemasında ham model anahtarları ve kesik adlar var.**
- Ne gördüm: Model anahtarları (`PDH_LARGE`, `SOC_REG`, `CYNCODER_V3`, `SEALED_SERVO`) 8,5 px yazıyla gösteriliyor. Adlar "Sızdırmaz …", "Cyncoder 1…" diye kesiliyor ve üzerine gelince tam ad görünmüyor.
- Kanıt: `01-first-5s.png`.
- İlgili dosya: `features/bus/BusDiagram.tsx`.
- Düzeltme: Kod yerine katalogdaki kısa adı yazın. Ad iki satıra sarsın, `title` niteliğiyle tam ad gösterilsin.

### Araç ekranı

**B11 [Önemli] Swerve şemasında öğeler üst üste biniyor (bilinen sorun doğrulandı).**
- Ekran ve öğe: Galeri küçük resmi, atama şeması, canlı görünüm.
- İlgili dosya: `features/vehicle/VehicleDiagram.tsx`.
- Ne gördüm: Teker yön oku "Sürüş" simgesinin ve numara rozetinin üstüne biniyor. "Arka sol" / "Arka sağ" etiketleri okla çakışıyor. Modüller şase kenarına taşıyor. Canlı görünümde "0 rpm" yazıları teker çizimine biniyor.
- Kanıt: `06-vehicle.png`, `07-assign.png`, `24-live.png`.
- Düzeltme: Ok modül kutusunun dışına, köşe etiketi kutunun altına taşınsın. Yuvalar arası en az 44 px bırakılsın. Canlı değerler simgenin altına ayrı satıra yazılsın. Kol ve Ackermann şemalarına en küçük ölçek verilsin.

**B12 [Önemli] Swerve kurulumunda motor testi sonucu sorulmuyor ve encoder ofseti adımı yok.**
- Ekran ve öğe: Kartları ata › Motor testi; Yön ve ayarlar adımı.
- Ne gördüm: "1 s döndür" çalışıyor, ama ardından "Doğru teker mi döndü? Yön doğru mu?" diye sorulmuyor. Uygulamadan sonra canlı görünümde dört modül 75°, 88°, 313° ve 241° gösteriyor. Tekerleri düz hizalayıp ofset kaydetme adımı yok; swerve'ün en kritik kurulum adımı eksik.
- Kanıt: `11-after.png`, `24-live.png`.
- Düzeltme: Testten sonra "Evet / Ters döndü / Başka teker döndü" düğmeleri çıksın; "Ters döndü" seçilince "Yön çevir" işaretlensin. 3. adıma "Tekerleri ileri hizalayın → Ofsetleri kaydet" adımı eklensin.

**B13 [Küçük] Sihirbazda akış pürüzleri var.**
- "Yön ve ayarlar" ileri düğmesi 900 px yükseklikte ekranın altında kalıyor (`19-all-assigned.png`).
- "Sırayla ata" ipucu motor yuvasında da "encoder'ı çevirin / gyroyu eğin" diyor (`15-sequential.png`).
- Değişiklik listesi yuva sırasına göre dizilmemiş: "Ön sol · dönüş" önce, "Ön sol · sürüş" sonda (`22-step4.png`).
- Başarı ekranı büyük boş bir panel ve mavi bir ikondan ibaret (`23-applied.png`).
- Motor testi metni "Önce kolu basılı tutarak…" diyor; "kol" robot koluyla karışıyor.
- Düzeltme: Alt gezinme çubuğu yapışkan olsun. İpucu yuvanın rolüne göre seçilsin. Liste yuva sırasıyla dizilsin. Başarı ekranında yeşil onay ve doğrudan canlı şema gösterilsin. Metin "'Basılı tut: etkinleştir' düğmesini 1 s basılı tutun" olsun (`features/vehicle/messages.ts`).

**B14 [Küçük] Gövde yönü pusula harfleriyle (K/D/G/B) gösteriliyor.**
- Ekran ve öğe: Araç canlı görünümü ve Cihaz › Jiroskop görünümü.
- Ne gördüm: Gyro yaw değeri manyetik kuzeyi bilmez. Robot için "Kuzey" demek yanıltıcı; "B" ve "D" harflerinin ne olduğu da açıklanmıyor.
- Kanıt: `24-live.png`, `60-gyro-genel.png`.
- Düzeltme: Ön/Sağ/Arka/Sol ya da 0°/90°/180°/270° kullanın.

### Tuner

**B15 [Önemli] Ölçüt renkleri hedefe ulaşmayan yanıtı "iyi" gösteriyor.**
- Ekran ve öğe: Ölçütler sekmesi.
- Ne gördüm: Volan hedefin yalnız %44'ünde kaldı (kalıcı hata %56). Buna rağmen yükselme, oturma, sönüm ve doygunluk yeşil. IAE/ITAE değerleri birimsiz ve dört ondalıklı ("3.844,0376").
- Kanıt: `45-metrics.png`.
- Düzeltme: Kalıcı hata %10'u geçerse zaman ölçütleri gri "—" olsun ve üste "Hedefe ulaşmadı" özeti gelsin. IAE'ye birim eklensin, değer 3 anlamlı basamağa yuvarlansın.

**B16 [Önemli] İpuçları ve Yardımcı sekmesi PID'i yeni öğrenen için uygulanabilir değil.**
- Ne gördüm:
  - "Kalıcı hata var: Ki ekleyin veya kV'yi düzeltin" ipucu, kV = 0 iken ne yapılacağını söylemiyor.
  - Konum ipucunda ham anahtar geçiyor: "pos.tolerance_rot".
  - Kol için yerçekimi telafisinden hiç söz edilmiyor; kalıcı hata %85.
  - Yardımcı sekmesi formül (`V = kS·sgn(ω)…`), "SIMC", "Åström–Hägglund" ile açılıyor ve hangi aracın önce çalıştırılacağını söylemiyor.
- Kanıt: `45-metrics.png`, `57-pos-metrics.png`, `46-assist.png`.
- İlgili dosyalar: `features/tuner/messages.ts:198`, `features/tuner/suggest.ts`.
- Düzeltme: Her ipucuna bir eylem düğmesi koyun ("İleri beslemeyi ölç →"). Parametre adı katalog etiketinden gelsin. Mekanizma türüne göre "önerilen sıra: 1 → 2" rozeti gösterilsin. Formül "ayrıntı" açılırının içine alınsın.

**B17 [Küçük] Döngü notu belgeyle uyuşmuyor ve jargonlu.**
- Ne gördüm: "Döngüler kademeli değil: her biri çıkışı (V) doğrudan üretir." `TUNER.md`'deki "önce iç döngü" ipucunun yerinde duruyor ve acemiye bir şey anlatmıyor.
- Düzeltme: "Bu kartta her kip tek döngüdür; sürmek istediğiniz kipin döngüsünü ayarlayın." (`features/tuner/messages.ts:29`)

**B18 [Küçük] Grafikler zor okunuyor.**
- Ne gördüm:
  - Dikey yazılan "V" birimi ">" gibi okunuyor (Çıkış grafiği, Döngü çıkışı).
  - Y ekseni tık değerleri 0,025 adımın iki ondalığa yuvarlanmasıyla "0,00 / 0,03 / 0,05 / 0,08" gibi eşit aralıklı görünmeyen sayılara dönüşüyor.
  - Koşu tablosu sağdan kesiliyor ("%85,59 0").
- Kanıt: `41-tuner-vel.png`, `45-metrics.png`, `57-pos-metrics.png`.
- İlgili dosya: `ui/chart/`.
- Düzeltme: Birim eksenin tepesine yatay yazılsın. Tık adımı 1-2-5 kuralıyla seçilsin ve ondalık sayısı adıma göre belirlensin. Tablo yatay kaydırılabilsin.

**B19 [Küçük] Bazı alanlarda birim yok.**
- Alanlar: "EN BÜYÜK AÇIK DÖNGÜ 0,50", "RÖLE GENLİĞİ 0,150", "PERİYOT 6" (`41-tuner-vel.png`, `46-assist.png`).
- Düzeltme: Birim ya da açıklama ekleyin: "görev oranı", "V", "periyot sayısı".

**B20 [Küçük] Ayar raporu sade ve ham anahtarlar taşıyor.**
- Ne gördüm: Rapor takımın teknik raporuna ya da yatırımcıya gidecek ama logo, takım/proje adı ve notlar yok; sistem yazı tipiyle basılıyor. Sütun başlıkları ham ("kp", "ki", "Doyg."). Uygulamadaki "Koşunun kazançları" bölümü de `kp, iMax, outMax` gösteriyor; arayüzde bunların etiketi "Kp", "Imax", "Omax".
- Kanıt: `54-report.png`, `45-metrics.png`.
- İlgili dosyalar: `features/tuner/report.ts`, `RightColumn.tsx`.
- Düzeltme: Rapora logo, takım adı ve not alanı eklensin; Lato gömülsün. Başlıklar katalog etiketlerinden gelsin.

### Cihaz ekranı

**B21 [Küçük] Dil ve hizalama kusurları.**
- "onaylı" rozeti aslında "onay ister" demek istiyor; "onaylı" Türkçede "onaylanmış" anlamına gelir (`features/device/messages.ts:313`).
- Jiroskop rozeti "Kalibre" diyor; Türkçede bu "çap" anlamına gelir. "Kalibre edildi" olmalı.
- "Görev oranı 0 %" yazıyor; uygulamanın geri kalanında yüzde "%0" biçiminde.
- Genel sekmesindeki göstergelerde "BESLEME AKIMI" ve "FET SICAKLIĞI" etiketleri ölçek uç sayılarına (150, 120) biniyor.
- Kanıt: `61-esc-Eylemlerve.png`, `60-gyro-genel.png`, `60-esc-genel.png`.

**B22 [Küçük] Ayar formunda boş durum ve çıkmaz sokak var.**
- Her satırda ham anahtar (`motor.pole_pairs`) varsayılan olarak görünüyor; acemi için gürültü.
- Arama sonuçsuz kalınca boş durum mesajı çıkmıyor; yalnız alt çubuk kalıyor (`w4c-err.png`'deki görünüm).
- Aynı modelden başka kart yokken "Diğer kartlara kopyala" penceresi açılıyor ve "0 yazma yap" düğmesi gösteriyor (`67-copy.png`).
- Üstte "Kayıtlı" rozeti dururken altta "1 uygulanmamış değişiklik" yazıyor; durum iki yerden, iki ayrı dille anlatılıyor (`64-dirty.png`).
- Düzeltme: Anahtarlar "Gelişmiş" görünüme alınsın. "Aramaya uyan ayar yok" boş durumu eklensin. Kopyala düğmesi bu durumda pasif olsun ve ipucu versin; düğme metni "{n} karta yaz" olsun. Durum tek bir rozette birleşsin.

### Dil, terim ve biçim (genel)

**B23 [Önemli] Sayı ve birim biçimi tutarsız.**
- İngilizce arayüzde üst çubuk yükü "%28" gösteriyor (`app/BusHealth.tsx:46,62` sabit `%`) → `90-en-tuner.png`.
- CAN İzleyici "YÜK 20,0 %" ve dağılımda "83%" yazıyor; üst çubuk ise "%20".
- CAN İzleyici çözülmüş sütununda Türkçe arayüzde nokta ondalık kullanılıyor: "1206.2 rpm", "139.48°", "5.01 V" (`packages/protocol/src/host/describe.ts`) → `71-canmon.png`.
- Açısal hız birimi üç biçimde: "dps" (katalog), "°/sn" (Cihaz açıklaması), "°/s".
- Süre birimi Firmware'de "sn", başka yerlerde "s".
- Düzeltme: Tek bir `fmtPercent` / `fmtNumber` (dile duyarlı) kullanılsın ve `describe` buna bağlansın. Katalog birimi "°/s", süre her yerde "s" olsun.

**B24 [Küçük] Aynı şeye farklı adlar; ayarlar yanlış yerde.**
- Aynı kavramlar farklı adlarla geçiyor:
  - "Atanmamış" (Hat) ile "Numarasız" (Araç).
  - "Cyncoder 1.4 (eski protokol)" ile "Cyncoder v3 (eski protokol)" (Proje › Hat anlık görüntüsü / Koda bağlan).
  - "ACİL DURDUR", "Acil durdurma" (kart rozeti) ve "Acil durdur" (toast).
  - "Enc" ile "encoder"; "Gyro" ile "Jiroskop".
- Uygulama geneli Dil/Tema/birim ayarları "Proje › Ayarlar" sekmesinde; proje dosyasıyla ilgisi yok.
- Durum çubuğunda geliştirici rotası görünüyor ("#/bus").
- Düzeltme: `common.*` altında ortak bir terim sözlüğü kurulsun. Ayarlar üst çubuktaki dişli simgesine taşınsın. Rota gizlensin.

**B25 [Küçük] Kart adı sınırı kullanıcıya bayt olarak anlatılıyor.**
- Ne gördüm: Uzun ad yazılınca "Ad en çok 21 bayt olabilir" toast'ı çıkıyor ama giriş engellenmiyor. Kullanıcı Türkçe harflerin 2 bayt saydığını bilemez.
- Kanıt: `121-longname-bus.png`.
- Düzeltme: Alana "17/21" sayacı konsun, sınıra gelince yazma dursun. Metin "Ad çok uzun (ç, ğ, ş gibi harfler 2 sayılır)" olsun.

### Erişilebilirlik

**B26 [Önemli] Birkaç kritik renk çifti WCAG AA kontrastının altında.**

| Öğe | Renkler | Oran | AA eşiği |
|---|---|---|---|
| Koyu tema ACİL DURDUR (≈14 px kalın; "büyük metin" sayılmaz) | beyaz / `#F2685B` | 3,0:1 | 4,5:1 |
| Açık tema uyarı rozeti (11,5 px) | — | 3,4:1 | 4,5:1 |
| Açık tema "iyi" rozeti | — | 3,6:1 | 4,5:1 |
| Açık tema vurgu rengi, panel-2 üzerinde | — | 4,2:1 | 4,5:1 |

- İlgili dosya: `ui/theme/tokens.css`.
- Düzeltme: Koyu temada tehlike dolgusu `#D63F33` ya da daha koyu olsun. Açık temada uyarı `#8A6500`, iyi `#0F7A40` olsun.

**B27 [Önemli] Hedefler ve yazılar pit ortamı ve eldiven için küçük.**
- Hat ekranında 40 tıklama hedefi 28 px'in altında: TR/EN 32×20, kart üzerindeki LED/aç düğmeleri 26×26, yeniden adlandır 22×22.
- Metinlerin çoğu 10,5–11,5 px; şemadaki model kodları 8,5 px.
- 1x ekranda küçük kalın düğme yazılarında Ö ve İ noktaları seçilmiyor: "Önceki", "İptal et", "İndir" sırasıyla "Onceki", "Iptal", "Indir" gibi okunuyor. 2x'te düzgün görünüyor; neden doğrulanmadı.
- Kanıt: `16b-onceki-zoom.png`, `76-fw-progress.png`, `62-oztest-zoom.png` (2x).
- Düzeltme: `--cy-h-sm` 32 px'e çıkarılsın, `--cy-fs-xs` ≥ 12 px olsun. Ayarlara bir "Pit kipi" eklensin (hedef ≥ 44 px, taban yazı 15 px).

**B28 [Küçük] Küçük pencerede (1100×700) yerleşim ve bazı etiketler eksik.**
- Kenar çubuğu kendiliğinden daralmıyor; 207 px yer kaplıyor.
- Tuner sağ sekmeleri yalnız simgeye iniyor, etiket kalmıyor. Kazançlar paneli bir simge sekmesinin arkasına gizleniyor. Grafiklerde tek tık değeri kalıyor.
- Simülatör paneli kapat düğmesinin `aria-label`'ı "Simülatör paneli".
- Hat ve Ayarlar arama alanları yalnız placeholder ile etiketli.
- Hata enjeksiyonu seçicisi koyu temada beyaz, işletim sistemi görünümlü bir liste açıyor (`31-inject-menu.png`).
- Kanıt: `96-small-tuner.png`.
- Düzeltme: 1200 px altında kenar çubuğu daralsın. Simge sekmelerine kısa etiket ya da araç ipucu verilsin. Kapat düğmesi "Kapat" diye etiketlensin, arama alanlarına `aria-label` eklensin. Enjeksiyon için uygulamanın kendi `Select` bileşeni kullanılsın.

**B29 [Küçük] Bazı bilgiler yalnız renk ya da soluklukla veriliyor.**
- Ne gördüm: Kayıp kart yalnız soluklaşma ve kesik çizgiyle, Tuner ölçüt dereceleri yalnız nokta rengiyle ayrılıyor. Kanal akım çubuklarında eşik yok.
- Kanıt: `30-cable-pulled-bus.png`, `45-metrics.png`.
- Düzeltme: Duruma bir simge ya da metin eklensin (✓ / ! / ×, "Kayıp"). Ölçüt satırına "iyi/orta/kötü" kısa etiketi yazılsın.

**B30 [Küçük] Simülatör olduğu ilk açılışta belirgin değil; yeni gelene ilk adım önerilmiyor.**
- Ne gördüm: Karşılama ekranı yalnız bağlantı kesilince görünüyor. İlk açılışta otomatik demo başlıyor ve "Bu bir simülasyon · Aracını kur / PID ayarla" gibi bir yönlendirme yok.
- Kanıt: `01-first-1s.png`, `35-disconnected-bus.png`.
- İlgili dosyalar: `core/connection/manager.ts`, `features/bus/Welcome.tsx`.
- Düzeltme: İlk açılışta Hat ekranının üstünde kapatılabilir bir şerit gösterin: "Simülatördesiniz. 1) Araç kur 2) Volanı ayarla 3) Gerçek adaptöre bağlan".

---

## Yatırımcı demosu: en zayıf 5 an ve en az işle düzeltme

1. **ACİL DURDUR'dan sonra motor 1.200 rpm göstermeye devam ediyor (B1).** Düzeltme: ESTOP'ta gösteri hareketini kapatmak (tek satır).
2. **Kısa devre, kart kaybı ve sigorta durumlarında ekran yeşil ve sessiz (B5–B7).** Düzeltme: "Hat sessiz / kart kayıp / sigorta → etkilenen kart" bandı ve toast. Bu durumlar senaryo olarak gösterildiğinde en güçlü satış anı olabilir.
3. **Swerve şemasında çakışmalar ve boş başarı ekranı (B11, B13).** Düzeltme: ok ve etiket yerleşimi; başarıdan sonra doğrudan canlı şemaya geçiş.
4. **Tuner ölçütleri yeşil ama hedefe ulaşılmamış; ipuçları jargonlu (B15, B16).** Düzeltme: "Hedefe ulaşmadı" özeti ve "İleri beslemeyi ölç →" düğmesi.
5. **Rapor çıktısı logosuz ve sade (B20).** Düzeltme: başlığa logo, takım adı ve not alanı.

## En güçlü 3 an

1. **Tuner'de sürme deneyimi.** Basılı tutarak etkinleştirme, ardından tüm ekranı saran kırmızı şeritli çerçeve. 1·2·3 rehber kartları, koşu şeridi, üst üste karşılaştırma ve "öngörü · öneri" eğrisi (`42-tuner-armed.png`, `48-ff-result.png`).
2. **Araç sihirbazı.** "Geçici numara ver" ve "elle çevir, bulsun" kartı otomatik buluyor (`17-detect2.png`). Yuva sırasıyla atama, fark listesi ve 14 kartı tek tıkla yazma.
3. **Fabrika kartlarının çözülmesi ve toplu firmware.** Otomatik çözde önizleme ve satır satır onay (`05-resolved.png`); firmware'de satır başına hız ve süre gösteren ilerleme (`76-fw-progress.png`).

## İyi olanlar

- Boş durumlar genel olarak tasarlanmış (Grafik, Proje, Firmware). Karşılama metni anlaşılır.
- İngilizce arayüzde ham anahtar ya da çevrilmemiş metin bulunmadı. Görülen Türkçe yalnız kullanıcı adları ve yarışma özel adları.
- Klavye odak halkası bütün üst çubuk ve gezinme öğelerinde görünüyor; etiketsiz düğme yok (DOM taraması: 0).
- ACİL DURDUR kilidi her ekranda belirgin ve "Kilidi kaldır" akışı açık (`34-tuner-estop.png`).
- `prefers-reduced-motion` stilleri ana CSS dosyalarında tanımlı (çalışma anında denenmedi).

## Bakmadıklarım

- 25 kartlı araç (bu sayıda yuvası olan hazır şablon yok; özel şablonla kurmadım).
- Grafik tetik/kayıt/CSV dışa aktarma; Bode/Frekans sekmesi.
- Proje "Hattı oku → kaydet → karşılaştır → geri yükle" akışı (yalnız sekmeleri gezdim).
- Ekran okuyucuyla gerçek deneme; azaltılmış hareketin çalışma anında etkisi.
- Tauri masaüstü kabuğu.
- 1x ekranda Ö/İ noktalarının kaybolmasının kesin nedeni (doğrulanmadı).
