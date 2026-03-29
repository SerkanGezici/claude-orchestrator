---
name: mutabakat
description: Claude + Codex + Gemini ile aktif mutabakat analizi (works globally)
---

Kullanici `/mutabakat` komutunu calistirdi. Asagidaki akisi AYNEN izle.

**KRITIK:** Claude bu sistemde PASIF koordinator DEGIL, AKTIF analisttir.
Her turda Claude kendi bagimsiz analizini yapar, diger AI'larla gercek cross-critique gerceklesir.

## RUNNER
`~/.claude/claude-codex/run-orchestration.js`

## WORKSPACE
$(pwd) — komutun calistirildigi dizin

## GOREV
$ARGUMENTS bos ise: "Bu projeyi kapsamli analiz et: guvenlik, mimari, performans, kod kalitesi"

---

## ADIM 0: WORKSPACE DOGRULAMA (ZORUNLU - HER SEFERINDE YAP)

**KRITIK BUG ONLEMI:** Gemini CLI sadece cwd icindeki dosyalari okuyabilir. Yanlis workspace = yanlis proje analizi.

Once Bash tool ile calistir:
```
echo "WORKSPACE_CHECK: $(pwd)" && ls "$(pwd)" | head -10
```

Ciktiyi kontrol et:
1. `$(pwd)` beklenen proje dizinini gosteriyor mu?
2. Dizin iceriginde beklenen dosyalar var mi? (orn: .csproj, package.json, src/, lib/)
3. Eger yanlis dizin gorunuyorsa DURMA, kullaniciya bildir

**WORKSPACE DEGISKENINI KAYDET:** Asagidaki tum komutlarda `"$(pwd)"` yerine bu adimda dogrulanan path'i kullan.

**TIRNAK KURALI:** --workspace parametresine DAIMA cift tirnak icinde path gec. ASLA tirnaksiz path gecme.
- DOGRU: `--workspace "$(pwd)"`
- DOGRU: `--workspace "/mnt/c/Users/serkan/source/repos/Proje Adi"`
- YANLIS: `--workspace $(pwd)`
- YANLIS: `--workspace /mnt/c/Users/serkan/source/repos/Proje Adi`

---

## ADIM 1: SAGLIK KONTROLU

Bash tool ile calistir:
```
node ~/.claude/claude-codex/run-orchestration.js --health-check
```

Ciktiyi oku:
- codex.available ve gemini.available kontrol et
- EN AZ 1 dis worker (Codex veya Gemini) gerekli
- Hicbiri yoksa: "Dis AI worker bulunamadi. Claude tek basina analiz yapacak." de ve sadece Claude analizi yap
- Kullaniciya hangi AI'larin aktif oldugunu bildir

**KATILIMCILAR:** Claude (her zaman) + ulasilabilen dis worker'lar

---

## ADIM 2: TUR DONGUSU (Varsayilan 4 tur, Maks 5 tur)

Her tur icin asagidaki A, B, C adimlarini tekrarla:

### 2A: CLAUDE'UN BAGIMSIZ ANALIZI

Claude olarak SEN kendi analizini yap. Task tool ile Explore subagent kullan:

**TUR 1 icin** (ilk analiz):

Task tool cagir (subagent_type: "Explore"):
```
Prompt: "Su projeyi kapsamli analiz et: [WORKSPACE]
Odak: [GOREV]

ANALIZ GEREKSINIMLERI:
1. GUVENLIK: Input validation, XSS, CSRF, SQL injection, hardcoded credentials, dependency vulnerabilities
2. MIMARI: Coupling, cohesion, design patterns, SOLID, katmanlama
3. PERFORMANS: Memory leak, N+1 query, gereksiz hesaplama, bundle size
4. KOD KALITESI: Dead code, test coverage, hata yonetimi, loglama

KRITIK: Her bulgu icin KANIT goster (dosya:satir, kod ornegi).
Genel tavsiye YASAK, sadece somut bulgular.

=== RAPOR FORMATI (ZORUNLU) ===

BOLUM 1: DETAYLI ANALIZ
Tam analizini dogal dilde INGILIZCE yaz. Istedigin formatta yaz (basliklar, maddeler, paragraflar).
Her bulgu icin dosya:satir referansi ve kod ornegi ZORUNLU.

BOLUM 2: YAPISAL OZET (ZORUNLU - raporun EN SONUNDA)
Raporun en sonuna asagidaki JSON blogunu ekle:
\`\`\`json
{
  \"findings\": [
    {
      \"id\": \"SEC-001\",
      \"title\": \"kisa anahtar kelime odakli baslik\",
      \"severity\": \"critical|high|medium|low\",
      \"category\": \"security|architecture|performance|quality\",
      \"evidence\": \"dosya.js:42 - kisa kanit aciklamasi\"
    }
  ]
}
\`\`\`

BASLIK KURALLARI: Basliklari KISA tut (3-8 kelime), ANAHTAR TEKNIK TERIMLER kullan.
Ornek: 'SQL Injection in User Query', 'Missing CSRF Token Validation', 'N+1 Query in Order Loop'
"
```

Subagent'in dondurdugu RAPORUN TAMAMINI `/tmp/claude-codex-turn-{N}-claude.md` dosyasina Write tool ile kaydet.
KRITIK: Ozet veya baslik YAZMA. Subagent'in urettigi detayli analiz metni + JSON findings blogunu OLDUGU GIBI kaydet.
Bu dosya bir sonraki turda Gemini'ye gonderilecek — eksik rapor = Gemini senin bulgularini goremez.

**TUR 2+ icin** (cross-critique):

Onceki turdaki diger AI raporlarini oku:
```
Read tool: /tmp/claude-codex-workers-turn-{N-1}.json
```
Ayrica kendi onceki raporunu oku:
```
Read tool: /tmp/claude-codex-turn-{N-1}-claude.md
```

Task tool ile Explore subagent cagir:
```
Prompt: "CROSS-CRITIQUE RE-INVESTIGATION: Onceki raporunu ve diger AI'larin raporlarini oku, yeniden arastir, daha kapsamli rapor yaz.

PROJE: [WORKSPACE]

SENIN ONCEKI RAPORUN:
[Claude'un onceki rapor metni]

DIGER AI RAPORLARI:
[Gemini/Codex raporlari]

=== UC ASAMALI CROSS-CRITIQUE PROTOKOLU ===

ASAMA 1 — KESIF (Gap Analizi):
Diger AI'nin raporunu dikkatlice oku ve kendininkiyle karsilastir.
Belirle:
- Diger AI'nin bulup SENIN KACIRDIGIN bulgular — her birini listele
- Senin incelemedigin ama diger AI'nin inceledigi dosya/alanlar
- Daha az bulgun olan kategoriler (security/architecture/performance/quality)
- Diger AI'nin yanlis veya abartili gozuken bulgulari

ASAMA 2 — ARASTIRMA (Derinlemesine Yeniden Analiz):
Asama 1'deki her gap icin:
- Kaynak dosyalari KENDIM oku ve bagimsiz dogrula
- Diger AI'nin bulgusu gecerliyse KENDI kanitin ile destekle (dosya:satir)
- Ayni dosyalarda HICBIR AI'nin bulamadigi EK sorunlar ara
- Onceden inceledigin alanlari tekrar tara — bir sey kacirmis miydin?

Itiraz ettigin bulgular icin:
- Karsi kanit goster (dosya:satir)
- Neden yanlis veya abartili oldugunu acikla

ASAMA 3 — KAPSAMLI RAPOR:
Yeni raporun sunlari ICERMELI:
1. Onceki turdan KORUNAN kendi bulgularin (kanitla)
2. Diger AI'dan DOGRULADIGIN bulgular (KENDI kanitin ile)
3. Bu turda kesfettigin YENI bulgular
4. ITIRAZ ettigin bulgular (karsi kanitla)

KRITIK KURALLAR:
- Raporun onceki turundan DAHA KAPSAMLI olmali
- Bulgu sayisi ARTMALI veya en az ayni kalmali (geri cekmeler icin kanit zorunlu)
- Sadece 'katiliyorum' YETMEZ — dogruladigin bulgular icin KENDI dosya:satir kanitin ver
- Koru korune kabul etme — her bulguyu kodu okuyarak dogrula
- Dogruladigin bulguyu JSON listesine EKLE

=== RAPOR FORMATI (ZORUNLU) ===

BOLUM 1: DETAYLI ANALIZ
Tam analizini dogal dilde INGILIZCE yaz. Her bulgu icin dosya:satir referansi ZORUNLU.

BOLUM 2: YAPISAL OZET (ZORUNLU - raporun EN SONUNDA)
Guncel JSON blogu TUM bulgulari icermeli (korunan + dogrulanan + yeni):
\`\`\`json
{
  \"findings\": [
    {
      \"id\": \"SEC-001\",
      \"title\": \"kisa anahtar kelime odakli baslik\",
      \"severity\": \"critical|high|medium|low\",
      \"category\": \"security|architecture|performance|quality\",
      \"evidence\": \"dosya.js:42 - kisa kanit aciklamasi\"
    }
  ]
}
\`\`\`

BASLIK KURALLARI: Basliklari KISA tut (3-8 kelime), ANAHTAR TEKNIK TERIMLER kullan.
Degismeyen bulgular icin onceki turla AYNI baslik ifadesini kullan.
Diger AI'dan dogrulanan bulgular icin ONLARIN baslik ifadesini kullan.
"
```

Subagent'in dondurdugu RAPORUN TAMAMINI `/tmp/claude-codex-turn-{N}-claude.md` dosyasina Write tool ile kaydet.
KRITIK: Ozet veya baslik YAZMA. Subagent'in urettigi detayli analiz metni + JSON findings blogunu OLDUGU GIBI kaydet.
Bu dosya bir sonraki turda Gemini'ye gonderilecek — eksik rapor = Gemini senin bulgularini goremez.

### 2B: DIS WORKER'LAR (Claude ile PARALEL)

2A ile AYNI ANDA, Bash tool ile `run_in_background: true` kullanarak calistir:

**TUR 1 icin:**
```
node ~/.claude/claude-codex/run-orchestration.js --single-turn --turn 1 --task "$GOREV" --workspace "$(pwd)" 2>/tmp/claude-codex-worker-log.txt
```

**NOT:** Runner otomatik olarak:
- Task metninden gorev turunu algilar (audit/brainstorm/research)
- Task icindeki dosya/dizin yollarini cikarir ve `--include-directories` olarak Gemini'ye iletir
- Brainstorm modunda generic audit sablonunu KULLANMAZ, task'i oldugu gibi iletir
- Brainstorm icin timeout 5dk (audit icin 15dk)

Ek dizinleri manuel de gecebilirsin:
```
node ~/.claude/claude-codex/run-orchestration.js --single-turn --turn 1 --task "$GOREV" --workspace "$(pwd)" --include-dirs "/path/to/other/project" 2>/tmp/claude-codex-worker-log.txt
```

**TUR 2+ icin:**
Once onceki turdaki TUM raporlari (Claude dahil) tek JSON'a birlestir:

Bash ile:
```
node -e "
const fs = require('fs');
const prev = ONCEKI_TUR_NUMARASI;
const allReports = {};
try { allReports.claude = { name: 'claude', report: fs.readFileSync('/tmp/claude-codex-turn-' + prev + '-claude.md', 'utf8'), failed: false }; } catch(e) {}
try { const w = JSON.parse(fs.readFileSync('/tmp/claude-codex-workers-turn-' + prev + '.json', 'utf8')); if (w.workers) { for (const [n,d] of Object.entries(w.workers)) { allReports[n] = d; } } } catch(e) {}
fs.writeFileSync('/tmp/claude-codex-all-reports-turn-' + prev + '.json', JSON.stringify(allReports, null, 2));
console.log('Merged: ' + Object.keys(allReports).join(', '));
"
```
(ONCEKI_TUR_NUMARASI yerine onceki tur numarasini koy)

Sonra worker'lari calistir (arka planda):
```
node ~/.claude/claude-codex/run-orchestration.js --single-turn --turn N --task "$GOREV" --workspace "$(pwd)" --prev-reports /tmp/claude-codex-all-reports-turn-PREV.json 2>/tmp/claude-codex-worker-log.txt
```

### 2C: WORKER BEKLEME + CONVERGENCE KONTROLU

### ⛔ SERT KURAL: WORKER BEKLEME (IHLAL EDILEMEZ)

1. workers-turn-N.json DOSYASI OLUSMADAN final rapor YAZMA
2. "Worker sonucu yok, ben kendim yazarim" DEME — timeout 10dk bekle
3. Kendi analizini "mutabakat raporu" olarak SUNMA — sen analistlerden sadece BIRISIN
4. Worker dosyasi YOKSA → TaskOutput ile BEKLE veya 10dk timeout

SEN (Claude) TEK BASINA MUTABAKAT YAPAMAZSIN.
Mutabakat = birden fazla AI'in uzlastigi bulgular demektir.
Senin raporun tek basina sadece bir GORUS'tur, MUTABAKAT RAPORU degildir.

KONTROL LISTESI (her turda ZORUNLU):
[ ] workers-turn-N.json var mi? → Yoksa BEKLE
[ ] Dosyayi OKUDUN mu?
[ ] Her worker'dan en az 1 bulgu ALINTILADIN mi?
[ ] Ancak BUNLARDAN SONRA final rapora gectin mi?

---

**KRITIK ZAMANLAMA KURALI:** Claude'un 2A analizi genellikle 2-3dk'da biter, dis worker'lar 5-15dk surebilir.
Claude ASLA worker sonuclarini beklemeden final rapora gecmemeli.

**NOT:** ADIM 1'deki saglik kontrolunde hangi worker'larin aktif oldugunu ogrendin.
Bekleme mesajlarinda SADECE aktif worker isimlerini kullan (ornegin sadece Gemini aktifse "Codex" yazma).
Hicbir dis worker aktif degilse (ikisi de unavailable), bekleme adimini ATLA ve direkt Adim 4'e gec.

**2A bittikten sonra ZORUNLU akis:**

#### Adim 1: Worker dosyasini kontrol et

Bash ile calistir:
```
test -f /tmp/claude-codex-workers-turn-N.json && echo "WORKERS_DONE" || echo "WORKERS_PENDING"
```

#### Adim 2: Sonuca gore hareket et

**WORKERS_DONE ise** → Adim 4'e (rapor birlestirme) gec.

**WORKERS_PENDING ise** → Kullaniciya bildir ve BEKLE:
```
"⏳ Claude analizi tamamlandi. [AKTIF_WORKER_ISIMLERI] hala calisiyor... Bekleniyor (maks 10dk)."
```
(Ornek: sadece Gemini aktifse → "Gemini hala calisiyor...", ikisi de aktifse → "Gemini ve Codex hala calisiyor...")

Sonra TaskOutput tool'u ile arka plan Bash gorevinin tamamlanmasini bekle.
Arka plan gorevi tamamlaninca otomatik bildirim gelecek — O ZAMANA KADAR BASKA ISLEM YAPMA.

**ASLA YAPMA:**
- ❌ Worker'lari beklemeden final rapora gecme
- ❌ "Worker raporu yok, tek basima yazayim" deme (timeout olmadan)
- ❌ Kullaniciya "devam edeyim mi?" diye sorma (bekle, bildirim gelecek)

#### Adim 3: Timeout kontrolu (10dk sonra hala bitmemisse)

Eger TaskOutput bildirimi 10 dakika icinde gelmezse:
```
test -f /tmp/claude-codex-workers-turn-N.json && echo "WORKERS_DONE" || echo "WORKERS_TIMEOUT"
```

**WORKERS_TIMEOUT ise:**
- Kullaniciya bildir: "⚠️ [AKTIF_WORKER_ISIMLERI] 10dk icinde yanitlamadi. Claude tek basina devam ediyor."
- Worker log'unu kontrol et: `tail -20 /tmp/claude-codex-worker-log.txt`
- Sadece Claude raporuyla final rapora gec (raporda hangi worker'in katilmadigini belirt)

#### Adim 4: Raporlari birlestir ve convergence olc (TUR 2+ icin)

1. Raporlari birlestir:
```
node -e "
const fs = require('fs');
const turn = MEVCUT_TUR;
const allReports = {};
try { allReports.claude = { name: 'claude', report: fs.readFileSync('/tmp/claude-codex-turn-' + turn + '-claude.md', 'utf8'), failed: false }; } catch(e) {}
try { const w = JSON.parse(fs.readFileSync('/tmp/claude-codex-workers-turn-' + turn + '.json', 'utf8')); if (w.workers) { for (const [n,d] of Object.entries(w.workers)) { allReports[n] = d; } } } catch(e) {}
fs.writeFileSync('/tmp/claude-codex-all-reports-turn-' + turn + '.json', JSON.stringify(allReports, null, 2));
console.log(Object.keys(allReports).join(', '));
"
```

2. Convergence olc — `convergence-judge` AGENT'i kullan (Jaccard degil, SEMANTIK karsilastirma):

Agent tool cagir (subagent_type: "convergence-judge"):
```
Prompt: "Asagidaki iki AI raporunu semantik olarak karsilastir ve mutabakat yuzdesi hesapla.

CLAUDE RAPORU: /tmp/claude-codex-turn-N-claude.md dosyasini oku
GEMINI RAPORU: /tmp/claude-codex-workers-turn-N.json dosyasini oku (workers.gemini.report alani)

JSON formatta cikti ver: convergence_score, matched_findings, claude_only, gemini_only"
```

3. Sonucu degerledir:
- `convergence_score >= 0.70` → TUR DONGUSUNU BITIR, Adim 3'e gec
- `convergence_score < 0.70` ve tur < 5 → Sonraki tura devam
- Tur 4 tamamlandiginda convergence >= 0.60 ise → BITIR (varsayilan 4 tur yeterli)
- Tur 5'e ulasti → Yine Adim 3'e gec (maksimum 5 tur)
- Tur 10'a ulasti → Yine Adim 3'e gec

Kullaniciya her turda ilerleme bilgisi ver:
"TUR N/10 tamamlandi. Katilimcilar: Claude, Gemini, [Codex]. Convergence: %XX"

---

## ADIM 3: FINAL RAPOR

Claude olarak TUM raporlari oku ve KENDISI final raporu yaz:

1. Son turun Claude raporu: `/tmp/claude-codex-turn-{SON}-claude.md`
2. Son turun worker raporlari: `/tmp/claude-codex-workers-turn-{SON}.json`

### ZORUNLU: WORKER BULGULARI ENTEGRASYONU

Final rapor yazmadan ONCE bu tabloyu doldur ve kullaniciya goster:

| # | Worker | Bulgu Basligi | Karar | Gerekce |
|---|--------|---------------|-------|---------|
| 1 | Gemini | [baslik] | KATILIYORUM / ITIRAZ / YENI | [neden?] |
| 2 | Gemini | [baslik] | KATILIYORUM / ITIRAZ / YENI | [neden?] |
| ... | ... | ... | ... | ... |

KURALLAR:
- Her worker'dan EN AZ 2 bulguyu tabloya ekle
- "YENI" = Senin analizinde olmayan, worker'in buldugu bulgu
- "ITIRAZ" icin karsi kanit goster (dosya:satir)
- Bu tablo OLMADAN final rapor GECERSIZDIR
- KATILIYORUM + YENI → final rapora DAHIL ET
- ITIRAZ → final raporda TARTISMALI olarak belirt

---

Bu raporlari sentezle:

### SENTEZ KURALLARI:
- **YUKSEK GUVEN:** 2+ AI ayni bulguyu raporladiysa → Kesin bulgu
- **ORTA GUVEN:** 1 AI buldu, diger(ler)i ne kabul ne reddetmis → Muhtemel bulgu
- **DUSUK GUVEN:** Sadece 1 AI buldu, diger(ler)i reddetmis → Tartismali
- **KANIT ONCELIGI:** Dosya:satir referansi olan bulgular oncelikli
- **ENTEGRASYON:** Final raporda SADECE Claude bulgulari varsa rapor GECERSIZ. Worker bulgularinin en az %30'u final raporda yer almali (katilim veya tartisma olarak).

Final raporu kullaniciya sun:

```
## MUTABAKAT RAPORU

**Katilimcilar:** Claude + [aktif worker'lar]
**Turlar:** X
**Convergence:** %XX

### Yuksek Guvenli Bulgular (2+ AI mutabik)
[Bulgular]

### Orta Guvenli Bulgular
[Bulgular]

### Tartismali Bulgular
[Bulgular ve gerekceler]

### Aksiyon Plani
[Oncelikli duzeltme adimlari]
```

Kullaniciya sor: "Detay ister misin? Veya onerileri uygulamak ister misin?"

---

## Ne Yapar
- 3-AI AKTIF analiz (Claude + Codex + Gemini)
- Claude HER turda bagimsiz analiz yapar (Explore subagent ile)
- Dis worker'lar HER turda bagimsiz analiz yapar (runner --single-turn ile)
- Turlar arasi TUM AI'lar birbirlerinin raporlarini okur ve elestirir
- Convergence: TUM AI'larin raporlari uzerinden olculur (%90 esik)
- Kanit tabanli final rapor (Claude sentezler)

## Tahmini Sure: 5-20 dakika
