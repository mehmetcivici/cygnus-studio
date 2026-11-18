# CyCAN v1 — Cygnus CAN Protokolü

Durum: **taslak v1.0** · Bu belge Cygnus Studio, simülatör ve kart firmware'lerinin ortak sözleşmesidir.
Kod tarafındaki tek doğruluk kaynağı `packages/protocol` (sabitler + codec) ve `packages/protocol/src/catalog` (cihaz kataloğu) dizinleridir; bu belge ile kod çelişirse hata sayılır ve ikisi birlikte düzeltilir.

Tasarım hedefleri:

1. **Tak, tanınsın, çalışsın.** Kart hatta takılınca Studio onu bulur, kimlik çakışmasını kendisi çözer.
2. **FRC uyumlu kimlik düzeni.** 29 bit kimlik, WPILib/FRC düzeniyle aynıdır; mevcut Cyncoder 1.4 firmware'i ve `CygnusLib` ile aynı aileden gelir, roboRIO ve üçüncü parti FRC cihazlarıyla aynı hatta çakışmadan yaşar.
3. **Her şey 8 bayta sığar.** Tüm kontrol, durum, parametre ve sistem mesajları klasik CAN (8 bayt) ile çalışır; Arduino (MCP2515), Pixhawk, roboRIO sorunsuz konuşur. CAN-FD yalnızca hız kazandırır (firmware aktarımı, çok kanallı akış).
4. **Tek katalog.** Parametre ve sinyal tanımları kartta değil katalogdadır; kart yalnızca `model` + `catalog_rev` bildirir.

## 1. Fiziksel katman

| Öğe | Değer |
|---|---|
| Çerçeve | Yalnızca 29 bit genişletilmiş kimlik. 11 bit çerçeveler yok sayılır. |
| Nominal hız | 1 Mbit/s |
| Veri hızı (FD) | 2 Mbit/s varsayılan · 5 ve 8 Mbit/s seçenek (`can.data_bitrate`) |
| Klasik kip | `can.data_bitrate = 0`: kart FD/BRS çerçevesi göndermez (roboRIO, MCP2515 hatları) |
| Bayt sırası | Her yerde little-endian; kayan nokta IEEE-754 `f32` |
| Sonlandırma | 120 Ω hat sonlarında; anahtarlanabilir kartlarda `can.termination` |

## 2. Kimlik düzeni (29 bit)

```
bit 28..24  DEVTYPE  (5)  FRC cihaz tipi
bit 23..16  MFR      (8)  üretici kodu = 8 ("Team Use"; resmî kod alınınca değişir, tek sabit)
bit 15..10  CLASS    (6)  API sınıfı
bit  9..6   INDEX    (4)  API indeksi
bit  5..0   NUM      (6)  cihaz numarası
```

`NUM`: `0` = o tipteki tüm kartlara yayın (yalnızca karta giden çerçevelerde) · `1..62` = atanmış · `63` = atanmamış (fabrika çıkışı).
Bir kartın adresi **(DEVTYPE, NUM)** çiftidir; aynı numara farklı tiplerde tekrar edebilir (ESC #1 ve Encoder #1).
`DEVTYPE = 0` + `NUM = 0`: hattaki **tüm Cygnus kartlarına** yayın.

### 2.1 DEVTYPE ve model

| DEVTYPE | FRC anlamı | Modeller (`model` kodu) |
|---|---|---|
| 2 | Motor Controller | ESC 20A (1), ESC 80A (2) |
| 4 | Gyro Sensor | CAN gyro (4) |
| 7 | Encoder | Cyncoder (3) |
| 8 | Power Distribution | Güç dağıtım küçük (7), Güç dağıtım büyük (8), SoC regülatörü (9) |
| 10 | Miscellaneous | CAN debug OLED (10), USB-CAN adaptör (11) |
| 12 | Servo Controller | CAN servo kontrol 16 kanal (5), Sızdırmaz CAN servo (6) |

`model` 8 bitlik, tüm ürün ailesinde tekil koddur; katalog `model` ile seçilir.

### 2.2 CLASS tablosu

Çift sınıf = **karta giden** (host → kart), tek sınıf = **karttan gelen**. `0x00–0x0F` eski Cyncoder v3 protokolüne ayrılmıştır (bkz. §11).

| CLASS | Ad | Yön | INDEX |
|---|---|---|---|
| 0x10 | CTRL | → kart | modele özgü komutlar (katalog) |
| 0x11 | STATUS | ← kart | periyodik durum çerçevesi no (0..15, katalog) |
| 0x12 | SYS_REQ | → kart | 0 ENUM_REQ · 1 ASSIGN_ID · 2 IDENTIFY · 3 INFO_REQ · 4 NAME_SET · 5 COMMAND · 6 FAULT_REQ · 7 ESTOP |
| 0x13 | SYS_RSP | ← kart | 0 HEARTBEAT · 3 INFO_RSP · 5 COMMAND_RSP · 6 FAULT_RSP |
| 0x14 | PARAM_REQ | → kart | 0 GET · 1 SET |
| 0x15 | PARAM_RSP | ← kart | 0 VALUE |
| 0x16 | STREAM_REQ | → kart | 0 CONFIG · 1 START · 2 STOP |
| 0x17 | STREAM_RSP | ← kart | 0 DATA |
| 0x18 | FW_REQ | → kart | 0 BEGIN · 1 DATA · 2 END |
| 0x19 | FW_RSP | ← kart | 0 ACK |
| 0x1B | ENUM_RSP | ← kart | özel: INDEX+NUM alanı = `hash10` (§3.2) |

Kart, kendisine giden bir çerçeveyi şu koşulda kabul eder: `MFR` eşleşir **ve** (`DEVTYPE` kendi tipi ve `NUM` kendi numarası veya 0) **veya** (`DEVTYPE = 0` ve `NUM = 0`).

## 3. Keşif ve kimlik atama

### 3.1 Kart kimliği (UID)

Her kartın 96 bitlik MCU UID'si vardır (bayt sırası INFO sayfa 1–2'deki sıradır). Türetilen değerler:

```
uid48  = FNV-1a-64(uid96 baytları) & 0xFFFF_FFFF_FFFF
uid16  = uid48 & 0xFFFF
hash10 = (uid48 >> 16) & 0x3FF
delay  = (uid48 >> 26) % 100        // ms
```

### 3.2 ENUM_REQ / ENUM_RSP

`ENUM_REQ` (SYS_REQ/0, yayın `DEVTYPE=0,NUM=0`): `[filter u8]` — `0` herkes, `1` yalnızca atanmamış/çakışan kartlar.

Her kart `delay` ms sonra `ENUM_RSP` gönderir. Kimlik: `DEVTYPE` = kendi tipi, `CLASS = 0x1B`, alt 10 bit = `hash10` (INDEX = hash10 >> 6, NUM = hash10 & 0x3F). Böylece aynı numaralı iki kart bile farklı kimlikle yanıt verir.

```
ENUM_RSP: [uid48 6B] [num_flags u8] [model u8]
num_flags: bit0..5 = NUM · bit6 = CONFLICT · bit7 = BOOTLOADER
```

Gönderim hatası olursa kart yeniden göndermeyi iptal eder ve 0–100 ms rastgele gecikmeyle bir kez daha dener. Host `ENUM_REQ`'i arka planda saniyede bir tekrarlar; yanıt bekleme penceresi 150 ms.

### 3.3 ASSIGN_ID

`ASSIGN_ID` (SYS_REQ/1, yayın): `[uid48 6B] [new_num u8] [flags u8]` — `flags bit0` = kalıcı yaz.
Yalnızca `uid48`'i eşleşen kart uygular, çakışma durumundan çıkar ve onay olarak 50 ms içinde `ENUM_RSP` gönderir (kalıcı yazma onaydan sonra yapılabilir). Host onayı 250 ms bekler, 3 kez dener.

### 3.4 Çakışma algılama

Kart şu iki durumdan birinde **CONFLICT** durumuna geçer:

- kendi (DEVTYPE, NUM) adresinden gelen ama `uid16`'sı farklı bir `HEARTBEAT` görürse,
- kendi DEVTYPE ve NUM'unu taşıyan ama `uid48`'i farklı bir `ENUM_RSP` görürse.

CONFLICT'e geçen kart hemen (0–20 ms rastgele gecikmeyle) CONFLICT bayraklı bir `ENUM_RSP` yayınlar; böylece aynı numaradaki diğer kart da CONFLICT'e geçer. Sonuç belirlenimcidir: aynı numarayı paylaşan kartların **hepsi** susar, hangisinin "kazandığı" açılış sırasına bağlı kalmaz. CONFLICT kalıcı değildir (yeniden başlatınca yeniden algılanır) ve yalnızca kartın `uid48`'ine gelen `ASSIGN_ID` ile biter (aynı numara yeniden atanabilir).

Host çakışmayı şu sırayla çözer: önce numarası değişecek kartlara yeni numaralarını atar, **en son** numarayı koruyacak karta aynı numarayı yeniden atar. Böylece çözüm bittiğinde o numarayı bildiren başka kart kalmaz.

CONFLICT ve atanmamış (`NUM = 63`) kartlar:

- HEARTBEAT, STATUS, STREAM göndermez; CTRL kabul etmez (eyleyiciler nötr),
- yalnızca `ENUM_REQ`, `ASSIGN_ID` ve `IDENTIFY` (UID'li biçim) çerçevelerine yanıt verir.

Studio çakışan/atanmamış kartlara o tipteki ilk boş numarayı önerir veya otomatik atar.

## 4. Sistem mesajları

### 4.1 HEARTBEAT (SYS_RSP/0) — 2 Hz (500 ms ± UID'ye bağlı 0–50 ms faz)

```
[state_flags u8] [fault u16] [uid16 u16] [fw_major u8] [fw_minor u8] [fw_patch u8]
state_flags: bit0..3 state · bit4 UNSAVED (kaydedilmemiş parametre) · bit5 ENABLED (eyleyici sürülüyor)
             bit6 WARNING · bit7 IDENTIFY etkin
state: 0 BOOT · 1 BOOTLOADER · 2 IDLE · 3 ACTIVE · 4 FAULT · 5 ESTOP
```

Host 1500 ms heartbeat almazsa kartı **kayıp** sayar.

### 4.2 IDENTIFY (SYS_REQ/2)

Adresli: `[seconds u8]` (0 = kapat). UID'li yayın: `[uid48 6B] [seconds u8]`. İki biçim yük uzunluğundan (1 / 7 bayt) ayırt edilir; çerçeve dolgulanmaz. Kart LED'ini belirgin biçimde yakıp söndürür.

### 4.3 INFO_REQ (SYS_REQ/3) `[page u8]` → INFO_RSP (SYS_RSP/3) `[page u8] [7 bayt]`

| page | İçerik |
|---|---|
| 0 | `model u8, hw_rev u8, proto_major u8, proto_minor u8, catalog_rev u16, bootloader_ver u8` |
| 1 | `uid96[0..6]` |
| 2 | `uid96[7..11], 0, 0` |
| 3 | `git_hash u32, build_day u16 (2026-01-01'den gün), dirty u8` |
| 4,5,6 | Kullanıcı adı, UTF-8, 21 bayt, sıfır dolgulu ("Sol ön itici") |

Tanımsız sayfa isteği yanıtsız kalır.

### 4.4 NAME_SET (SYS_REQ/4) `[page u8 (0..2)] [7 bayt]` → INFO_RSP page 4+page. Kalıcılık `SAVE_PARAMS` ile.

### 4.5 COMMAND (SYS_REQ/5) `[cmd u8] [arg u32] [0 0 0]` → COMMAND_RSP (SYS_RSP/5) `[cmd u8] [status u8] [result u32] [0 0]`

Ortak komutlar: `1 REBOOT · 2 ENTER_BOOTLOADER · 3 SAVE_PARAMS · 4 LOAD_DEFAULTS · 5 CLEAR_FAULTS · 6 SELF_TEST · 7 CLEAR_ESTOP`. `0x40+` modele özgü (katalog `actions`).
`status`: `0 OK · 1 IN_PROGRESS · 2 UNSUPPORTED · 3 INVALID_ARG · 4 DENIED (ör. sürülürken) · 5 FAILED`.
Uzun işlemler önce `IN_PROGRESS`, bitince `OK/FAILED` + `result` yollar. `SELF_TEST` sonucu: bit maskesi, 0 = hepsi geçti (bit anlamları katalogda).
`LOAD_DEFAULTS` yalnızca RAM'i değiştirir (NUM ve ad korunur); kalıcı olması için `SAVE_PARAMS` gerekir.
Eyleyici sürülürken (`ENABLED`) `REBOOT`, `ENTER_BOOTLOADER` ve `LOAD_DEFAULTS` `DENIED` döner.

### 4.6 FAULT_REQ (SYS_REQ/6) → FAULT_RSP (SYS_RSP/6) `[active u16] [sticky u16] [warn u16] [0 0]`

Ortak hata bitleri: `0 UNDERVOLT · 1 OVERVOLT · 2 OVERCURRENT · 3 OVERTEMP · 4 CTRL_TIMEOUT · 5 SENSOR · 6 HARDWARE · 7 PARAM_CRC · 8 CAN_ERR · 9 ESTOP`; `10..15` modele özgü (katalog). `sticky`, `CLEAR_FAULTS`'a kadar kalır. HEARTBEAT yalnızca etkin hataları taşır; host etkin maske veya WARNING biti değişince `FAULT_REQ` ile ayrıntıyı okur.

### 4.7 ESTOP (SYS_REQ/7, yayın) `[0xE5 0x70]`

Tüm eyleyiciler anında nötr olur ve `state = ESTOP`'ta kilitlenir. `COMMAND CLEAR_ESTOP` veya güç kesmeyle çıkılır. Bu yazılımsal durdurmadır; şartnamelerin istediği fiziksel acil durdurmanın yerine geçmez.

## 5. Parametreler

Tüm parametreler 32 bittir. `ptype`: `0 u32 · 1 i32 · 2 f32 · 3 bool · 4 enum`.

```
GET   (PARAM_REQ/0): [pid u16]
SET   (PARAM_REQ/1): [pid u16] [ptype u8] [0] [value 4B]
VALUE (PARAM_RSP/0): [pid u16] [ptype u8] [status u8] [value 4B]     // GET ve SET yanıtı
status: 0 OK · 1 UNKNOWN_PARAM · 2 TYPE_MISMATCH · 3 OUT_OF_RANGE · 4 READ_ONLY · 5 DENIED_WHILE_ENABLED
```

- `SET` RAM'e hemen uygulanır; reddedilirse `VALUE` geçerli (eski) değeri döndürür.
- Kalıcılık: `COMMAND SAVE_PARAMS`. Kaydedilmemiş değişiklik varken HEARTBEAT `UNSAVED` biti 1'dir.
- `pid 0x0000–0x00FF` ortak, `0x0100+` modele özgüdür.

Ortak parametreler:

| pid | Anahtar | Tip | Açıklama |
|---|---|---|---|
| 0x0001 | `can.data_bitrate` | enum | 0 klasik · 1 2M · 2 5M · 3 8M — yeniden başlatınca geçerli |
| 0x0002 | `can.termination` | bool | Anahtarlanabilir sonlandırma; yoksa salt-okunur 0 |
| 0x0003 | `ctrl.timeout_ms` | u32 | Eyleyicilerde komut zaman aşımı, 20–2000, varsayılan 200 |
| 0x0010+n | `status.n.period_ms` | u32 | n. durum çerçevesi periyodu; 0 kapalı, en az 5 |

## 6. Durum çerçeveleri (STATUS)

`STATUS/n`: 8 bayt, yerleşimi katalogdaki `statusFrames[n]` tanımlar (ölçekli tamsayılar veya `f32`). Periyot `status.n.period_ms`. Studio bağlıyken periyotları değiştirmez; yalnızca gösterir ve kullanıcı isterse ayarlar.

## 7. Kontrol çerçeveleri (CTRL)

Katalogdaki `controls` tanımlar. CTRL yalnızca tek karta adreslenir; yayın (`NUM = 0` veya `DEVTYPE = 0`) CTRL çerçeveleri yok sayılır. Ortak kural: eyleyici, `ctrl.timeout_ms` içinde yeni CTRL çerçevesi almazsa nötr olur ve `CTRL_TIMEOUT` uyarısı verir. Standart biçim (ESC, sızdırmaz servo):

```
CTRL/0 SET: [mode u8] [flags u8] [0 0] [value f32]
```

`flags` ayrılmıştır; host 0 gönderir, kart yok sayar.

**Nötr komut**: `SET` biçiminde `mode = 0, value = 0`; darbe biçiminde (servo kartı) tüm darbeler 0. Host bir kontrol döngüsünü bitirirken nötr komutu bir kez gönderir.

## 8. Yüksek hızlı akış (STREAM) — tuner grafikleri

Her telemetri sinyalinin katalogda bir `sid`'i vardır ve `f32` olarak akıtılabilir.

```
CONFIG (STREAM_REQ/0): [slot u8 (0..14)] [sid u16]            // sid 0xFFFF = yuvayı boşalt
START  (STREAM_REQ/1): [period_100us u16] [0 0]               // aynı zamanda canlı tutma (keepalive)
STOP   (STREAM_REQ/2): []
DATA   (STREAM_RSP/0): [seq u8] [first_slot u8] [t_100us u16] [f32 × k]
```

- Host yuvaları 0'dan başlayarak boşluksuz doldurur. `DATA` içindeki değerler `first_slot`'tan başlayan ardışık yuvalara aittir.
- FD kipinde tek `DATA` çerçevesi dolu yuvaların hepsini taşır (k ≤ 15); FD uzunluk yuvarlamasından gelen dolgu değerlerini host, yapılandırdığı yuva sayısına bakarak atar. Klasik kipte her yuva ayrı çerçevedir (k = 1, `first_slot` = yuva no).
- `t_100us`: kartın 100 µs çözünürlüklü, taşan zaman damgası. `seq` her örnekleme anında 1 artar (kayıp tespiti).
- Host `START`'ı saniyede bir tekrarlar; kart 2 s `START` görmezse akışı kendiliğinden keser.
- En küçük periyot modele bağlıdır (katalog `stream.minPeriodUs`); kart desteklemediği periyodu en yakın desteklenene yuvarlar.

## 9. Firmware güncelleme (FW) — yalnızca bootloader'da

Akış: `COMMAND ENTER_BOOTLOADER` → kart yeniden başlar, HEARTBEAT `state = BOOTLOADER` → `BEGIN` → `DATA…` → `END` → kart doğrular, uygulamayı başlatır.

```
BEGIN (FW_REQ/0): [size u32] [crc32 u32]              // dosyanın tamamı (başlık + gövde)
DATA  (FW_REQ/1): [offset u24] [veri…]                 // klasik: 5 bayt, FD: en çok 61 bayt
END   (FW_REQ/2): []
ACK   (FW_RSP/0): [status u8] [window u8] [next_offset u32] [0 0]
status: 0 OK · 1 BUSY · 2 BAD_OFFSET · 3 BAD_CRC · 4 BAD_IMAGE · 5 FLASH_ERROR · 6 WRONG_STATE
```

- Kart `BEGIN` sonrası (silme sürerken `BUSY`, bitince `OK`), her `window` DATA çerçevesinde bir (varsayılan 16), sıra bozulunca (`BAD_OFFSET` + beklenen `next_offset`) ve `END` sonrası `ACK` yollar.
- Kart sıra bozulduğunda pencere başına bir kez `BAD_OFFSET` yollar (her bozuk çerçeveye ayrı yanıt vermez). Host `BAD_OFFSET` alınca `next_offset`'ten devam eder. Yalnızca son `DATA` parçası kısa olabilir; `size`'ı aşan dolgu baytları yok sayılır.
- Pencere sayacı her `ACK`'tan sonra (BAD_OFFSET dahil) sıfırlanır. Son, eksik kalan pencere için ayrıca `ACK` gönderilmez; onu `END`'in `ACK`'ı kapatır.
- Uygulama kipindeki kart FW_REQ'e `WRONG_STATE` döner.
- Bootloader HEARTBEAT'inin sürüm alanları kurulu imajın sürümünü taşır (geçerli imaj yoksa 0.0.0).
- Bootloader `HEARTBEAT` (state = BOOTLOADER), `ENUM_REQ`, `ASSIGN_ID`, `IDENTIFY`, `INFO_REQ` sayfa 0–2 ve `COMMAND REBOOT`'a yanıt verir; diğer her şeye yanıtsız kalır.

### 9.1 `.cyfw` dosyası

64 baytlık başlık + gövde. Başlık (little-endian):

| Ofset | Alan |
|---|---|
| 0 | `magic` = "CYFW" |
| 4 | `header_ver u16` = 1 |
| 6 | `model u8`, `hw_rev_min u8`, `hw_rev_max u8` |
| 9 | `fw_major u8, fw_minor u8, fw_patch u8` |
| 12 | `payload_size u32`, `payload_crc32 u32` |
| 20 | `catalog_rev u16`, `reserved u16` |
| 24 | `git_hash u32`, `build_day u16`, `reserved u16` |
| 32 | `name` 24 bayt ASCII |
| 56 | `reserved u32` |
| 60 | `header_crc32 u32` (ilk 60 bayt) |

CRC32: IEEE 802.3 (zlib). Kart başlığı ofset 0'da doğrular; `model`/`hw_rev` uymazsa `BAD_IMAGE`.

## 10. Zamanlama özeti

| Olay | Değer |
|---|---|
| HEARTBEAT | 500 ms; 1500 ms yoksa kayıp |
| ENUM yanıt gecikmesi | 0–99 ms; host penceresi 150 ms; arka plan taraması 1 s |
| İstek/yanıt zaman aşımı (GET/SET/INFO/COMMAND) | 100 ms, 3 deneme |
| STREAM canlı tutma | host 1 s, kart zaman aşımı 2 s |
| CTRL zaman aşımı | `ctrl.timeout_ms`, varsayılan 200 ms |

## 11. Eski protokol: Cyncoder v3 (FRC)

Üretilmiş Cyncoder 1.4 kartları şu an `DEVTYPE = 10`, `MFR = 8`, `CLASS 0` (telemetri) ve `CLASS 1` (komut) kullanan "Cyncoder v3" protokolünü konuşur (kaynak: `Cygnus9473/CYNcoder`, `CyncoderCANProtocol.java`). CyCAN bu sınıfları (`0x00–0x0F`) kullanmaz; iki protokol aynı hatta çakışmaz. Studio eski kartları ayrı bir sürücüyle tanır ve gösterir. Cyncoder 1.5 firmware'inin CyCAN'e geçmesi önerilir; FRC kullanımı için klasik kip (`can.data_bitrate = 0`) yeterlidir.

## 12. USB-CAN köprüsü

Studio ile hat arasındaki adaptör **slcan** (Lawicel ASCII) konuşur; CAN-FD uzantıları CANable 2.0 firmware'i ile aynıdır (`d`/`D` FD, `b`/`B` FD+BRS çerçeveleri, `Y` veri hızı). Böylece piyasadaki CANable 2.0 sınıfı adaptörler bugünden çalışır, Cygnus USB-CAN ürünü aynı arayüzü sunar.
