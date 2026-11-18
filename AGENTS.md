# Çalışma kuralları (bu depoda çalışan her ajan için)

Önce oku: `docs/ARCHITECTURE.md`, `docs/PROTOCOL.md`; cihazlarla ilgili işte `docs/DEVICES.md`. Görevinin dışındaki büyük dosyaları baştan sona okuma; `grep` ile ihtiyacın olan yeri bul.

## Sınırlar

- Yalnızca görevinde sana verilen dizinlerde dosya oluştur/değiştir. Başka bir dizinde değişiklik şartsa yapma; raporunda "İstek" olarak yaz.
- **git komutu çalıştırma** (commit, add, stash, checkout yok). Sürüm yönetimini yönetici yapar. Aynı anda başka ajanlar başka dizinlerde çalışıyor olabilir.
- Yeni bağımlılık ekleme. Gerçekten şartsa `npm install <paket> -w <çalışma-alanı>` kullan ve raporunda gerekçesiyle belirt.
- `docs/PROTOCOL.md` ile çelişen bir şey gerekiyorsa belgeyi değiştirme; raporda "Protokol sorusu" olarak yaz ve belgeye en yakın yorumu uygula.

## Kod

- Kod, tanımlayıcılar ve kod yorumları İngilizce. Kullanıcıya görünen her metin sözlükten gelir (TR varsayılan + EN).
- TypeScript `strict`; `any` yok (`unknown` + daraltma). Varsayılan dışa aktarım yok, adlandırılmış dışa aktarım kullan.
- `@cygnus/protocol` ve `@cygnus/simulator` saf TS'dir: DOM, Node API'si, zamanlayıcı globali kullanmaz; zaman `Scheduler` üzerinden gelir.
- Yorumlar "neden"i anlatsın; kodu tekrar eden yorum yazma. Gereksiz soyutlama, kullanılmayan kod, TODO yığını bırakma.
- Testler `vitest`; gerçek bekleme yok, `ManualScheduler` kullan. Test dosyaları: paketlerde `test/`, uygulamada kaynağın yanında `*.test.ts(x)`.

## Bitirmeden önce

Depo kökünde çalıştır ve hatasız olduğunu gör:

```
npm run typecheck
npx vitest run <kendi test yolun>
```

Arayüz işi yaptıysan uygulamayı aç (`npm run dev -w @cygnus/studio -- --port <boş port>`), `playwright-core` + `/usr/bin/google-chrome` ile ekran görüntüsü al (`executablePath: '/usr/bin/google-chrome'`, `args: ['--no-sandbox']`), görüntüyü kendin incele ve gördüğün kusurları düzelt. Dev sunucusunu ve tarayıcıyı kapatmayı unutma.

## Rapor (son mesajın)

En fazla 250 kelime, Türkçe, düz metin:

1. Ne teslim edildi (dosya/dizin düzeyinde, tek satırlık maddeler).
2. Doğrulama: çalıştırdığın komutlar ve sonuçları (geçen test sayısı).
3. Sonraki ajanların bilmesi gereken arayüzler: yalnızca dosya yolları ve en önemli 5–10 dışa aktarım adı.
4. Açık kalanlar / Protokol soruları / İstekler.

Kod dökme, dosya içeriği yapıştırma.
