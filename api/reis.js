// SonnoReis — SONNO fabrikinin istehsalat direktoru (səsli məsləhətçi)
// Yalnız OXUYUR: bazada heç nəyi dəyişmir.
// Lazım olan Vercel açarı: OPENAI_KEY (artıq mövcuddur, /api/ai də onu işlədir)
// İstəyə bağlı: REIS_MODEL (məs. gpt-5.1), REIS_VOICE (məs. onyx)

export const config = { maxDuration: 60 };

const SUPA_URL = process.env.SUPABASE_URL || 'https://vtnsamrkmnvbqecvcwrp.supabase.co';
const SUPA_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ0bnNhbXJrbW52YnFlY3Zjd3JwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzMDUzNzIsImV4cCI6MjA5MTg4MTM3Mn0.rYZc1Pl64NwlduQSgXM79Fulr_V5BhwE-eQ_rQAZ4Eo';
const OPENAI = 'https://api.openai.com/v1';
const VOICE = process.env.REIS_VOICE || 'onyx';

// Sürətli model (danışıq üçün): düşünmə mərhələsi olmayan gpt-4.1; olmasa gpt-4o.
// Başqa model üçün Vercel-də REIS_MODEL təyin etmək olar.
const MODELS = [...new Set([process.env.REIS_MODEL, 'gpt-4.1', 'gpt-4o'].filter(Boolean))];
let workingModel = null;

const DEPTS = {
  hazirlik: 'Astar', bez_kesim: 'Bel kəsim', oturacaq_dik: 'Divan Dərzi', ayaq_bagla: 'Ayaq bağlama',
  bel_eyme: 'Bel əymə', karkaz: 'Karkaz yığım', divan_karkaz: 'Divan karkaz', divan_yastiqlama: 'Divan yastıqlama',
  shkurka: 'Şkurka', masa_karkaz: 'Masa karkaz', masa_rengle: 'Masa rəngləmə', masa_shkurka: 'Masa şkurka',
  masa_mexanizm: 'Masa mexanizm + Cildləmə', rengleme: 'Rənglənmə', yastiqlama: 'Yastıqlama / Döşəmə',
  tikis: 'Tikiş', qa: 'Keyfiyyət yoxlama', logistics: 'Logistika / Çatdırılma', cutting: 'Lent kəsim',
  fabrik: 'Bütün fabrik'
};

async function rpc(fn, args) {
  const r = await fetch(`${SUPA_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args || {})
  });
  if (!r.ok) throw new Error(`${fn}: ${r.status} ${await r.text()}`);
  return r.json();
}

// Admin şöbələrə görə söndürə bilir: app_settings.reis_disabled = "karkaz,tikis,..."
async function disabledDepts() {
  try {
    const r = await fetch(`${SUPA_URL}/rest/v1/app_settings?key=eq.reis_disabled&select=value`, {
      headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` }
    });
    const rows = await r.json();
    return String((rows && rows[0] && rows[0].value) || '').split(',').map(s => s.trim()).filter(Boolean);
  } catch (e) { return []; }
}

const DEPT_KEYS = Object.keys(DEPTS).filter(k => k !== 'fabrik');
const TOOLS = [
  { type: 'function', function: { name: 'sobe_tapsiriqlari', description: 'Bir şöbənin hazırda açıq olan tapşırıqları (gecikmə günü, son tarix, başlanıb-başlanmayıb).',
      parameters: { type: 'object', properties: { dept_key: { type: 'string', enum: DEPT_KEYS } }, required: ['dept_key'] } } },
  { type: 'function', function: { name: 'umumi_veziyyet', description: 'Bütün şöbələrin yükü: açıq tapşırıq, gecikən, norma saatı, ən çox gecikmə.',
      parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'sifaris_melumati', description: 'Bir sifarişin tam vəziyyəti: model, parça, rəng, qeyd, mərhələlər, kim tamamlayıb.',
      parameters: { type: 'object', properties: { sifaris_nomresi: { type: 'string', description: 'Məs: SON-44191 və ya 44191' } }, required: ['sifaris_nomresi'] } } },
  { type: 'function', function: { name: 'fabrik_statistikasi', description: 'Bütün fabrik üzrə rəqəmli analiz: N gündə yeni sifariş, təslim, hər şöbənin tamamladığı iş, açıq və gecikən işlər.',
      parameters: { type: 'object', properties: { gun: { type: 'integer', minimum: 1, maximum: 90 } } } } },
  { type: 'function', function: { name: 'menecerler', description: 'Menecerlər üzrə N gündə: sifariş, məhsul, satış məbləği, təslim, müştəri sayı; indi aktiv və gecikən sifarişləri.',
      parameters: { type: 'object', properties: { gun: { type: 'integer', minimum: 1, maximum: 365 } } } } },
  { type: 'function', function: { name: 'sobe_statistikasi', description: 'Şöbənin son N gündə tamamladığı iş, işçilərə görə bölgü, heyət və vəzifələr.',
      parameters: { type: 'object', properties: { dept_key: { type: 'string', enum: DEPT_KEYS }, gun: { type: 'integer', minimum: 1, maximum: 90 } }, required: ['dept_key'] } } }
];

// Şöbə işçiləri üçün: yalnız öz şöbəsi, müştəri və maliyyə yoxdur
const DEPT_TOOLS = [
  { type: 'function', function: { name: 'sobe_tapsiriqlari', description: 'Bu şöbənin hazırda açıq olan tapşırıqları (gecikmə günü, son tarix, başlanıb-başlanmayıb).',
      parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'sifaris_melumati', description: 'Bir sifarişin istehsal vəziyyəti: model, ədəd, parça, rəng, qeyd, mərhələlər, kim tamamlayıb.',
      parameters: { type: 'object', properties: { sifaris_nomresi: { type: 'string', description: 'Məs: SON-44191 və ya 44191' } }, required: ['sifaris_nomresi'] } } },
  { type: 'function', function: { name: 'sobe_statistikasi', description: 'Bu şöbənin son N gündə tamamladığı iş və işçilərə görə bölgü.',
      parameters: { type: 'object', properties: { gun: { type: 'integer', minimum: 1, maximum: 90 } } } } }
];
const FINANCE_KEYS = ['client', 'musteri', 'client_phone', 'sale_price', 'final_price', 'total_amount', 'discount', 'price', 'qiymet', 'mebleg', 'cost_price'];
function stripFinance(x) {
  if (Array.isArray(x)) return x.map(stripFinance);
  if (x && typeof x === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(x)) if (!FINANCE_KEYS.includes(k)) o[k] = stripFinance(v);
    return o;
  }
  return x;
}

async function runToolScoped(name, args, scope) {
  if (scope === 'fabrik') return runTool(name, args);
  // Şöbə rejimi: başqa şöbəyə və fabrik rəqəmlərinə giriş yoxdur
  if (name === 'sobe_tapsiriqlari') return stripFinance(await runTool(name, { dept_key: scope }));
  if (name === 'sobe_statistikasi') return stripFinance(await runTool(name, { dept_key: scope, gun: args.gun }));
  if (name === 'sifaris_melumati') return stripFinance(await runTool(name, args));
  return { xeta: 'Bu məlumat şöbə ekranından açıq deyil.' };
}

async function runTool(name, args) {
  try {
    if (name === 'sobe_tapsiriqlari') return await rpc('reis_dept_tasks', { p_dept: args.dept_key });
    if (name === 'umumi_veziyyet') return (await rpc('reis_overview', {}) || []).map(r => ({ ...r, sobe: DEPTS[r.dept_key] || r.dept_key }));
    if (name === 'sifaris_melumati') return (await rpc('reis_order', { p_num: String(args.sifaris_nomresi || '').trim() })) || { xeta: 'Sifariş tapılmadı' };
    if (name === 'sobe_statistikasi') return await rpc('reis_dept_stats', { p_dept: args.dept_key, p_days: args.gun || 7 });
    if (name === 'fabrik_statistikasi') return named(await rpc('reis_factory_stats', { p_days: args.gun || 7 }));
    if (name === 'menecerler') return await rpc('reis_managers', { p_days: args.gun || 30 });
    return { xeta: 'Naməlum alət' };
  } catch (e) {
    return { xeta: 'Məlumat alınmadı: ' + e.message };
  }
}

function named(st) {
  if (st && Array.isArray(st.sobeler)) st.sobeler = st.sobeler.map(s => ({ ...s, sobe: DEPTS[s.sobe] || s.sobe }));
  return st;
}

function bakuNow() {
  return new Date().toLocaleString('az-AZ', { timeZone: 'Asia/Baku', weekday: 'long', day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' });
}

function staffText(all) {
  return (all || []).map(g => {
    const list = (g.isciler || []).map(w => `${w.ad} (${w.vezife}${w.bas_usta ? ', BAŞ USTA' : ''})`).join(', ');
    return `${DEPTS[g.sobe] || g.sobe}: ${list}`;
  }).join('\n');
}

// ───────── XARAKTER ─────────
const PERSONA = `Sən SonnoReis-sən — SONNO mebel fabrikinin (Bakı, Rəşid Behbudov 77A) istehsalat direktoru.
20 ildən çox İtaliyanın Brianza bölgəsində, Almaniyada və Türkiyədə ən güclü premium mebel fabriklərində direktor işləmisən. Stul, kreslo, divan və masa istehsalının hər mərhələsini dünya səviyyəsində bilirsən:
- Ağac və material: fıstıq, palıd, qoz, ağcaqayın kontrplakı, şam, MDF, şpon; ağacın nəmliyi (8-10%), qurutma, lif istiqaməti, çatlamanın qarşısı.
- Stul və karkas: CNC kəsim, şip-paz, dübel və lamel birləşmələri, buxarla bel əymə və şablonda saxlama, yapışqan (PVA D3/D4) və sıxma müddəti, kvadratlıq və simmetriya yoxlaması, ayaq bağlama, tokar işi.
- Səth: şkurka ardıcıllığı (P120, sonra P180, sonra P240-P320), lif boyunca zımpara, toz təmizliyi, astar, ara şkurka, nitrosellüloz və poliuretan lak, rəngin nümunəyə uyğunluğu, quruma və bərkimə vaxtları, boya kamerasında havalandırma.
- Divan və yumşaq mebel: karkas, elastik lent və yay sistemləri, PPU köpüyün sıxlığı və sərtliyi, sintepon, parçanın kəsimi və naxış uyğunluğu, tikiş, döşəmədə gərginlik, künclərin təmizliyi.
- Masa: massiv və şpon üst, kənar emalı, mexanizm, cildləmə, düzlük və tərpənmə yoxlaması.
- İstehsal idarəçiliyi: darboğaz, ardıcıllıq, norma vaxtı, keyfiyyət yoxlaması, təhlükəsizlik (dəzgah, kəsici alət, boya buxarı, toz).

ƏN VACİB QAYDA: RƏQƏMLƏ DANIŞ, MÜHAZİRƏ OXUMA
- Hər cavab konkret faktla başlayır: neçə sifariş, hansı nömrə, neçə gün gecikir, neçə ədəd, kim. Ümumi söz, nəsihət, "həyat dərsi", fəlsəfə YOXDUR.
- Mebel istehsalı biliklərini (ağac, yapışqan, şkurka, lak və s.) YALNIZ texniki sual veriləndə işlət. Soruşulmayıbsa, texnologiyadan danışma.
- Analiz istənəndə belə qur: 1) əsas rəqəm, 2) problemin yeri və səbəbi rəqəmlə (məs. "Divan karkaz 7 gündə 0 iş bitirib, 14 açıq, 9-u gecikir"), 3) müqayisə (ən pis və ən yaxşı şöbə), 4) konkret əmr.
- Rəqəmləri sadə de: "on dörd sifariş, doqquzu gecikir".

XARAKTERİN:
- Sərt, tələbkar rəissən, canlı insan kimi danışırsan: qısa, kəskin cümlələr. Uzun giriş, salam-kəlam yoxdur, birbaşa mətləbə keç.
- Gecikmə görəndə baş ustanı ADI İLƏ çağırıb bir cümlə ilə kəskin danla, sonra əmr ver. Məsələn: "Orxan! SON 61782 iki gündür gecikir. Bu gün saat beşə qədər bitməlidir."
- Yaxşı iş görəndə bir sözlə təriflə: "Afərin."
- Qırmızı xətlər: söyüş, təhqir, alçaltma, şəxsiyyətə toxunmaq, işdən çıxarma və ya maaş kəsmə hədəsi YOXDUR. Sərtliyin işə, nəticəyə və vaxta yönəlib, insanın şəxsiyyətinə yox.
- Hər cavabın sonunda aydın əmr ver: kim, nəyi, nə vaxta qədər.

QAYDALAR:
- HƏMİŞƏ yalnız Azərbaycan dilində (latın əlifbası) danış. İşçi rusca danışsa belə Azərbaycan dilində cavab ver.
- Cavabın SƏSLƏ oxunur: işçilərə 2-4 qısa cümlə, rəhbərliyə analizdə 4-7 qısa cümlə. Siyahı, ulduz, markdown, mötərizə işlətmə. Sifariş nömrəsini "SON 44191" kimi yaz.
- Qeyd: 11 noyabr 2026-da 178 sifariş Admin tərəfindən toplu "təslim edildi" kimi bağlanıb (iş qeydlərində "Admin (toplu təsdiq)"). Təslim və tamamlama rəqəmlərini analiz edəndə bunu nəzərə al və istəsələr bunu ayrıca de.
- Sifariş, gecikmə, rəqəm, işçi adı barədə HEÇ VAXT uydurma. Yalnız aşağıdakı məlumatlardan və alətlərdən götür. Bilmirsənsə, düz de.
- İşi bölərkən yalnız heyət siyahısındakı adları işlət; eyni adlı iki nəfər varsa, vəzifəsi ilə ayır ("tokar Əli").
- Sən sistemdə heç nəyi dəyişə bilmirsən; "Başla" və "Tamamla"nı işçi özü ekranda basmalıdır, bunu tələb et.
- Prioritet: əvvəl ən çox gecikən, sonra son tarixi ən yaxın olan, sonra başlanmışı bitirmək.
- İş müddəti statistikasına gecə və fasilələr də düşə bilər; işçini yalnız müddət rəqəminə görə ittiham etmə.
- İstehsalatla bağlı olmayan suala bir cümlə ilə cavab ver və işə qaytar.`;

function deptPrompt(dept, tasks, stats, staff, mode) {
  const deptName = DEPTS[dept] || dept;
  const own = ((stats && stats.isciler) || []).map(w => `${w.ad} (${w.vezife}${w.bas_usta ? ', BAŞ USTA' : ''})`).join(', ');
  return `${PERSONA}

İndi ${deptName} şöbəsinin planşetindəsən, oradakı işçilərlə üz-üzəsən. İndiki vaxt: ${bakuNow()} (Bakı).
Bu şöbənin heyəti: ${own || 'sistemdə qeydiyyatda deyil'}.
Baş usta varsa, məsuliyyət əvvəlcə ondan soruşulur.

ŞÖBƏ EKRANI QADAĞALARI (çox vacib):
- Burada yalnız ${deptName} şöbəsinin İSTEHSAL işindən danışırsan: açıq tapşırıqlar, gecikmələr, kim yavaş işləyir, hansı iş birinci görülməlidir, texniki istehsal sualları.
- Qiymət, məbləğ, satış, endirim, gəlir, maaş, müştəri adı, müştəri telefonu və ümumiyyətlə maliyyə barədə HEÇ NƏ demirsən. Belə sual gəlsə, qısa de: "Bu sual menecerlərə aiddir. Sən öz işinə bax." və işə qaytar.
- Başqa şöbələrin və bütün fabrikin rəqəmlərini burada açıqlamırsan.
${mode === 'brief' ? `
İNDİ SƏN ÖZÜN GƏLİB XƏBƏRDARLIQ EDİRSƏN: heç kim soruşmayıb. Şöbədə gecikən iş var. Baş ustanı (yoxdursa, şöbəni) adla çağır, ən çox gecikən bir-iki sifarişi nömrəsi ilə de, sərt danla və konkret əmr ver. 2-4 cümlə.` : ''}

${deptName.toUpperCase()} ŞÖBƏSİNİN CARİ VƏZİYYƏTİ (canlı bazadan):
Açıq tapşırıqlar: ${JSON.stringify(tasks)}
Son 7 gün: ${JSON.stringify(stats ? { tamamlanan_tapsiriq: stats.tamamlanan_tapsiriq, mehsul: stats.mehsul, iscilere_gore: stats.iscilere_gore } : {})}

BÜTÜN FABRİKİN HEYƏTİ:
${staffText(staff)}

Başqa şöbə, bütün fabrik və ya konkret sifariş lazım olsa, alətlərdən istifadə et.`;
}

function factoryPrompt(overview, staff, stats, managers) {
  return `${PERSONA}

İndi fabrik RƏHBƏRLİYİ (sahibkar, admin, menecerlər) ilə danışırsan. Onlara hesabat verən direktorsan: işçilərlə sərtsən, rəhbərliklə isə düz, qısa, faktlarla danışırsan. Əsas problemi, darboğazı, məsul baş ustanı və təklifini de. İndiki vaxt: ${bakuNow()} (Bakı).

BÜTÜN ŞÖBƏLƏRİN CARİ VƏZİYYƏTİ (canlı bazadan): ${JSON.stringify(overview)}
SON 7 GÜNÜN RƏQƏMLƏRİ: ${JSON.stringify(stats)}
MENECERLƏR, SON 30 GÜN (menecer = müştərinin bağlı olduğu menecer; satis_dovr manatla): ${JSON.stringify(managers)}
Başqa dövr istənsə, fabrik_statistikasi və ya menecerler alətini çağır. Məlumat burada varsa, alət çağırmadan dərhal cavab ver.

BÜTÜN FABRİKİN HEYƏTİ:
${staffText(staff)}`;
}

async function openaiJSON(path, body, timeoutMs = 25000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let r;
  try {
    r = await fetch(`${OPENAI}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_KEY}` },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'model timeout' : e.message);
  } finally { clearTimeout(timer); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error?.message || `OpenAI ${r.status}`);
  return data;
}

async function chatCall(messages, tools) {
  const list = workingModel ? [workingModel, ...MODELS.filter(m => m !== workingModel)] : MODELS;
  let lastErr;
  for (const model of list) {
    const reasoning = /^(gpt-5|o\d)/.test(model);
    const body = { model, messages, tools: tools || TOOLS };
    if (reasoning) { body.max_completion_tokens = 3000; body.reasoning_effort = 'low'; }
    else { body.temperature = 0.6; body.max_tokens = 450; }
    try {
      const out = await openaiJSON('/chat/completions', body);
      workingModel = model;
      return out;
    } catch (e) {
      lastErr = e;
      if (!/model|not exist|not found|unsupported|parameter|reasoning|access|timeout/i.test(e.message)) throw e;
    }
  }
  throw lastErr;
}

async function think(dept, history, mode) {
  const staff = await rpc('reis_all_workers', {}).catch(() => []);
  if (dept === 'fabrik') {
    if (mode === 'brief') return { text: '', has_late: false };
    const [ov, st, mg] = await Promise.all([
      rpc('reis_overview', {}).catch(() => []),
      rpc('reis_factory_stats', { p_days: 7 }).catch(() => null),
      rpc('reis_managers', { p_days: 30 }).catch(() => [])
    ]);
    const overview = (ov || []).map(r => ({ ...r, sobe: DEPTS[r.dept_key] || r.dept_key }));
    return converse([{ role: 'system', content: factoryPrompt(overview, staff, named(st), mg) }], history, 'fabrik');
  }
  const [rawTasks, rawStats] = await Promise.all([
    rpc('reis_dept_tasks', { p_dept: dept }).catch(() => []),
    rpc('reis_dept_stats', { p_dept: dept, p_days: 7 }).catch(() => null)
  ]);
  const tasks = stripFinance(rawTasks), stats = stripFinance(rawStats);
  if (mode === 'brief') {
    const late = (tasks || []).filter(t => t.days_late > 0);
    if (!late.length) return { text: '', has_late: false };
    return converse([{ role: 'system', content: deptPrompt(dept, tasks, stats, staff, 'brief') }],
      [{ role: 'user', content: '(Avtomatik yoxlama vaxtıdır. Şöbəyə gəl və göstəriş ver.)' }], dept);
  }
  return converse([{ role: 'system', content: deptPrompt(dept, tasks, stats, staff, 'chat') }], history, dept);
}

async function converse(messages, history, scope) {
  (history || []).slice(-10).forEach(m => {
    if ((m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') messages.push({ role: m.role, content: m.content.slice(0, 2000) });
  });
  for (let i = 0; i < 3; i++) {
    const out = await chatCall(messages, scope === 'fabrik' ? TOOLS : DEPT_TOOLS);
    const msg = out.choices?.[0]?.message;
    if (!msg) break;
    if (msg.tool_calls && msg.tool_calls.length) {
      messages.push(msg);
      for (const tc of msg.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) {}
        const result = await runToolScoped(tc.function.name, args, scope);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 12000) });
      }
      continue;
    }
    const text = (msg.content || '').trim();
    if (text) return { text, has_late: true };
  }
  return { text: 'Bir də de, eşitmədim. Qısa və aydın danış.', has_late: false };
}

async function speak(text) {
  if (!text) return null;
  const input = text.slice(0, 1500);
  const instructions = 'Azərbaycan dilində, Azərbaycan tələffüzü ilə danış. Normal canlı insan danışıq sürətində, bir az cəld danış; uzun fasilə vermə, sözləri uzatma. Ton: sərt, qətiyyətli fabrik rəisi, güclü və aydın səs. Danlayanda kəskin, rəqəmləri aydın de.';
  const tries = [
    { model: 'gpt-4o-mini-tts', input, voice: VOICE, response_format: 'mp3', instructions },
    { model: 'tts-1-hd', input, voice: VOICE, response_format: 'mp3', speed: 1.15 },
    { model: 'tts-1', input, voice: VOICE, response_format: 'mp3', speed: 1.15 }
  ];
  for (const body of tries) {
    const r = await fetch(`${OPENAI}/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_KEY}` },
      body: JSON.stringify(body)
    });
    if (r.ok) return Buffer.from(await r.arrayBuffer()).toString('base64');
  }
  return null;
}

async function transcribe(b64, mime, dept) {
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 1200) return '';
  const ext = /mp4|m4a|aac/.test(mime) ? 'mp4' : /ogg/.test(mime) ? 'ogg' : /wav/.test(mime) ? 'wav' : 'webm';
  const hint = `SONNO mebel fabriki. Şöbə: ${DEPTS[dept] || ''}. Sözlər: karkaz, bel əymə, şkurka, astar, rəngləmə, yastıqlama, döşəmə, tikiş, masa, divan, stul, sifariş, SON, gecikir, tamamla, başla, baş usta.`;
  for (const model of ['gpt-4o-transcribe', 'whisper-1']) {
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: mime || 'audio/webm' }), `soz.${ext}`);
    fd.append('model', model);
    fd.append('language', 'az');
    fd.append('prompt', hint);
    const r = await fetch(`${OPENAI}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_KEY}` }, body: fd });
    if (r.ok) { const d = await r.json(); return (d.text || '').trim(); }
  }
  throw new Error('Səs tanınmadı');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET') return res.status(200).json({ ok: true, name: 'SonnoReis', key: !!process.env.OPENAI_KEY, model: workingModel || MODELS[0] });
  if (!process.env.OPENAI_KEY) return res.status(500).json({ error: 'OPENAI_KEY Vercel-də qurulmayıb' });

  const { action, dept, messages, audio, mime, speak: wantVoice = true } = req.body || {};
  const d = DEPTS[dept] ? dept : 'karkaz';
  if (action === 'status') {
    const off = await disabledDepts();
    return res.status(200).json({ dept: d, enabled: d === 'fabrik' || !off.includes(d) });
  }
  if (d !== 'fabrik' && (await disabledDepts()).includes(d)) {
    return res.status(403).json({ error: 'Bu şöbə üçün SonnoReis Admin tərəfindən söndürülüb', disabled: true });
  }
  try {
    if (action === 'tts') {
      const audioB64 = await speak(String(req.body.text || ''));
      return res.status(200).json({ audio: audioB64 });
    }
    if (action === 'stt') {
      const text = await transcribe(audio || '', mime || 'audio/webm', d);
      return res.status(200).json({ text });
    }
    if (action === 'chat' || action === 'brief') {
      const out = await think(d, messages, action === 'brief' ? 'brief' : 'chat');
      const audioB64 = wantVoice && out.text ? await speak(out.text) : null;
      return res.status(200).json({ text: out.text, has_late: out.has_late, audio: audioB64 });
    }
    return res.status(400).json({ error: 'Naməlum əməliyyat' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
