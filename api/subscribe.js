/**
 * Vercel API: /api/subscribe
 * 儲存或刪除用戶的 Web Push 訂閱
 * POST { subscription, task } → 儲存
 * DELETE { endpoint }         → 取消
 */

const { kv } = require('@vercel/kv');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    if (req.method === 'DELETE') {
      const { endpoint } = req.body;
      const key = encodeKey(endpoint);
      await kv.del(key);
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'POST') {
      const { subscription, task } = req.body;
      const key = encodeKey(subscription.endpoint);
      const record = {
        subscription,
        task,
        createdAt: new Date().toISOString(),
        lastNumber: null,
        warnAlerted: false,
        urgentAlerted: false,
        alerted: false,
      };
      // TTL 12小時，避免過期訂閱堆積
      await kv.set(key, record, { ex: 60 * 60 * 12 });

      // 也把 key 加入索引集合，方便 notify 掃描
      await kv.sadd('subscriptions_index', key);

      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });

  } catch (err) {
    console.error('subscribe error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};

function encodeKey(endpoint) {
  return 'sub:' + Buffer.from(endpoint).toString('base64')
    .replace(/[/+=]/g, '_').substring(0, 80);
}
