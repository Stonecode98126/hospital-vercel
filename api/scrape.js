/**
 * Netlify Function: /api/scrape
 * 用法：GET /api/scrape?url=https://醫院叫號網址
 */

const https = require('https');
const http  = require('http');
const { URL } = require('url');

// ══════════════════════════════════════════════
// 各醫院專屬解析規則
// ══════════════════════════════════════════════
const HOSPITAL_PARSERS = {

  // 國軍桃園總醫院 — 卡片式佈局（依據截圖分析）
  'www.aftygh.gov.tw': (html) => {
    const clinics = [];

    // 方法1：找頁面裡的 JSON 資料變數
    const jsonPatterns = [
      /var\s+\w+\s*=\s*(\[[\s\S]*?\{[\s\S]*?\}[\s\S]*?\]);/g,
      /data\s*[:=]\s*(\[[\s\S]*?\{[\s\S]*?\}[\s\S]*?\])/g,
    ];
    for (const re of jsonPatterns) {
      let m;
      while ((m = re.exec(html)) !== null) {
        try {
          const arr = JSON.parse(m[1]);
          if (!Array.isArray(arr) || arr.length === 0) continue;
          arr.forEach(item => {
            const cur = extractNum(String(item.nowNo||item.NowNo||item.callNo||item.current||''));
            if (!cur) return;
            clinics.push({
              dept:    String(item.deptName||item.DeptName||item.dept||'—'),
              clinic:  String(item.clinicNo||item.ClinicNo||item.roomNo||'—'),
              doctor:  String(item.doctorName||item.DoctorName||item.doctor||'—'),
              current: cur,
            });
          });
          if (clinics.length > 0) return clinics;
        } catch {}
      }
    }

    // 方法2：依截圖結構，每個卡片包含診間編號(4碼)、號碼(3碼)、科別、醫生
    // 截圖顯示: "陳睿俊 0101診間_下午 ... 077 ... 家醫科"
    // 嘗試抓 <td> 或 <div> 裡面符合此格式的內容
    const cardRe = /<(?:td|div|li)[^>]*>([\s\S]*?)<\/(?:td|div|li)>/gi;
    const blocks = [];
    let cm;
    while ((cm = cardRe.exec(html)) !== null) {
      const text = stripTags(cm[1]).trim();
      if (text.length > 2 && text.length < 200) blocks.push(text);
    }

    // 找出所有獨立的 3 位數號碼 block
    const numBlocks = blocks.filter(b => /^\d{3}$/.test(b.trim()));
    numBlocks.forEach(numBlock => {
      const num = parseInt(numBlock.trim());
      if (num <= 0 || num >= 1000) return;
      // 找附近的科別和醫生（前後 5 個 block 範圍內）
      const idx = blocks.indexOf(numBlock);
      const window = blocks.slice(Math.max(0, idx-5), idx+5).join(' ');
      const deptMatch = window.match(/([\u4e00-\u9fff]{2,8}(?:科|診)[\u4e00-\u9fff]{0,6})/);
      const roomMatch = window.match(/(\d{4}診間[^\s]*)/);
      const docMatch  = window.match(/^([\u4e00-\u9fff]{2,4})$/m);
      clinics.push({
        dept:    deptMatch ? deptMatch[1] : '—',
        clinic:  roomMatch ? roomMatch[1] : '—',
        doctor:  docMatch  ? docMatch[1]  : '—',
        current: num,
      });
    });
    if (clinics.length > 0) return dedupe(clinics);

    // 方法3：最後手段 — 直接抓頁面上所有出現的 3 位數 + 附近中文科別
    const allNums = [...html.matchAll(/>(\d{3})</g)]
      .map(m => parseInt(m[1]))
      .filter(n => n > 0 && n < 500);

    const allDepts = [...html.matchAll(/([\u4e00-\u9fff]{2,8}(?:科|診))/g)]
      .map(m => m[1]);

    const uniqueNums = [...new Set(allNums)];
    uniqueNums.forEach((num, i) => {
      clinics.push({
        dept:    allDepts[i] || '—',
        clinic:  '—',
        doctor:  '—',
        current: num,
      });
    });

    return dedupe(clinics);
  },

  // 長庚系統
  'www1.cgmh.org.tw': makeTableParser({ dept:0, clinic:1, doctor:2, current:3 }),
  'www6.cgmh.org.tw': makeTableParser({ dept:0, clinic:1, doctor:2, current:3 }),

  // 馬偕系統
  'www.mmh.org.tw': makeTableParser({ dept:0, clinic:1, doctor:2, current:4 }),

  // 台北聯合
  'reg.tpech.gov.taipei': makeTableParser({ dept:0, clinic:1, doctor:3, current:2 }),

  // 台大醫院
  'reg.ntuh.gov.tw': makeTableParser({ dept:0, clinic:1, doctor:2, current:3 }),
};

// ── Table 解析器工廠 ──
function makeTableParser(colMap) {
  return (html) => {
    const results = [];
    const tableRe = /<table[\s\S]*?<\/table>/gi;
    const tables = [];
    let tm;
    while ((tm = tableRe.exec(html)) !== null) {
      const rows = [];
      const rowRe = /<tr[\s\S]*?<\/tr>/gi;
      let rm;
      while ((rm = rowRe.exec(tm[0])) !== null) {
        const cells = [];
        const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
        let cm;
        while ((cm = cellRe.exec(rm[0])) !== null) cells.push(stripTags(cm[1]));
        if (cells.length > 1) rows.push(cells);
      }
      if (rows.length > 1) tables.push(rows);
    }
    if (!tables.length) return [];
    const best = tables.reduce((a,b) => a.length >= b.length ? a : b);
    const SKIP = ['科別','科室','診別','診間','醫師','醫生','部門','Dept','Doctor'];
    best.forEach((cells, ri) => {
      if (ri === 0 && SKIP.includes(cells[0])) return;
      if (cells.length < 2) return;
      const dept    = cells[colMap.dept]    || '—';
      const clinic  = cells[colMap.clinic]  || '—';
      const doctor  = cells[colMap.doctor]  || '—';
      const current = extractNum(cells[colMap.current] || '');
      if (SKIP.includes(dept)) return;
      if (dept === '—' && clinic === '—') return;
      results.push({ dept, clinic, doctor, current });
    });
    return results;
  };
}

// ── 通用 fallback 解析器 ──
function genericParser(html) {
  const tableResult = makeTableParser({ dept:0, clinic:1, doctor:2, current:3 })(html);
  if (tableResult.length > 0) return tableResult;

  // 嘗試找 JSON
  const m = html.match(/(\[\s*\{[\s\S]{20,2000}?\}\s*\])/);
  if (m) {
    try {
      const data = JSON.parse(m[1]);
      if (Array.isArray(data) && data.length) {
        return data.map(item => ({
          dept:    String(item.deptName||item.dept||'—'),
          clinic:  String(item.clinicNo||item.clinic||'—'),
          doctor:  String(item.doctorName||item.doctor||'—'),
          current: extractNum(String(item.nowNo||item.current||'')),
        })).filter(c => c.dept !== '—' || c.clinic !== '—');
      }
    } catch {}
  }
  return [];
}

// ══════════════════════════════════════════════
// 主 handler
// ══════════════════════════════════════════════
exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  const targetUrl = event.queryStringParameters?.url;

  if (!targetUrl) {
    return { statusCode: 400, headers: corsHeaders,
      body: JSON.stringify({ ok:false, error:'MISSING_URL', message:'請提供 url 參數' }) };
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
    if (!['http:','https:'].includes(parsed.protocol)) throw new Error();
  } catch {
    return { statusCode: 400, headers: corsHeaders,
      body: JSON.stringify({ ok:false, error:'INVALID_URL', message:'網址格式不正確' }) };
  }

  let html;
  try {
    html = await fetchWithRetry(targetUrl);
  } catch (err) {
    const e = classifyError(err);
    return { statusCode: 502, headers: corsHeaders,
      body: JSON.stringify({ ok:false, error:e.code, message:e.message, hint:e.hint }) };
  }

  if (!html || html.length < 200) {
    return { statusCode: 502, headers: corsHeaders,
      body: JSON.stringify({ ok:false, error:'EMPTY_RESPONSE',
        message:'醫院頁面回傳內容為空', hint:'此頁面可能需要院內 IP 或登入才能存取' }) };
  }

  const hostname = parsed.hostname;
  const parser = HOSPITAL_PARSERS[hostname] || genericParser;
  const clinics = parser(html);

  if (clinics.length === 0) {
    return { statusCode: 200, headers: corsHeaders,
      body: JSON.stringify({ ok:false, error:'PARSE_FAILED',
        message:'成功取得頁面，但找不到診間資料',
        hint:'此醫院可能使用 WebSocket 即時推播，請回報給開發者',
        htmlLength: html.length,
        htmlPreview: html.substring(0, 800),
      }) };
  }

  return { statusCode: 200, headers: corsHeaders,
    body: JSON.stringify({ ok:true, count:clinics.length, clinics,
      fetchedAt: new Date().toISOString() }) };
};

// ══════════════════════════════════════════════
// 抓取（三種 header 策略輪流試）
// ══════════════════════════════════════════════
async function fetchWithRetry(url) {
  const origin = new URL(url).origin;
  const strategies = [
    {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8',
      'Accept-Encoding': 'gzip, deflate',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Upgrade-Insecure-Requests': '1',
    },
    {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,*/*;q=0.8',
      'Referer': origin + '/',
      'Accept-Language': 'zh-TW,zh;q=0.9',
    },
    {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': 'zh-TW,zh;q=0.9',
      'Referer': origin + '/',
    },
  ];

  let lastErr;
  for (const hdrs of strategies) {
    try {
      return await fetchPage(url, hdrs);
    } catch (err) {
      lastErr = err;
      if (err.statusCode !== 403) throw err; // 只有 403 才換策略
    }
  }
  throw lastErr;
}

function fetchPage(url, reqHeaders) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: reqHeaders, timeout: 12000 }, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        fetchPage(res.headers.location, reqHeaders).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { statusCode: res.statusCode }));
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let text = buf.toString('utf8');
        if (/charset=big5/i.test(text.substring(0, 1000))) {
          try { text = new TextDecoder('big5').decode(buf); } catch {}
        }
        resolve(text);
      });
    });
    req.on('timeout', () => { req.destroy(); reject(Object.assign(new Error('timeout'), { code:'ETIMEDOUT' })); });
    req.on('error', reject);
  });
}

// ══════════════════════════════════════════════
// 工具
// ══════════════════════════════════════════════
function stripTags(html) {
  return html.replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&')
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/\s+/g,' ').trim();
}

function extractNum(text) {
  const m = String(text).match(/\d+/);
  if (!m) return null;
  const n = parseInt(m[0]);
  return n > 0 && n < 2000 ? n : null;
}

function dedupe(clinics) {
  const seen = new Set();
  return clinics.filter(c => {
    const key = `${c.dept}-${c.current}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

function classifyError(err) {
  if (err.code==='ETIMEDOUT'||err.message==='timeout')
    return { code:'TIMEOUT', message:'連線逾時，醫院伺服器回應過慢', hint:'請稍後再試' };
  if (err.statusCode===403)
    return { code:'FORBIDDEN', message:'存取被拒絕（403 Forbidden）', hint:'此醫院網站封鎖所有外部伺服器存取' };
  if (err.statusCode===404)
    return { code:'NOT_FOUND', message:'頁面不存在（404）', hint:'請確認是否為即時看診進度頁面的正確網址' };
  if (err.statusCode===500)
    return { code:'SERVER_ERROR', message:'醫院伺服器內部錯誤（500）', hint:'醫院系統可能暫時有問題，請稍後再試' };
  if (err.code==='ENOTFOUND'||err.code==='EAI_AGAIN')
    return { code:'DNS_ERROR', message:'找不到此網域', hint:'請確認網址是否正確' };
  if (err.code==='ECONNREFUSED')
    return { code:'CONN_REFUSED', message:'連線被拒絕', hint:'醫院伺服器可能停機或維護中' };
  return { code:'NETWORK_ERROR', message:`網路錯誤：${err.message}`, hint:'請確認網路連線正常' };
}
