// SonnoReis — SONNO istehsalat rəisi (səsli məsləhətçi)
// Yalnız OXUYUR: bazada heç nəyi dəyişmir.
// Lazım olan Vercel açarı: OPENAI_KEY (artıq mövcuddur, /api/ai də onu işlədir)

export const config = { maxDuration: 60 };

const SUPA_URL = process.env.SUPABASE_URL || 'https://vtnsamrkmnvbqecvcwrp.supabase.co';
const SUPA_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ0bnNhbXJrbW52YnFlY3Zjd3JwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzMDUzNzIsImV4cCI6MjA5MTg4MTM3Mn0.rYZc1Pl64NwlduQSgXM79Fulr_V5BhwE-eQ_rQAZ4Eo';
const OPENAI = 'https://api.openai.com/v1';
const CHAT_MODEL = process.env.REIS_MODEL || 'gpt-4o';
const VOICE = process.env.REIS_VOICE || 'onyx';

const DEPTS = {
  hazirlik: 'Astar', bez_kesim: 'Bel kəsim', oturacaq_dik: 'Divan Dərzi', ayaq_bagla: 'Ayaq bağlama',
  bel_eyme: 'Bel əymə', karkaz: 'Karkaz yığım', divan_karkaz: 'Divan karkaz', divan_yastiqlama: 'Divan yastıqlama',
  shkurka: 'Şkurka', masa_karkaz: 'Masa karkaz', masa_rengle: 'Masa rəngləmə', masa_shkurka: 'Masa şkurka',
  masa_mexanizm: 'Masa mexanizm + Cildləmə', rengleme: 'Rənglənmə', yastiqlama: 'Yastıqlama / Döşəmə',
  tikis: 'Tikiş', qa: 'Keyfiyyət yoxlama', logistics: 'Logistika / Çatdırılma',
  fabrik: 'Bütün fabrik'
};

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

async function rpc(fn, args) {
  const r = await fetch(`${SUPA_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args || {})
  });
  if (!r.ok) throw new Error(`${fn}: ${r.status} ${await r.text()}`);
  return r.json();
}

const TOOLS = [
  { type: 'function', function: { name: 'sobe_tapsiriqlari', description: 'Bir şöbənin hazırda açıq olan tapşırıqları (gecikmə, son tarix, başlanıb-başlanmayıb).',
      parameters: { type: 'object', properties: { dept_key: { type: 'string', enum: Object.keys(DEPTS).filter(k => k !== 'fabrik') } }, required: ['dept_key'] } } },
  { type: 'function', function: { name: 'umumi_veziyyet', description: 'Bütün şöbələrin yükü: açıq tapşırıq, gecikən, norma saatı.',
      parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'sifaris_melumati', description: 'Bir sifarişin tam vəziyyəti: model, parça, mərhələlər, kim tamamlayıb.',
      parameters: { type: 'object', properties: { sifaris_nomresi: { type: 'string', description: 'Məs: SON-44191 və ya 44191' } }, required: ['sifaris_nomresi'] } } },
  { type: 'function', function: { name: 'sobe_statistikasi', description: 'Şöbənin son N gündə tamamladığı iş, işçilərə görə bölgü, işçi siyahısı.',
      parameters: { type: 'object', properties: { dept_key: { type: 'string', enum: Object.keys(DEPTS).filter(k => k !== 'fabrik') }, gun: { type: 'integer', minimum: 1, maximum: 90 } }, required: ['dept_key'] } } }
];

async function runTool(name, args) {
  try {
    if (name === 'sobe_tapsiriqlari') return await rpc('reis_dept_tasks', { p_dept: args.dept_key });
    if (name === 'umumi_veziyyet') {
      const rows = await rpc('reis_overview', {});
      return (rows || []).map(r => ({ ...r, sobe: DEPTS[r.dept_key] || r.dept_key }));
    }
    if (name === 'sifaris_melumati') return (await rpc('reis_order', { p_num: String(args.sifaris_nomresi || '').trim() })) || { xeta: 'Sifariş tapılmadı' };
    if (name === 'sobe_statistikasi') return await rpc('reis_dept_stats', { p_dept: args.dept_key, p_days: args.gun || 7 });
    return { xeta: 'Naməlum alət' };
  } catch (e) {
    return { xeta: 'Məlumat alınmadı: ' + e.message };
  }
}

function bakuNow() {
  return new Date().toLocaleString('az-AZ', { timeZone: 'Asia/Baku', weekday: 'long', day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' });
}

function factoryPrompt(overview) {
  return `Sən SonnoReis-sən — SONNO mebel fabrikinin (Bakı, Rəşid Behbudov 77A) istehsalat rəisi. 25 illik təcrübən var: stul və kreslo karkası, bel əymə, şkurka, astar və rəngləmə, divan karkası, yastıqlama və döşəmə, tikiş, masa istehsalı.
İndi fabrik RƏHBƏRLİYİ (admin və menecerlər) ilə danışırsan. İndiki vaxt: ${bakuNow()} (Bakı).

QAYDALAR:
- HƏMİŞƏ yalnız Azərbaycan dilində (latın əlifbası) danış.
- Cavabın səslə oxunacaq: qısa və konkret, 3-5 cümlə. Siyahı, ulduz, markdown işlətmə.
- Rəhbərə hesabat verən təcrübəli rəis kimi danış: əsas problemi, darboğazı və təklifini de.
- Rəqəmləri HEÇ VAXT uydurma; yalnız aşağıdakı vəziyyətdən və alətlərdən götür. Konkret şöbə və ya sifariş üçün alətlərdən istifadə et.
- Sən sistemdə heç nəyi dəyişə bilmirsən, yalnız məsləhət verirsən.
- İş müddəti statistikasında gecə və fasilələr də sayıla bilər; nəticə çıxaranda bunu nəzərə al.

BÜTÜN ŞÖBƏLƏRİN CARİ VƏZİYYƏTİ (canlı bazadan): ${JSON.stringify(overview)}`;
}

function systemPrompt(dept, tasks, stats, mode) {
  const deptName = DEPTS[dept] || dept;
  const workers = (stats && stats.isciler) || [];
  return `Sən SonnoReis-sən — SONNO mebel fabrikinin (Bakı, Rəşid Behbudov 77A) istehsalat rəisi.
25 illik təcrübən var: stul və kreslo karkası, buxarla bel əymə, ayaq bağlama, şkurka, astar və rəngləmə, divan karkası, yastıqlama və döşəmə, tikiş, masa istehsalı, keyfiyyət yoxlaması. Ağacın nəmliyi, yapışqanın quruma vaxtı, şkurka dənəsinin ardıcıllığı, astar-rəng qatları, döşəmədə parçanın gərginliyi kimi incəlikləri dərindən bilirsən.

İndi ${deptName} şöbəsinin planşetindəsən. İndiki vaxt: ${bakuNow()} (Bakı).
Bu şöbənin işçiləri: ${workers.length ? workers.join(', ') : 'sistemdə qeydiyyatda deyil'}.

QAYDALAR:
- HƏMİŞƏ yalnız Azərbaycan dilində (latın əlifbası) danış. İşçi rusca danışsa belə, Azərbaycan dilində cavab ver.
- Cavabın SƏSLƏ oxunacaq: qısa danış, 2-4 cümlə. Siyahı, ulduz, markdown işlətmə. Rəqəmləri sadə yaz.
- Rəis kimi danış: hörmətli, amma qətiyyətli və konkret. Hər cavabda aydın növbəti addım ver: kim, nəyi, hansı ardıcıllıqla etsin.
- İşçilərə adı ilə müraciət et. İşi işçilər arasında bölərkən yalnız yuxarıdakı işçi siyahısından ad seç.
- Sifariş, gecikmə, rəqəm barədə HEÇ VAXT uydurma. Məlumatı yalnız aşağıdakı cari vəziyyətdən və alətlərdən götür. Bilmirsənsə, bilmədiyini de.
- Sən sistemdə heç nəyi dəyişə bilmirsən. "Başla", "Tamamla" kimi əməliyyatları işçi özü ekranda etməlidir; bunu ona xatırlat.
- Prioritet qaydası: əvvəl gecikənlər (ən çox gecikən birinci), sonra son tarixi ən yaxın olanlar, sonra başlanmışları bitirmək.
- İş müddəti statistikasında gecə və fasilələr də sayıla bilər; buna görə işçini müddətə görə qınama.
- Təhlükəsizlik barədə soruşsalar (dəzgah, kəsici alət, boya buxarı, toz), ciddi və düzgün məsləhət ver.
- İstehsalatla bağlı olmayan suallara bir cümlə ilə cavab ver və işə qaytar.
${mode === 'brief' ? `
İNDİ SƏNDƏN XƏBƏRDARLIQ İSTƏNİR: işçilər heç nə soruşmayıb. Şöbəyə özün müraciət et. Gecikən və ya təcili iş varsa, ən vacib bir-iki sifarişi adla və nömrə ilə de və kim nəyi etsin göstər. 2-3 cümlədən çox olmasın.` : ''}

${deptName.toUpperCase()} ŞÖBƏSİNİN CARİ VƏZİYYƏTİ (canlı bazadan):
Açıq tapşırıqlar: ${JSON.stringify(tasks)}
Son 7 gün: ${JSON.stringify(stats ? { tamamlanan_tapsiriq: stats.tamamlanan_tapsiriq, mehsul: stats.mehsul, iscilere_gore: stats.iscilere_gore } : {})}

Başqa şöbə, bütün fabrik və ya konkret sifariş lazım olsa, alətlərdən istifadə et.`;
}

async function openaiJSON(path, body) {
  const r = await fetch(`${OPENAI}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_KEY}` },
    body: JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error?.message || `OpenAI ${r.status}`);
  return data;
}

async function think(dept, history, mode) {
  if (dept === 'fabrik') {
    if (mode === 'brief') return { text: '', has_late: false };
    const overview = (await rpc('reis_overview', {}).catch(() => [])).map(r => ({ ...r, sobe: DEPTS[r.dept_key] || r.dept_key }));
    return converse([{ role: 'system', content: factoryPrompt(overview) }], history);
  }
  const [tasks, stats] = await Promise.all([
    rpc('reis_dept_tasks', { p_dept: dept }).catch(() => []),
    rpc('reis_dept_stats', { p_dept: dept, p_days: 7 }).catch(() => null)
  ]);
  if (mode === 'brief') {
    const late = (tasks || []).filter(t => t.days_late > 0);
    if (!late.length) return { text: '', has_late: false };
  }
  const messages = [{ role: 'system', content: systemPrompt(dept, tasks, stats, mode) }];
  if (mode === 'brief') return converse(messages, [{ role: 'user', content: '(Avtomatik xəbərdarlıq vaxtıdır. Şöbəyə qısa göstəriş ver.)' }]);
  return converse(messages, history);
}

async function converse(messages, history) {
  (history || []).slice(-10).forEach(m => {
    if ((m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') messages.push({ role: m.role, content: m.content.slice(0, 2000) });
  });

  for (let i = 0; i < 4; i++) {
    const out = await openaiJSON('/chat/completions', { model: CHAT_MODEL, messages, tools: TOOLS, temperature: 0.4, max_tokens: 400 });
    const msg = out.choices?.[0]?.message;
    if (!msg) break;
    if (msg.tool_calls && msg.tool_calls.length) {
      messages.push(msg);
      for (const tc of msg.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) {}
        const result = await runTool(tc.function.name, args);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 12000) });
      }
      continue;
    }
    return { text: (msg.content || '').trim(), has_late: true };
  }
  return { text: 'Bağışla, indi cavab hazırlaya bilmədim. Bir də soruş.', has_late: false };
}

async function speak(text) {
  if (!text) return null;
  const body = {
    input: text.slice(0, 1500), voice: VOICE, response_format: 'mp3',
    instructions: 'Azərbaycan dilində danış. Təcrübəli, sakit, inamlı fabrik rəisi kimi; aydın, orta sürətlə, Azərbaycan tələffüzü ilə.'
  };
  for (const model of ['gpt-4o-mini-tts', 'tts-1']) {
    const r = await fetch(`${OPENAI}/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_KEY}` },
      body: JSON.stringify(model === 'tts-1' ? { model, input: body.input, voice: VOICE, response_format: 'mp3' } : { model, ...body })
    });
    if (r.ok) return Buffer.from(await r.arrayBuffer()).toString('base64');
  }
  return null;
}

async function transcribe(b64, mime, dept) {
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 1200) return '';
  const ext = /mp4|m4a|aac/.test(mime) ? 'mp4' : /ogg/.test(mime) ? 'ogg' : /wav/.test(mime) ? 'wav' : 'webm';
  const hint = `SONNO mebel fabriki. Şöbə: ${DEPTS[dept] || ''}. Sözlər: karkaz, bel əymə, şkurka, astar, rəngləmə, yastıqlama, döşəmə, tikiş, masa, divan, stul, sifariş, SON, gecikir, tamamla, başla.`;
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
  if (req.method === 'GET') return res.status(200).json({ ok: true, name: 'SonnoReis', key: !!process.env.OPENAI_KEY });
  if (!process.env.OPENAI_KEY) return res.status(500).json({ error: 'OPENAI_KEY Vercel-də qurulmayıb' });

  const { action, dept, messages, audio, mime, speak: wantVoice = true } = req.body || {};
  const d = DEPTS[dept] ? dept : 'karkaz';
  if (action === 'status') {
    const off = await disabledDepts();
    return res.status(200).json({ dept: d, enabled: !off.includes(d) });
  }
  if (d !== 'fabrik' && (await disabledDepts()).includes(d)) {
    return res.status(403).json({ error: 'Bu şöbə üçün SonnoReis Admin tərəfindən söndürülüb', disabled: true });
  }
  try {
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
