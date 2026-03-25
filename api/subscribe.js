/**
 * Vercel API: /api/subscribe
 * POST { subscription, task } → 儲存推播訂閱
 * DELETE { endpoint }         → 取消訂閱
 */

const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'DELETE') {
      const { endpoint } = req.body;
      const key = encodeKey(endpoint);
      await redis.del(key);
      await redis.srem('subscriptions_index', key);
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
      await redis.set(key, JSON.stringify(record), { ex: 60 * 60 * 12 });
      await redis.sadd('subscriptions_index', key);
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
