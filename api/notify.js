/**
 * Vercel API: /api/notify
 * 由 GitHub Actions 每5分鐘呼叫
 * 檢查所有訂閱用戶的號碼，快輪到時推播通知
 */

const https = require('https');
const http  = require('http');
const webpush = require('web-push');
const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

webpush.setVapidDetails(
  'mailto:admin@hospital-tracking.vercel.app',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  // 驗證是 GitHub Actions 呼叫
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    const keys = await redis.smembers('subscriptions_index');
    if (!keys || keys.length === 0) {
      return res.status(200).json({ ok: true, checked: 0, message: '目前沒有訂閱用戶' });
    }

    let checked = 0, notified = 0, errors = 0;
    const clinicsCache = {};

    for (const key of keys) {
      try {
        const raw = await redis.get(key);
        if (!raw) {
          await redis.srem('subscriptions_index', key);
          continue;
        }

        const record = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!record || !record.task) continue;

        const { subscription, task } = record;
        const url = task.url;

        if (!clinicsCache[url]) {
          try { clinicsCache[url] = await fetchClinics(url); }
          catch { clinicsCache[url] = null; }
        }

        const clinics = clinicsCache[url];
        if (!clinics) continue;

        const match = clinics.find(c =>
          c.clinic === task.clinicName && c.doctor === task.doctor
        ) || clinics.find(c => c.clinic === task.clinicName);

        if (!match || match.current === null) continue;

        const current = match.current;
        const remaining = task.myNumber - current;
        checked++;
        record.lastNumber = current;

        let shouldNotify = false, urgent = false, title = '', body = '';

        if (remaining <= 0 && !record.alerted) {
          shouldNotify = true; urgent = true;
          title = '🚨 快輪到你了！';
          body = `${task.clinicName} 目前 ${current} 號，你的號碼 ${task.myNumber}，請立刻前往診間！`;
          record.alerted = true;
        } else if (remaining <= 3 && !record.urgentAlerted) {
          shouldNotify = true; urgent = true;
          title = '🚨 緊急！還有 3 號！';
          body = `${task.clinicName} 目前 ${current} 號，還有 ${remaining} 號，請立刻出發！`;
          record.urgentAlerted = true;
        } else if (remaining <= task.alertBefore && !record.warnAlerted) {
          shouldNotify = true; urgent = false;
          title = '⏰ 請準備出發';
          body = `${task.clinicName} 目前 ${current} 號，還有 ${remaining} 號輪到你，請開始移動！`;
          record.warnAlerted = true;
        }

        if (shouldNotify) {
          try {
            await webpush.sendNotification(
              subscription,
              JSON.stringify({ title, body, urgent, url: '/' })
            );
            notified++;
          } catch (pushErr) {
            if (pushErr.statusCode === 410) {
              await redis.del(key);
              await redis.srem('subscriptions_index', key);
            } else { errors++; }
          }
        }

        // 更新記錄，重設 TTL
        await redis.set(key, JSON.stringify(record), { ex: 60 * 60 * 12 });

      } catch (err) {
        console.error(`process error for ${key}:`, err.message);
        errors++;
      }
    }

    return res.status(200).json({
      ok: true, checked, notified, errors,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error('notify error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};

async function fetchClinics(url) {
  if (url.includes('aftygh.gov.tw')) {
    const text = await fetchText('https://aftygh-proxy.owen163.workers.dev/');
    return parseAftygh(text);
  }
  return [];
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HospitalBot/1.0)' },
      timeout: 10000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

function parseAftygh(text) {
  const clinics = [];
  const totalMatch = text.match(/id="totalidx"[^>]*value="(\d+)"/);
  const total = totalMatch ? parseInt(totalMatch[1]) : 30;
  for (let i = 0; i < total; i++) {
    const get = (field) => {
      const m = text.match(new RegExp(`id="${field}${i}"[^>]*value="([^"]*)"`));
      return m ? m[1].trim() : '';
    };
    const clinname  = get('clinname');
    const drname    = get('drname');
    const oncallnum = get('oncallnum');
    const roomnum   = get('nowroomnum');
    const divnname  = get('divnname');
    if (!clinname) continue;
    const current = parseInt(oncallnum);
    clinics.push({
      dept:    divnname || clinname,
      clinic:  roomnum ? `${clinname}（${roomnum}）` : clinname,
      doctor:  drname || '—',
      current: (!isNaN(current) && current > 0) ? current : null,
    });
  }
  return clinics;
}
