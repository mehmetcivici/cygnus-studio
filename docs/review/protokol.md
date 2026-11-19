# CyCAN protokol uyumu ve C kütüphanesi incelemesi (`protokol`)

Kapsam: `docs/PROTOCOL.md` ↔ `packages/protocol/src/core` ↔ `packages/simulator/src/node.ts` (+ `params.ts`, `devices/*`) ↔ `firmware/cycan` ↔ `packages/protocol/src/host`.
Depoya dokunulmadı. Bütün deneme kodu `/tmp/review-protokol/` altında:

- `cycan/`: firmware'in kopyası; `make test` burada çalıştı (31/31 test, 1728 denetim geçti).
- `probe/probe.c`, `p4.c`, `p6.c`, `p6b.c`: C bulgularını yeniden üreten sondalar.
- `probe/fuzz.c`: rastgele çerçeve fuzz'ı, ASan ve UBSan ile.
- `bridge/bridge.c` + `ts/xcompat.ts`, `ts/xcompat2.ts`: **gerçek C kütüphanesi ↔ host `CygnusBus`** köprüsü (stdin/stdout).
- `ts/simdiff.ts`, `ts/renumber.ts`, `ts/estop2.ts`: simülatör ve host sondaları.
- `ts/load.ts`: hat yükü hesabı.

Çalıştırma: `cd /home/claude/cygnus-studio && node_modules/.bin/tsx /tmp/review-protokol/ts/<betik>.ts`.

Çapraz uyum sonucu (`xcompat.ts`): C düğümü ile host'un tam akışı **ilk denemede çalıştı**. Akış şunlardı:

- keşif ve ASSIGN_ID,
- INFO,
- GET/SET, readAll, SAVE ve ad,
- 1 kHz FD akış (2546 örnek, kayıp 0),
- CTRL ve zaman aşımı,
- ESTOP/CLEAR,
- FW güncelleme: FD ve klasik, parametreler korunarak.

Ayrışmalar aşağıdadır.

---

## Bulgular (önem sırasıyla)

### 1. [Kritik] Numara değişince host'un kontrol döngüsü eski adrese CTRL göndermeyi sürdürüyor, o numarayı alan başka kartı sürüyor
**Yer:** `packages/protocol/src/host/cycan/control.ts:27-34, 101-105` (çerçeve adresiyle birlikte bir kez kodlanıp tekrar tekrar gönderiliyor) · `host/cycan/device.ts:202-216` (`applyEnum` numara değişiminde `reindex` yapıyor ama `control.halt()` çağırmıyor).

**Ne yanlış:** Oturum, `start()` anında kodlanmış çerçeveyi saklıyor. Kart yeniden numaralanırsa döngü eski `(DEVTYPE, NUM)` adresine göndermeye devam ediyor. O numarayı alan kart, başka bir motor olsa bile, bu komutla sürülüyor. `assignId` sürülen kart için de bir engel koymuyor.

**Kanıt:** `ts/renumber.ts` (simülatör + gerçek host).
1. A #3'te `duty 0.3` ile sürülüyor.
2. `assignId(A,7)` ve ardından `assignId(B,3)` çalıştırılıyor.
3. Çıktı: `A(#7) enabled=false B(#3) enabled=true loopActive=true`.

**Düzeltme:**
- `applyEnum` içinde `num`/`devType` değişince `control.halt()` ve `stream.halt()` çağrılsın. `CyCanControl.tick` de adresi her gönderimde yeniden kodlasın.
- `assignId`, hedef kartın ya da hedef numaradaki kartın `control.active` olduğu durumda `BUSY` ile reddetsin.
- Bunun için bir bütünleşik test eklensin.

### 2. [Kritik] Tip yayını CTRL (kendi DEVTYPE + NUM=0) C'de, her iki yayın biçimi simülatörde kabul ediliyor (§7'ye aykırı)
**Yer:**
- `firmware/cycan/src/cycan_node.c:678-684`: yalnız `DEVTYPE==0` reddediliyor.
- `packages/simulator/src/node.ts:594-599`: hiç yayın denetimi yok.
- `firmware/cycan/README.md` da yalnız "DEVTYPE 0 yayını"ndan söz ediyor.

**Ne yanlış:** §7 şunu söylüyor: "yayın (`NUM = 0` veya `DEVTYPE = 0`) CTRL çerçeveleri yok sayılır". Oysa tek bir `ESC/0` çerçevesi hattaki tüm ESC'leri sürüyor. Simülatör `DEVTYPE=0, NUM=0` çerçevesini de kabul ediyor.

**Kanıt:**
- `probe/probe.c` P1: `ctrl_calls=1 driving=1`.
- `ts/simdiff.ts` (a): her iki biçimde `enabled=true`.

**Düzeltme:** `cycan_node.c:680` koşulu `CYCAN_ID_NUM(id)==0 || DEVTYPE==0` olsun. `SimNode.receive` içinde `idNum(id)===0` ise CTRL yok sayılsın. İki tarafa da test eklensin.

### 3. [Önemli] C'de CTRL bekçisini her CTRL çerçevesi besliyor (bozuk/bilinmeyen indeks dahil); eyleyici son hedefte süresiz kalabiliyor
**Yer:** `cycan_node.c:681-684`. Karşılaştırma: simülatör `node.ts:595` yalnız `onCtrl()` geçerli derse bekçiyi besliyor.

**Ne yanlış:** `ctrl_last`, uygulamanın çerçeveyi geçerli bulup bulmamasından bağımsız olarak yenileniyor. Uygulama bozuk çerçeveyi (len=0, CTRL/5) yok sayıp son geçerli hedefi koruyor. Hatta biri bu adrese çöp CTRL gönderiyorsa `ctrl.timeout_ms` hiçbir zaman dolmuyor.

**Kanıt:** `probe.c` P2. Bir geçerli CTRL'den sonra 2 s boyunca 50 ms'de bir boş CTRL/5 gönderildi: `neutral_calls=0 still_driving=1`.

**Düzeltme:** `ctrl` geri çağrısı `bool` dönsün; bekçi yalnız `true` dönünce yenilensin. README'deki sözleşme ve testler buna göre güncellensin.

### 4. [Önemli] C'de ESTOP ile CLEAR_ESTOP'un sırası tersine dönebiliyor: son gelen ESTOP olsa da kart kilitsiz kalıyor
**Yer:** `cycan_node.c:836-840` (ESTOP halkanın dışında bir bayrak), `868-871` (bayrak halkadan önce işleniyor), `506-509` (CLEAR_ESTOP halkadan geliyor).

**Ne yanlış:** Bir poll periyodu içinde önce CLEAR_ESTOP, sonra ESTOP gelirse şu oluyor:
1. Bayrak önce mandallanıyor.
2. Ardından halkadaki daha eski CLEAR_ESTOP kilidi açıyor.

Pencere normalde 1 ms. Flaş silme gibi duraksamalarda 22 ms ve üstüne çıkıyor.

**Kanıt:** `probe.c` P3: `estop_latched=0`, ardından `CTRL accepted: driving=1`.

**Düzeltme:** ISR'de bir `estop_seq` sayacı artırılsın ve her halka girdisine o anki değer damgalansın. CLEAR_ESTOP yalnız damgası güncel `estop_seq`'e eşitse uygulansın. Bayrak hemen mandallanmaya devam etsin.

### 5. [Önemli] Host, karta dışarıdan ESTOP gelince ya da kart yeniden başlayınca kontrol döngüsünü kesmiyor; kart eski hedefe kendiliğinden dönüyor
**Yer:**
- `host/cycan/device.ts:226-259`: `applyHeartbeat` durum ESTOP/BOOT/FAULT olduğunda `control.halt()` çağırmıyor.
- `host/bus.ts:272`: döngüleri yalnız kendi `bus.estop()` çağrısı kesiyor.

**Ne yanlış:**
- ESTOP başka bir düğümden (roboRIO, ikinci Studio) gelirse döngü CTRL göndermeyi sürdürüyor. Biri `clearEstop()` yapınca motor hemen eski hedefle dönüyor.
- Kart sıfırlanınca (brown-out, watchdog, REBOOT) da aynı şey oluyor. §4.1 BOOT kalp atışı gelse bile host'ta halt yolu yok.

**Kanıt:** `ts/estop2.ts`.
- `ESTOP from another node: state=5 … loopActive=true`
- `after clearEstop(): enabled=true`
- `after board reset during loop: enabled=true loopActive=true`

**Düzeltme:**
- Heartbeat'te `state ∈ {ESTOP, BOOT, BOOTLOADER, FAULT}` ise ya da `ENABLED` kendiliğinden düşerse `control.halt()` çağrılsın.
- §7'ye bir "silahlandırma" kuralı eklensin: ESTOP temizlendikten, CTRL zaman aşımından ya da açılıştan sonra kart, sürmeye ancak önce bir nötr komut görünce başlasın.

### 6. [Önemli] C, sürülürken SAVE_PARAMS'a izin veriyor (bloklayan flaş silme); simülatör DENIED dönüyor; belge sessiz
**Yer:** `cycan_node.c:491-493`. Karşılaştırma: `node.ts:809-810`. İlgili: `examples/.../cycan_port_stm32g4.c:163-164`; yorum, sürülürken silme olmayacağını *varsayıyor*.

**Ne yanlış:** G431 tek bank. Silme sırasında (~22 ms) flaştan koşan her kod duruyor, ESC'nin akım/komütasyon kesmesi de buna dahil. Kalıcı ASSIGN_ID aynı numarayla gelirse sürülen kartta da silme yapılıyor (`on_assign` → `identity_save`).

**Kanıt:** `simdiff.ts` (b): simülatör `status=4`, C kodu `OK` dönüyor.

**Düzeltme:**
- C'de `enabled` iken `SAVE_PARAMS` ve kalıcı `ASSIGN_ID` `DENIED` dönsün.
- §4.5'teki listeye `SAVE_PARAMS` eklensin.

### 7. [Önemli] Bootloader: END'den (ya da REBOOT'tan) sonraki 5 ms içinde gelen BEGIN, silme/alma sürerken `start_app`'i tetikliyor
**Yer:** `cycan_boot.c:139-159` (`on_begin`, `start_pending`'i temizlemiyor), `444-447`.

**Ne yanlış:** Silinmiş imajla `start_app` çağrılıyor. Örnek port (`bootloader_main.c:82-87`) sıfırlayıp imajı yeniden doğruladığı için orada yalnızca güncelleme bölünüyor. Doğrudan zıplayan bir port ise silinmiş flaşa atlar.

**Kanıt:** `probe/p4.c` P4: `BEGIN 1 ms later: state=2 app_starts=1 image_valid=0`.

**Düzeltme:**
- `on_begin` içinde `start_pending=false` yapılsın.
- DONE durumunda BEGIN'e `WRONG_STATE` dönülsün.
- `start_app` öncesinde `state==DONE || image_valid` koşulu aransın.

### 8. [Önemli] Bootloader uygulamayı başlığı görmeden siliyor: yanlış modelin imajı (aynı DEVTYPE: ESC20A↔ESC80A) kartı uygulamasız bırakıyor
**Yer:** `cycan_boot.c:157, 419-428` (BEGIN'de silme), `201-205` (başlık denetimi silmeden sonra yapılıyor). Simülatörde de aynı: `node.ts:1018`.

**Ne yanlış:** Studio imajı önceden doğruluyor (`firmware.ts:82`). Ama üçüncü parti bir araç, hatalı bir toplu güncelleme ya da kötü niyetli bir düğüm, tek BEGIN ile uygulamayı siliyor. Kart bootloader'da kalıyor; kurtarılabilir ama sahada çalışmaz hale geliyor.

**Kanıt:** `p4.c` P4b: geçerli imaj kurulu. ESC20A imajı Cyncoder'a gönderiliyor. Sonuç: `state=0 valid_image_left=0`.

**Düzeltme:**
- İlk 64 bayt RAM'e alınsın. `check_header` ve `size==64+payload_size` denetimi **silmeden önce** yapılsın.
- Akış şöyle olsun: BEGIN → `OK`; başlık DATA'ları; ardından `BUSY` + silme. Belgeye (§9) yazılsın.

### 9. [Önemli] CRC'si geçerli ama açılmayan uygulamadan kurtulma yolu yok (SWD'siz tuğla)
**Yer:** `firmware/cycan/examples/stm32g431_cyncoder/bootloader_main.c:119`. README'deki "Açılışta…" bölümü de aynı tasarımı anlatıyor.

**Ne yanlış:** Bootloader'a girmenin tek yolu uygulamanın `ENTER_BOOTLOADER` işlemesi. CAN'i açmadan çöken ya da kilitlenen bir sürüm (yanlış saat ayarı, HardFault) her açılışta yeniden çalışıyor. Bu durumda kart hat üzerinden kurtarılamıyor.

**Kanıt:** Kod okuması (donanımda doğrulanmadı).

**Düzeltme:**
- Uygulama başarılı açılışı onaylasın: RTC yedek yazmacında bir deneme sayacı tutulsun, N başarısız açılıştan sonra bootloader'da kalınsın.
- Ek olarak, açılışta 50–100 ms boyunca adrese yönelik bir "bootloader'da kal" çerçevesi dinlensin.

### 10. [Önemli] END ACK'i kaybolunca host, başarılı güncellemeyi "başarısız" raporluyor
**Yer:** `host/cycan/firmware.ts:187-196` (zaman aşımında `rewind(confirmed)` ile DATA yeniden gönderiliyor). C tarafı: DONE durumunda DATA'ya `WRONG_STATE` dönüyor ve 5 ms sonra uygulamaya geçiyor. Simülatör: END'den hemen sonra yeniden başlıyor (`node.ts:1079-1080`).

**Kanıt:** `DROP_END_ACK=1 CHUNK=classic tsx ts/xcompat2.ts`: `FAIL firmware CyError: bootloader status 6`. Kart ise yeni sürümle açılıyor.

**Düzeltme:**
- END zaman aşımında yalnız END yeniden gönderilsin.
- `WRONG_STATE` ya da sessizlik gelirse uygulamanın heartbeat'i beklensin; sürüm başlıktakine eşitse başarı sayılsın.

### 11. [Önemli] Simülatör ("referans gerçekleme") ile C kütüphanesi birçok kuralda ayrışıyor; host testleri C'nin göstermediği davranışa karşı geçiyor
Ayrıntı aşağıdaki **Uyum tablosu**ndadır. Hepsi `simdiff.ts`, `probe.c`, `p4.c` ile ya da kod okumasıyla doğrulandı. En önemlileri:

- bulgu 2 (yayın CTRL) ve bulgu 6 (SAVE DENIED),
- ASSIGN_ID'de nötr (simülatör yapmıyor),
- bootloader'da yayın FW BEGIN (simülatör kabul edip siliyor),
- atanmamış bootloader'a FW (C kabul ediyor, simülatör etmiyor),
- PARAM_CRC (simülatörde ACTIVE → `state=FAULT`; C'de WARN → `IDLE`).

**Düzeltme:** Ortak davranışlar için TS'den üretilen bir "senaryo vektörleri" dosyası hazırlansın. Bu dosya altın vektörler gibi hem `SimNode` hem C düğümü tarafından koşturulsun. Bu rapordaki köprü (`bridge.c`) temel alınabilir.

### 12. [Önemli] Klasik kipte STREAM bir poll'da k çerçeve basıyor; TX kuyruğu (4) + FIFO (3) yüzünden 8. yuvadan sonrası her örnekte düşüyor
**Yer:** `cycan_node.c:744-752` (yuva başına çerçeve, aynı poll içinde), `63-72` (kuyruk dolunca `tx_dropped++`).

**Ne yanlış:** Hat düşük yüklü olsa bile örnek, örneğin 10 yuva / 100 Hz (%14 yük), kısmen kayboluyor. Host bu yuvaları kalıcı `NaN` görüyor. `tx_dropped` hiçbir yerde bildirilmiyor.

**Kanıt:** `probe/p6b.c` (FIFO 3 çerçeve varsayımı): `tx_dropped=570` / 190 örnek, yani her örnekte 3 yuva düşüyor.

**Düzeltme:**
- Klasik akış, yuva imleciyle poll'lara yayılsın.
- Ya da klasik kipte `CYCAN_TX_QUEUE_LEN ≥ 16` olsun.
- `tx_dropped > 0` için `CAN_ERR` uyarısı verilsin.

### 13. [Önemli] Parametre bloğu tek bölgede "sil-yaz"; SAVE sırasında güç kesilirse bütün ayarlar varsayılana dönüyor ve kart aynı numarayla sürülebilir kalıyor
**Yer:** `cycan_node.c:212-254` (`cycan_save`), `803-809` (bozuksa varsayılanlar ve yalnız WARN).

**Ne yanlış:** CRC yarım bloğun yüklenmesini engelliyor (bu iyi). Ama ESC şu ayarlarla açılıyor:
- `motor.invert` varsayılanda,
- akım sınırları varsayılanda,
- kazançlar varsayılanda.

Üstelik C yalnız uyarı veriyor; robot kodu kartı ters yönde sürebilir.

**Kanıt:** Kod okuması. Torn-write davranışı `test_node.c`'deki "bozuk depolama" testiyle tutarlı.

**Düzeltme:**
- A/B iki sayfa + sıra sayacı kullanılsın; yeni kopya tamamlanıp doğrulanmadan eski silinmesin.
- En azından eyleyicilerde `PARAM_CRC` ACTIVE hata olsun ve host onaylayana dek CTRL reddedilsin (simülatör zaten ACTIVE kullanıyor).

### 14. [Küçük] STREAM `t_100us` 32 bit µs sayaç taşmasında sıçrıyor (her ~71,6 dk'da bir)
**Yer:** `cycan_node.c:737` (`(uint16_t)(now/100)`). 2³²/100 sayısı 65536'nın katı değil.

**Kanıt:** `probe.c` P5: taşma anında 10 yerine 41953 adım (≈4,2 s) sıçrama. README'deki "taşma güvenli" iddiası bu alan için geçerli değil. Host şu an kendi zaman damgasını kullandığı için etkilenmiyor; üçüncü parti tüketiciler etkilenir.

**Düzeltme:** Ayrı bir 100 µs sayacı tutulsun (`acc += now - last`).

### 15. [Küçük] C düğümünün RX halkası (8) host'un akış kurulum patlamasına ve flaş duraklamalarına dar
**Yer:** `cycan.h:41-42`. `stream.ts:117-119` 15 CONFIG + START'ı art arda gönderiyor.

**Ne yanlış:** Poll 1 kHz'de yetişiyor. Ama SAVE ya da kalıcı ASSIGN silmesi (22 ms) sırasında taşma oluyor. `rx_overruns` host'a hiç bildirilmiyor.

**Kanıt:** Kendi köprümde ilk denemede halka taştı ve yalnız 3 yuva kuruldu. Bunun üzerine `bridge.c` her çerçevede poll edecek şekilde yazıldı. Donanımda doğrulanmadı.

**Düzeltme:** Halka 16 olsun; taşmada `CAN_ERR` uyarısı verilsin. İsteğe bağlı olarak host CONFIG'leri birkaç ms'ye yaysın.

### 16. [Küçük] Örnek bootloader FD 2 Mbit/s'i sabit kodluyor; §9 "kalıcı `can.data_bitrate` ile çalışır" diyor
**Yer:** `examples/stm32g431_cyncoder/bootloader_main.c:122`.

**Not:** G4'ün FD denetleyicisi klasik çerçeveleri de alır, dolayısıyla pratikte çalışır. Ama belge ile kod çelişiyor ve 5/8 Mbit/s hatta sorun çıkar.

**Düzeltme:** Parametre sayfasından `can.data_bitrate` kaydı okunsun; bulunamazsa klasik kipe düşülsün.

### 17. [Küçük] Uzun komut sürerken gelen ESTOP: simülatör `FAILED` ile bitiriyor, C bekleyen komutu açık bırakıyor
**Yer:** `node.ts:712` ↔ `cycan_node.c:435-441`.

**Ne yanlış:** C'de `cmd_pending`, uygulama `cycan_command_finish` çağırana dek kalıyor. Host `onProgress` beklerken zaman aşımına düşebilir.

**Düzeltme:** `latch_estop`, `cmd_pending` ise `FAILED` yollasın (ya da README'de sözleşme olarak yazılsın).

---

## Protokol tasarımı bulguları (en çok 5)

### 18. [Önemli] ESTOP "mesajla dur" tasarımı: tek çerçeve, yeniden başlatmada kayboluyor, REBOOT ile ve adresli ya da yayın CLEAR ile kalkıyor
**Neden önemli:**
- Kart sıfırlanınca (brown-out tam da motor stall'ında olur) ESTOP kilidi RAM'de olduğu için gidiyor. Host ya da roboRIO o sırada CTRL gönderirse kart sürer.
- Hat bus-off olursa ya da çerçeve kaybolursa ESTOP hiç ulaşmayabilir.
- `REBOOT`, ESTOP'u da temizliyor; belge yalnız "CLEAR_ESTOP veya güç kesme" diyor.

**Öneri:**
- FRC'deki gibi pozitif bir **ENABLE** sinyali kullanılsın: yayın `SYS_REQ`, ≥10 Hz, sayaçlı. Eyleyiciler yalnız son 100 ms içinde ENABLE görmüşlerse sürsün. Açılış varsayılanı "devre dışı" olsun.
- ESTOP bunun üstünde mandal olarak kalsın. `REBOOT` ESTOP'ta reddedilsin ya da kilit kalıcı bir bayrakta tutulsun.
- Bulgu 4 ve bulgu 5 de bu modelle kendiliğinden kapanır.

### 19. [Önemli] Hat bütçesi ve öncelik: varsayılanlar 62 kartlık hatta sığmıyor; akış bir DEVTYPE'ın diğerlerini aç bırakmasına yol açıyor
**Hesap** (`ts/load.ts`, simülatörün `frameTimeUs`'u ile):
- Klasik 8 B çerçeve 142 µs.
- Varsayılan STATUS + heartbeat: ESC başına 184 çerçeve/s (%2,6), gyro %4,3, Cyncoder %2,2.
- 30 ESC tek başına hattın yaklaşık %78'i; 62 kart varsayılanlarla >%100.
- Klasik 15 yuva @1 kHz = **%213**. FD 64 B @2 Mbit/s tek örnek 347 µs, yani 1 kHz akış kart başına **%35**.

**Öncelik sorunu:** DEVTYPE kimliğin en üst bitlerinde. Akış yapan ESC (2), servo kartının (12) CTRL'ünü ve diğer tiplerin heartbeat'ini aç bırakıyor. Sonuç: kayıp sayılan kartlar ve servo CTRL zaman aşımları.

**Öneri:**
- §10'a bir hat bütçesi tablosu eklensin.
- Host akış açmadan önce tahmini yükü denetlesin (`NO_BANDWIDTH`). Klasik kipte `k × hız` için bir üst sınır konsun.
- STATUS varsayılanları düşürülsün (örn. ESC 0 numaralı çerçeve 20 ms).

### 20. [Önemli] Kimlik doğrulamasız FW güncelleme, ENTER_BOOTLOADER ve ASSIGN_ID
**Risk:** Hatta erişimi olan herkes şunları yapabilir:
- kartları bootloader'a sokup silebilir (bulgu 8),
- başka bir imaj yükleyebilir,
- ASSIGN_ID ile numaraları değiştirip CTRL'ü başka motora yönlendirebilir (bulgu 1'in kötü niyetli hali).

Bunun için hatta erişim yeterli: pit dizüstü, ele geçirilmiş bir USB-CAN ya da robot kodundaki bir hata. Yarışma hatları paylaşılmasa da yanlış bir araç bile yetiyor.

**Makul önlem:**
- `.cyfw` gövdesine **Ed25519 imzası** eklensin (64 B; başlık `reserved` alanı ya da bir kuyruk). Bootloader, ortak anahtarı kendi flaşında tutsun ve imajı ancak imza doğrulanınca geçerli saysın. Bunun bedeli ~5–8 KB'tır (monocypher). Bootloader 16 KB'lık alana sığmazsa en azından takım anahtarlı HMAC-SHA256 kullanılsın.
- `ENTER_BOOTLOADER` ve kalıcı `ASSIGN_ID`, `arg` alanında `uid16 ^ sabit` gibi bir "kasıt" değeri istesin.
- Sürüm geri alma bir bayrak gerektirsin.

### 21. [Küçük] FW DATA'da uzunluk alanı yok: FD dolgusu veri sanılıyor
**Ne yanlış:** §9 "FD: en çok 61 bayt" diyor. Ama `3+n` geçerli bir FD uzunluğu değilse (örn. n=32 → 35 → 48) dolgu baytları imaja yazılıyor (`cycan_boot.c:183-189`, `node.ts:1037-1039`). Sonuç, hatanın nedenini göstermeyen bir BAD_OFFSET/BAD_CRC döngüsü. Studio sabit 61/5 kullandığı için etkilenmiyor; üçüncü parti araçlar etkilenir.

**Öneri:** Belgeye "n+3 ∈ {8,12,16,20,24,32,48,64} olmalı" kuralı yazılsın, ya da DATA'ya bir `len` baytı eklensin.

### 22. [Küçük] Yeniden başlatma tespiti tek bir kalp atışına bağlı (§4.1 BOOT, bilinen açık)
**Ne yanlış:** Planlanan çözümde de BOOT tek bir çerçeve; kaybolursa (bus yükü, adaptör) host yeniden başlatmayı görmüyor: önbellek bayat kalıyor, kontrol yanlış durumda kalıyor (bulgu 5).

**Öneri:** Heartbeat'e (ya da INFO 0'a) her açılışta artan 4–8 bitlik bir **boot_id** eklensin. Host, değişimi kaçırılmaz biçimde görür.

---

## Uyum tablosu (kural · simülatör · C · host beklentisi)

Bilinen §4.1 BOOT açığı hariçtir. ✔ = belgeyle uyumlu.

| # | Kural (PROTOCOL) | Simülatör (`node.ts`) | C (`cycan_node.c` / `cycan_boot.c`) | Host beklentisi |
|---|---|---|---|---|
| 1 | §7 yayın CTRL yok sayılır | **İki biçim de kabul** (594) | **NUM=0 kabul**, DEVTYPE 0 ret (680) | Yayın göndermiyor |
| 2 | §7 CTRL zaman aşımı | Yalnız geçerli komut besliyor ✔ | **Her CTRL çerçevesi besliyor** (681) | Döngü `timeout/4` ✔ |
| 3 | §4.7 ESTOP kilidi, CLEAR | ✔ (APP kipinde) | ✔, ama **CLEAR/ESTOP sırası tersine dönebiliyor** | `bus.estop()` döngüleri kesiyor; **dış ESTOP'ta kesmiyor** |
| 4 | §4.5 sürülürken DENIED | REBOOT/BL/LOAD_DEF **+ SAVE** + SELF_TEST | REBOOT/BL/LOAD_DEF ✔; SELF_TEST uygulamaya bırakılmış | DENIED'i REJECTED olarak raporluyor |
| 5 | §3.3 ASSIGN_ID | Sürülen kartı **nötre almıyor**; akış yeni numarada sürüyor | Numara değişince nötr + akış durur | Döngüyü **kesmiyor** (bulgu 1) |
| 6 | §3.4 çakışma girişi | HB `len≥5`, ENUM_RSP ✔ | HB `len≥8`, ENUM_RSP ✔ | Aynı adreste iki bayraksız kartı da çözülmemiş sayıyor ✔ |
| 7 | §3.4 duyuru 0–20 ms, susma | ✔ | ✔ | ✔ |
| 8 | §4.1 HB fazı "UID'ye bağlı" | `uid48 % 51` | `uid16 % 51` | — (zararsız, ama vektör yok) |
| 9 | §4.6 sticky | WARN'lar da sticky'ye yazılıyor; CLEAR sonrası `active|warn` | WARN sticky değil (PARAM_CRC hariç); CLEAR sonrası `active` | Liste farklı görünür |
| 10 | PARAM_CRC | **ACTIVE** → `state=FAULT` | **WARN** → `IDLE+WARNING` | Durum rengi farklı |
| 11 | §5 UNSAVED | RAM≠flaş karşılaştırması | LOAD_DEFAULTS ve NAME_SET'te koşulsuz 1 | Küçük görsel fark |
| 12 | §8 bilinmeyen sid | Yuva **atanmıyor** (dizi kayar) | Yuva atanıyor, NaN | Katalogdan doğruluyor ✔ |
| 13 | §8 periyot yuvarlama | 0,5/1 ms tanecikliğe yuvarlıyor | Yalnız alt sınır | ✔ |
| 14 | §8 `t_100us` | ✔ | **u32 taşmasında sıçrıyor** | Kullanmıyor |
| 15 | §9 bootloader yanıt kümesi | ✔ | ✔ | ✔ |
| 16 | §9 bootloader REBOOT, imaj yok | `OK` + yeniden bootloader | `FAILED` | Ayrım yok |
| 17 | §9 yayın FW (bootloader) | **Kabul ediliyor, siliyor** (`simdiff` c) | NUM≠kendi ise ret ✔ | Adresli gönderiyor |
| 18 | §9 atanmamış (63) kart FW | Ret (`open` false) | Kabul (kurtarma için) | `requireResolved` → yapmıyor |
| 19 | §9 BAD_OFFSET "pencere başına bir" | İyi çerçeve gelene dek **tek** | Her 16 bozuk çerçevede bir ✔ | Sıra boşaltma + yeniden deneme ✔ |
| 20 | §9 BAD_IMAGE zamanı | Yalnız END'de | 64. baytta (erken) | Her ikisini de REJECTED sayıyor ✔ |
| 21 | §9 tekrarlanan END | Doğrulama sürerken `WRONG_STATE`; hemen yeniden başlıyor | DONE'da `OK` (5 ms) | END kaybında **DATA'ya geri sarıyor** (bulgu 10) |
| 22 | ESTOP + uzun komut | `FAILED` yolluyor | Açık bırakıyor | `onProgress` bekliyor |
| 23 | `can.data_bitrate` yoksa | M2 varsayıyor | Klasik | — |
| 24 | Codec bit düzeyi | ✔ (altın vektörler) | ✔ | ✔ |

---

## İyi olanlar
- Codec TS ↔ C bit düzeyinde aynı: altın vektörler iki tarafta da geçiyor. `tools/gen-catalog.ts` çıktısı depodakiyle **birebir aynı** (CATALOG.md + `cycan_catalog.h`, /tmp'ye üretilip karşılaştırıldı). `cycan-vectors.json` ve `cycan_vectors.inc` güncel.
- Gerçek C kütüphanesi host `CygnusBus` ile hiç uyarlama gerekmeden uçtan uca çalıştı. Kapsanan akış: keşif → ASSIGN → INFO → parametre → SAVE → akış → kontrol → ESTOP → FW (FD ve klasik) → kalıcılık.
- C kütüphanesi sağlam:
  - `-Wconversion -Wcast-align -pedantic` ile temiz.
  - Rastgele çerçeve fuzz'ı (20 tur, toplam ~2M çerçeve, bozuk depolama dahil) ASan/UBSan altında temiz.
  - Bütün çözücülerde uzunluk denetimi var; `memcpy` ile hizasız okuma yapılıyor (tip takma adı yok).
  - Zaman karşılaştırmaları taşma güvenli; tek istisna `t_100us`.
- İki geçişli parametre yüklemesi ve ayrı kimlik bölgesi doğru tasarlanmış. ASSIGN onayı silmeden önce gidiyor. ESTOP bayrağı dolu halkada da kaybolmuyor.
- Bootloader `.cyfw`'yu iki CRC ve flaştan geri okumayla doğruluyor. Ayrıca yayın FW'yu açıkça reddediyor (simülatör reddetmiyor).

## Bakmadıklarım
- `legacy/` (Cyncoder v3), `transport/slcan*`, `roboRIO köprüsü`.
- `apps/studio`: arayüzdeki `useDriveSession`/`ArmButton` korumaları bulgu 1 ve 5'i pratikte engelliyor olabilir; bakılmadı.
- `packages/vehicles`.
- Cihazların fizik modelleri.
- STM32 örneğinin derlenmesi, gerçek donanım ve gerçek CAN çarpışma davranışı: aynı `hash10`'a sahip iki kartın ENUM_RSP'de aynı kimliği farklı veriyle göndermesi doğrulanmadı.
- TS `vitest` paketleri: depoda önbellek yazmamak için çalıştırmadım.
- Klasik akış düşmeleri (bulgu 12) FDCAN TX FIFO'nun 3 çerçeve olduğu varsayımıyla ölçüldü.
