# CyCAN kart kütüphanesi (`firmware/cycan`)

CyCAN v1 protokolünün (`docs/PROTOCOL.md`) kart tarafı referans gerçeklemesi. Taşınabilir C99, dinamik bellek ve global durum yok; donanıma yalnızca küçük bir HAL (`cycan_hal_t`) ile bağlanır. Hedef STM32G431 (Cortex-M4F, FDCAN), ama her MCU'ya taşınabilir.

| Dosya | İçerik |
|---|---|
| `include/cycan_codec.h`, `src/cycan_codec.c` | Kimlik kodlama/çözme, kabul kuralı, tüm mesaj yükleri, CRC32, FNV-1a-64, `.cyfw` başlığı, STATUS yardımcıları. TS codec'leriyle bit-bit aynı. |
| `include/cycan_store.h`, `src/cycan_store.c` | Güç kesintisine dayanıklı A/B parametre deposu (NUM, ad, parametreler); uygulama ve bootloader ortak kullanır. |
| `include/cycan.h`, `src/cycan_node.c` | Uygulama kipindeki kart: keşif, numara, çakışma, heartbeat (açılışta BOOT), parametreler, STATUS, STREAM, hatalar, ESTOP, CTRL bekçisi ve nötrden başlama kuralı, komutlar. |
| `include/cycan_boot.h`, `src/cycan_boot.c` | Bootloader: kurtarma penceresi, FW güncelleme durum makinesi, bootloader'ın hattaki varlığı. |
| `include/cycan_catalog.h` | Katalogdan **üretilir** (`tools/gen-catalog.ts`); elle değiştirmeyin. |
| `examples/stm32g431_cyncoder/` | Derlenmeyen ama gerçekçi iskelet: STM32 HAL ile port, Cyncoder uygulaması, bootloader. |
| `test/` | Host testleri, sahte HAL (güç kesintisi benzetimli), fuzz, altın vektör üreticisi. |
| `tools/bridge/` | `cycan-bridge`: gerçek kütüphaneyi stdin/stdout üzerinden sunan çapraz uyum köprüsü (tel biçimi `tools/bridge/README.md`). |

```
make test      # -std=c99 -Wall -Wextra -Werror -pedantic -Wconversion + ASan/UBSan; testler + kısa fuzz (20k çerçeve)
make fuzz      # tam fuzz: sabit tohum (FUZZ_SEED=1), FUZZ_FRAMES=200000
make bridge    # build/cycan-bridge
make vectors   # test/cycan_vectors.inc dosyasını TS altın vektörlerinden yeniden üretir
```

## Bir karta 10 adımda ekleme

1. `include/`, `src/cycan_codec.c`, `src/cycan_store.c`, `src/cycan_node.c` dosyalarını projeye ekleyin (bootloader projesine `src/cycan_boot.c` ve aynı `cycan_store.c`). Derleyici bayrakları: `-std=c99` veya üstü, `-ffunction-sections -fdata-sections` + bağlayıcıda `--gc-sections` (kullanılmayan host kodlayıcıları atılır).
2. Katalogdaki model bölümünü bulun (`CYCAN_<MODEL>_*`). Parametre deposunu ve tablosunu X-makrosundan üretin:
   ```c
   #define F(pid, name, pt, mn, mx, df, mnz, fl) CYCAN_CTYPE(pt) name;
   static struct { CYCAN_CYNCODER_PARAMS(F) } p;
   #define R(pid, name, pt, mn, mx, df, mnz, fl) CYCAN_PARAM_ENTRY(pid, pt, mn, mx, df, mnz, fl, &p.name, on_param),
   static const cycan_param_t k_params[] = { CYCAN_CYNCODER_PARAMS(R) };
   ```
   Değerleri doğrudan `p.ENC_RATIO` gibi okuyun; yazan yalnızca kütüphanedir (yerel değişiklik için `cycan_param_set`).
3. Ardışık olmayan enum seçenekleri varsa (`CYCAN_<MODEL>_ENUM_*_VALUES`) `param_validate` geri çağrısında denetleyin.
4. `status_fill(n, out[8])` yazın: yerleşim katalog başlığındaki `STATUS/n layout` yorumundadır. Ölçekli alanlar için `cycan_scale_round`, bit alanları için `cycan_put_bits`, f32 için `cycan_wr_f32`.
5. `signal_read(sid, &f)` yazın (STREAM). Bilinmeyen sid için `false` dönün (NaN gider).
6. Eyleyici kartlarda `ctrl(index, data, len, armed)` ve `neutral(reason)` yazın (sözleşme aşağıda, "CTRL ve nötrden başlama"). `neutral` eyleyiciyi **hemen** güvenli duruma alır.
7. Komut işleyicisi: `SELF_TEST` ve `0x40+` model komutları. Uzun işlemlerde `CYCAN_CMDST_IN_PROGRESS` dönün, bitince `cycan_command_finish(node, cmd, status, result)`.
8. HAL'i yazın (aşağıdaki sözleşme; örnek: `examples/stm32g431_cyncoder/cycan_port_stm32g4.c`). RX kesmesinde yalnızca `cycan_on_frame()`.
9. Açılışta `cycan_init()`, sonra `cycan_data_bitrate()` değerine göre CAN denetleyicisini kurun (FD veri hızı yeniden başlatınca değişir). Ana döngüde en az 1 kHz'de `cycan_poll(node, now_us)`. İlk HEARTBEAT (state = BOOT) 100 ms içinde gider; `cycan_init` ile ilk poll arasında 50 ms'den fazla bekletmeyin.
10. Hataları `cycan_fault_set/clear` ile bildirin (ACTIVE = etkin + sticky, WARN = uyarı). Studio ile deneyin: keşif → numara atama → parametre → SAVE → yeniden başlat → STATUS/STREAM → ENTER_BOOTLOADER.

## HAL sözleşmesi (`cycan_hal_t`)

| Geri çağrı | Sözleşme |
|---|---|
| `can_send(frame)` | 29 bit kimlik; `flags` içinde `CYCAN_FRAME_FD/BRS`. Denetleyici alamıyorsa `false` dönün; kütüphane TX kuyruğunda (`CYCAN_TX_QUEUE_LEN`, varsayılan 16) tutup sırayı koruyarak yeniden dener. Donanım TX kuyruğu FIFO kipinde olmalı. |
| `uid96(out)` | MCU'nun 96 bit UID'si, INFO sayfa 1–2 bayt sırasıyla. Yalnızca `cycan_init` içinde okunur. |
| `storage_read/erase/write(slot, …)` | **İki yuva**: `CYCAN_STORE_SLOT_A` (0) ve `_B` (1), her biri en az `cycan_store_slot_size(app)` bayt (ayrı flaş sayfaları). `erase` bütün yuvayı 0xFF yapar. Yazmalar silinmiş alana, 8 bayt hizalı ve 8'in katı uzunlukta gelir; **sıra artan değildir** (ilk 8 bayt en son yazılır). Üçü de `NULL` olabilir (kalıcılık yok, NUM 63). |
| `reboot()`, `enter_bootloader()` | Dönmez. Kütüphane yanıt çerçevesi gittikten sonra (`CYCAN_RESET_DELAY_US`, TX kuyruğu boş) çağırır; önce `neutral(RESET)`. |
| `led_set(on)` | Yalnızca IDENTIFY yanıp sönmesi için. |
| `random()` | ENUM çakışma geri çekilmesi ve CONFLICT duyurusu için; `NULL` ise UID+zaman. |

### Kalıcı depo (A/B, `cycan_store.h`)

Her yuva tam bir kopya tutar: `"CYP2"`, sıra numarası, model, kayıt sayısı, NUM, 21 bayt ad, kayıt başına 8 bayt (`pid u16, ptype u8, 0, değer u32`), sonda CRC32 + ~CRC32. Kurallar:

- Yazma **her zaman en yeni geçerli kopyanın olmadığı yuvaya** gider; sıra numarası bir artar. Önce gövde, en son ilk 8 bayt (sihirli sözcük + sıra) yazılır: yarım kalan yazma "boş" okunur.
- Okuma iki yuvayı da doğrular, geçerli en yeni kopyayı (sıra numarası, taşmaya dayanıklı karşılaştırma) seçer.
- Sonuç: kaydetme veya kalıcı ASSIGN_ID'nin herhangi bir baytında güç kesilirse kart ya eski ya yeni kümeyle açılır, varsayılana düşmez (`test_node_store_power_cut` her baytı dener).
- İki yuva da bozuksa: varsayılanlar, `PARAM_CRC` **etkin** hata (state = FAULT, CTRL kapalı), NUM **63** (eski numarayla sürülemez). Hata başarılı `SAVE_PARAMS` veya `CLEAR_FAULTS` (operatör onayı) ile kalkar.
- `SAVE_PARAMS` RAM parametrelerini ve adı, **depodaki** NUM ile yazar (kalıcı olmayan ASSIGN_ID kalıcı olmaz). Kalıcı ASSIGN_ID depodaki parametreleri kopyalayıp yalnız NUM'u değiştirir (kaydedilmemiş RAM değişiklikleri yazılmaz).
- `LOAD_SAVED` depodaki kopyayı RAM'e yükler (boş depo → varsayılanlar; ikisi de bozuk → `FAILED`, RAM değişmez). `UNSAVED`, RAM (ad + değerler) ile depodaki kopyanın karşılaştırmasıdır.
- Tabloya artık uymayan kayıtlar (pid yok, tip/aralık değişti) varsayılanda kalır; salt-okunur değerler her zaman tablodan gelir.

## CTRL ve nötrden başlama (§7)

```c
cycan_ctrl_t ctrl(cycan_node_t *n, uint8_t index, const uint8_t *data, uint8_t len, bool armed);
```

Kütüphane `ctrl`'ü yalnız karta adreslenmiş (yayın değil) çerçevelerde ve kart atanmış, çakışmasız, ESTOP'suz ve etkin hatasızken çağırır. Uygulama çerçeveyi çözer ve sınıflar:

| Dönüş | Uygulama ne yapar | Kütüphane ne yapar |
|---|---|---|
| `CYCAN_CTRL_INVALID` | Hiçbir şey uygulamaz (bilinmeyen indeks, yanlış uzunluk/değer). | Bekçiyi **beslemez**. |
| `CYCAN_CTRL_NEUTRAL` | Nötr komutu uygular (modelin nötr tanımı: `SET` için `mode 0, value 0`; servo için tüm darbeler 0). | O indeksi silahlandırır, bekçiyi besler, `CTRL_TIMEOUT` uyarısını siler. |
| `CYCAN_CTRL_DRIVE` | **Yalnız `armed` doğruysa** uygular ve `cycan_set_enabled(n, true)` çağırır; `armed` yanlışsa hiçbir şey yapmaz. | `armed` ise bekçiyi besler; değilse çerçeveyi yok sayar. |

`armed`, o CTRL indeksi için son "nötre zorlama" olayından sonra bir nötr komut görüldüyse doğrudur. Nötre zorlayan olaylar: açılış, ESTOP (ve CLEAR_ESTOP), CTRL zaman aşımı, yeni etkin hata (`cycan_fault_set(..., ACTIVE)` → `neutral(FAULT)`), CONFLICT, NUM değişimi, REBOOT/ENTER_BOOTLOADER. Böylece yeniden başlayan veya kilidi kalkan kart, hâlâ akan eski hedefe kendiliğinden dönmez.

## Kütüphanenin uyguladığı komut kuralları (§4.5, §4.7)

- Sürülürken (`ENABLED`): `REBOOT`, `ENTER_BOOTLOADER`, `SAVE_PARAMS`, `LOAD_DEFAULTS`, `LOAD_SAVED` → `DENIED`; kalıcı `ASSIGN_ID` onaysız yok sayılır (flaş silme sürmeyi durdurur). `cycan_save()` da `false` döner.
- `state = ESTOP`: `REBOOT`, `ENTER_BOOTLOADER` → `DENIED`.
- `ENTER_BOOTLOADER`: `arg = 0xB0070000 | uid16` değilse `INVALID_ARG`. Yayınla gelen kurtarma çerçevesi (`arg = 0xB0075AFE`) uygulamada yanıtsız yok sayılır.
- ESTOP kesmede bir sayaçla tutulur (dolu halkada kaybolmaz); halkadaki her çerçeve o anki sayaçla damgalanır. `CLEAR_ESTOP` yalnız kendisinden sonra ESTOP gelmediyse ve aynı poll turunda ESTOP kilitlenmediyse uygulanır, aksi halde `DENIED` (ESTOP kazanır).
- Uzun komut (`IN_PROGRESS`) sürerken ESTOP gelirse kütüphane `FAILED` yollar; uygulama işi `neutral(ESTOP)` içinde keser, sonraki `cycan_command_finish` yok sayılır.
- Eyleyiciyi hareket ettiren uzun komutlar (`cycan_app_t.moving_cmds`, katalogdan `CYCAN_<MODEL>_MOVING_CMDS`) karta gelen nötr CTRL ile iptal olur (PROTOCOL §4.5): kütüphane `FAILED` yollar ve `neutral(ABORT)` çağırır. Kartı nötre zorlayan her olay (CTRL zaman aşımı, hata, çakışma, NUM değişimi, yeniden başlatma) da böyle bir komutu `FAILED` ile bitirir; komut asılı kalmaz. Model komutlarının ESTOP/sürülme sırasında reddi uygulamaya kalmıştır (`cycan_ctrl_allowed()`).
- Uygulama kipinde FW_REQ → `WRONG_STATE`. Bilinmeyen INFO sayfası yanıtsız. `CLEAR_FAULTS` sonrası hâlâ etkin hatalar sticky'de kalır.

## Çalışma modeli, zaman ve kuyruklar

- `cycan_on_frame()` kesmeden çağrılabilir: yalnızca kimlik süzer ve tek üretici/tek tüketici halkasına (`CYCAN_RX_QUEUE_LEN`, varsayılan **16**) kopyalar. `cycan_on_tx_error()` da kesme güvenlidir. Geri kalan her şey tek bağlamda; geri çağrılar `cycan_poll()` çağırmamalıdır.
- **Zaman**: serbest çalışan 32 bit µs sayaç (STM32G431'de 1 MHz TIM2). Kütüphane yalnız farklara bakar (`now - then`); bu yüzden 71,6 dakikadaki taşma zararsızdır, yeter ki `cycan_poll()` en az 2³¹ µs'de (35 dk) bir çağrılsın. STREAM `t_100us` ayrı bir 100 µs biriktiricisinden gelir; taşmada sıçramaz (`test_node_time_wrap`). 64 bit zaman gerekmez.
- `cycan_poll()` en az 1 kHz; `stream.minPeriodUs` 1 ms'den küçükse en az o sıklıkta. Akış periyodu en yakın `stream.minPeriodUs` katına yuvarlanır.
- Kuyruk boyutları derleme zamanında: `CYCAN_RX_QUEUE_LEN` (16; host'un 15 CONFIG + START patlamasını ve ~20 ms flaş duraklamasını karşılar), `CYCAN_TX_QUEUE_LEN` (16; bir poll'da heartbeat + STATUS + en çok 4 klasik STREAM çerçevesi). Klasik kipte akış en çok 4 yuva taşır (§8). Taşmalar `cycan_stats()` sayaçlarında ve `CAN_ERR` uyarısı olarak görünür (uyarı + sticky; son kayıptan `CYCAN_CAN_ERR_HOLD_MS` = 1 s sonra uyarı kalkar).
- Flaş silme (STM32G4: sayfa başına ~22 ms, tek bankta CPU bekler) yalnızca `SAVE_PARAMS`, kalıcı `ASSIGN_ID` ve bootloader'da olur; ikisi de sürülürken reddedilir. `ASSIGN_ID` onayı silmeden **önce** gönderilir.
- Önerilen donanım süzgeci: genişletilmiş kimlik, maske `0x00FF0000`, değer `0x00080000` (MFR = 8).

## Bootloader (`cycan_boot`)

`cycan_boot_hal_t` ek olarak `can_config(data_bitrate)` (isteğe bağlı) ve uygulamayla **aynı** `storage_read/erase/write` geri çağrılarını alır; NUM ve `can.data_bitrate` A/B depodan okunur (`cfg.num` kaldırıldı). `cfg.data_bitrate_default` katalog varsayılanıdır (depoda kayıt yoksa uygulama da onu kullanır); depo bozuksa veya değer aralık dışıysa klasik kip.

Açılış: imaj (başlık + gövde CRC) doğrulanır. Geçerli imaj varsa ve `cfg.stay` (uygulamanın ENTER_BOOTLOADER isteği) yoksa bootloader **150 ms sessizce dinler** (§9.0); bu sürede `DEVTYPE 0, NUM 0` yayınıyla `ENTER_BOOTLOADER arg = 0xB0075AFE` görürse bootloader'da kalır, görmezse `start_app()`. Geçerli imaj yoksa doğrudan bootloader'da kalır ve HEARTBEAT sürümü 0.0.0'dır.

Aktarım: `BEGIN` → `OK`, **hiçbir şey silinmez**. İlk 64 bayt (başlık) RAM'de toplanır; sihirli sözcük, sürüm, başlık CRC, model, hw_rev ve `size == 64 + payload_size (+64 imza, flags bit0)` denetlenir. Uymazsa `BAD_IMAGE` ve kurulu uygulama dokunulmadan kalır. Uyarsa `BUSY`, silme, başlık yazılır, `OK` + `next_offset = 64` (başlığı tamamlayan çerçevenin fazlası atılır; host 64'ten devam eder; silme sürerken gelen DATA yanıtsız atılır). Sonra `DATA` sırayla yazılır; her `window` (16) iyi çerçevede `OK`; sıra bozulunca pencere başına bir `BAD_OFFSET`; geçerli CAN/CAN-FD uzunluğunda olmayan DATA yok sayılır. `END`: dosya CRC (`BAD_CRC`), gövde CRC (`BAD_IMAGE`), flaştan geri okuma (`FLASH_ERROR`), `OK`, 5 ms sonra uygulama. `END` sonrası (DONE) gelen her FW_REQ → `BUSY`; `BEGIN` bekleyen bir REBOOT başlatmasını iptal eder; uygulama yalnız doğrulanmış (DONE) veya dokunulmamış geçerli imajla başlatılır. FW çerçeveleri yalnız kartın **atanmış** kendi numarasına kabul edilir (atanmamış kart önce ASSIGN_ID ister).

Flaş yerleşimi (örnek, G431 128 KB): bootloader `0x08000000–0x08003FFF`, imaj sayfa 8–60 (`.cyfw` başlığı `0x08004000`'da), depo yuva A sayfa 61, yuva B sayfa 62, sayfa 63 boş. Uygulama `0x08004040`'a bağlanır ve vektör tablosu 512 bayta hizalanır (`0x08004200`, `VTOR`).

## Bellek ayak izi (Cortex-M4F, yaklaşık)

| | RAM |
|---|---|
| `cycan_node_t` | ≈ 1,7 KB (RX 16 × 16 B, TX 16 × 72 B); yalnız klasik CAN portlarında `CYCAN_FRAME_MAX_DATA=8` ile TX elemanı 16 B'a iner |
| `cycan_boot_t` | ≈ 570 B (RX 4 FD çerçevesi, 64 B başlık + 64 B yazma tamponu) |

Flaş ayak izi önceki sürüme göre depo modülüyle ≈ 0,6 KB artar (ölçülmedi; host derlemesinden tahmin).

## Testler

`test/gen_vectors.py` TS altın vektörlerini `test/cycan_vectors.inc`'e çevirir (`make vectors`). Host testleri (sahte HAL): codec vektörleri; açılış BOOT heartbeat'i; ENUM, sessizlik, ASSIGN_ID (sürülürken kalıcı ret); çakışma; PARAM statüleri; SAVE/LOAD_DEFAULTS/LOAD_SAVED ve hesaplanan UNSAVED; A/B depoda **her bayt için güç kesintisi** (SAVE ve kalıcı ASSIGN), iki yuva bozuk; STATUS; STREAM FD/klasik, 4 yuva sınırı, periyot yuvarlama; 32 bit zaman taşması; CTRL zaman aşımı, yalnız geçerli CTRL'ün beslediği bekçi, yayın CTRL reddi, nötrden başlama (açılış, zaman aşımı, ESTOP, hata, NUM değişimi, indeks başına); ESTOP/CLEAR_ESTOP sırası, ESTOP'ta uzun komut `FAILED`, nötr CTRL/zaman aşımıyla hareketli komut iptali; DENIED kuralları ve ENTER_BOOTLOADER kasıt değeri; TX/RX taşması ve `CAN_ERR`; bootloader mutlu yol (klasik, FD, imzalı), başlık doğrulanmadan silmeme, yanlış model/hw_rev'de uygulamanın korunması, sıra bozulması, CRC hataları, DATA uzunluk kuralı, END/BEGIN/REBOOT yarışları, kurtarma penceresi, depodan veri hızı, atanmamış bootloader'a FW. `test/fuzz.c`: rastgele çerçeve + rastgele depo içeriği + rastgele güç kesintisi, ASan/UBSan.
