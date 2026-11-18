# Araç şablonları ve araç yapılandırması

Amaç: Cygnus ekosistemini kullanan takım, aracını (Mission Planner / QGroundControl'deki çerçeve seçimi gibi) bir şablondan kurar: şase şemasında yuvaları görür, hattaki kartları yuvalara atar, numara/ad/yön/hazır ayarlar tek seferde yazılır. Sonrasında **Araç** ekranı canlı telemetriyi şema üzerinde gösterir.

Şablonlar saf veridir ve `@cygnus/vehicles` paketinde (`packages/vehicles/`) yaşar; simülatör senaryoları ve arayüz aynı şablonları kullanır.

## Sözleşme (`packages/vehicles/src/types.ts`)

```ts
type LocalizedText = { tr: string; en: string };

type SlotRole =
  | 'drive' | 'steer' | 'thruster' | 'propeller' | 'joint' | 'pan' | 'tilt' | 'surface' | 'gripper' | 'aux' // eyleyiciler
  | 'steerEncoder' | 'jointEncoder' | 'encoder' | 'gyro'                                                    // sensörler
  | 'power' | 'computePower' | 'display';                                                                   // altyapı

/** Katalog model anahtarı (ModelDef.key). `channel`: 16 kanallı servo kartının tek kanalı. */
interface SlotAccept { model: string; via: 'device' | 'channel' }

interface VehicleSlot {
  id: string;                    // 'fl.drive', 'thr.3', 'gyro'
  role: SlotRole;
  label: LocalizedText;          // 'Ön sol · sürüş'
  group?: string;                // aynı modül/eklem: 'fl'
  accepts: SlotAccept[];
  required: boolean;
  pos: { x: number; y: number }; // şema koordinatı, −1..1; +x sağ, +y ileri (araç burnu yukarı)
  headingDeg?: number;           // itki/teker yönü oku (0 = ileri, saat yönü +)
  spin?: 'cw' | 'ccw';           // pervane dönüş yönü
  suggestedNum?: number;         // önerilen cihaz numarası
  presets?: Record<string, number>; // atamada önerilen parametreler (katalog anahtarı → değer)
}

interface VehicleTemplate {
  id: string;                    // 'frc.swerve4'
  category: 'frc' | 'ground' | 'air' | 'underwater' | 'surface' | 'defense' | 'arm' | 'custom';
  name: LocalizedText;
  description: LocalizedText;
  competitions: string[];        // 'FRC', 'İKA', 'Su Altı', 'Savaşan İHA' …
  shape: 'rect' | 'x-frame' | 'plus-frame' | 'hexa-frame' | 'octo-frame' | 'plane' | 'rov' | 'hull' | 'turret' | 'arm' | 'free';
  size: { w: number; h: number }; // şema en-boy oranı
  slots: VehicleSlot[];
}

type SlotBinding =
  | { kind: 'device'; uid48: string; model: string }                 // uid48 onaltılık
  | { kind: 'channel'; uid48: string; model: string; channel: number }
  | { kind: 'external'; canId?: number; note: string };              // Cygnus dışı cihaz (ör. FRC'de onaylı sürücü)

interface VehicleConfig {
  templateId: string;
  name: string;
  bindings: Record<string, SlotBinding>;   // slot id → atama
}
```

Paket ayrıca şunları sağlar: `templates` listesi, `getTemplate(id)`, `validateTemplate`, `validateConfig(template, config)` (eksik zorunlu yuva, aynı kartın iki yuvaya atanması, uyumsuz model), `planApply(template, config, devices)` → uygulanacak değişiklik listesi (numara ataması, ad, parametre hazır ayarları) — saf fonksiyon, yan etkisiz. Planı host API'siyle uygulayan `applyPlan(bus, plan, { onStep, persist })`, hattaki kartları plan girdisine çeviren `planDevices(bus)` ve "elle çevir, bulsun" yardımcıları `detectMovedEncoder` / `detectTiltedGyro` de bu pakettedir.

## Şablonlar

| id | Araç | Yuvalar |
|---|---|---|
| `frc.swerve4` | Swerve şase | 4 modül × (sürüş motoru, dönüş motoru, dönüş encoder'ı) + gyro + güç dağıtım |
| `frc.tank` | Tank (diferansiyel) | sol/sağ 2'şer veya 3'er motor (isteğe bağlı), 2 encoder, gyro, güç |
| `frc.mecanum4` | Mecanum | 4 sürüş, gyro, güç |
| `ground.skid4` | İKA 4 teker | 4 sürüş, gyro, güç, SoC regülatörü |
| `ground.skid6` | İKA 6 teker | 6 sürüş, gyro, güç, SoC regülatörü |
| `ground.ackermann` | Ackermann (Robotaksi) | 1–2 sürüş, direksiyon eyleyicisi, direksiyon encoder'ı, gyro, güç, SoC regülatörü |
| `air.quadx` / `air.quadplus` | Quadcopter X / + | 4 pervane (cw/ccw), gyro, güç (küçük), SoC regülatörü |
| `air.hexax` / `air.octox` | Hexa / Okto | 6 / 8 pervane, gyro, güç, SoC regülatörü |
| `air.plane` | Sabit kanat (Savaşan İHA) | 1 itki motoru, kanatçık ×2, irtifa, dümen (servo kanalları), güç, SoC regülatörü |
| `underwater.rov6` | Su altı, 6 itici (vektörel) | 4 yatay (45°) + 2 dikey itici, gyro, kıskaç, güç, SoC regülatörü |
| `underwater.rov8` | Su altı, 8 itici | 4 yatay + 4 dikey itici, gyro, kıskaç, güç, SoC regülatörü |
| `surface.usv2` | İDA, çift itici | 2 itici, gyro, güç, SoC regülatörü |
| `defense.turret` | Taret (Çelikkubbe) | yatay + dikey eksen eyleyicisi, 2 encoder, gyro, güç |
| `arm.arm4` | Robot kol, 4 eksen | 4 eklem (sızdırmaz servo veya servo kanalı), kıskaç, eklem encoder'ları (isteğe bağlı) |
| `custom.empty` | Boş şablon | kullanıcı yuvaları kendi ekler |

Kurallar:

- Motor yuvaları `esc20`/`esc80` kabul eder; itici ve pervane yuvaları ayrıca servo kartı **kanalını** kabul eder (PWM ESC sürmek için). Kontrol yüzeyi ve kıskaç yuvaları sızdırmaz servoyu veya servo kanalını kabul eder.
- Her eyleyici yuvası **harici cihaz** olarak da işaretlenebilir (FRC'de motor sürücüleri onaylı listeden olmak zorundadır; Studio yalnızca numarasını ve notunu tutar).
- Numara önerisi: FRC swerve'de sürüş 1–4, dönüş 5–8, encoder 1–4 (ön sol → ön sağ → arka sol → arka sağ); diğerlerinde yuva sırası.

## Arayüz akışı (Araç ekranı)

1. **Şablon seç**: kategori süzgeci, yarışma etiketleri, şema önizlemesi.
2. **Kartları ata**: şemada yuvalar; yanda hattaki atanmamış kartlar. Atama yolları: listeden seç / sürükle-bırak · "LED'le tanıt" · **elle çevir, bulsun** (encoder: konumu en çok değişen kart; gyro: eğilen kart) · **motor testi** (seçili yuvayı 1 s düşük güçte döndür; sürme güvenlik kuralları geçerli, pervane uyarısı).
3. **Yön ve hazır ayarlar**: yuva başına yön çevir, dişli oranı, pervane yönü denetimi.
4. **Uygula**: `planApply` çıktısı fark listesi olarak gösterilir; onayla → numaralar atanır, adlar ve parametreler yazılır, kartlara kaydedilir.
5. **Canlı görünüm**: şema üzerinde motor çıkışları, encoder açıları, gyro yönü (şase döner), güç dağıtım akımları; eksik/çevrimdışı yuvalar işaretli. Araç yapılandırması proje dosyasına kaydedilir.
