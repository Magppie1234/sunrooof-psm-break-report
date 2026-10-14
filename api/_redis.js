const url = () => process.env.KV_REST_API_URL;
const token = () => process.env.KV_REST_API_TOKEN;

async function redis(command) {
  if (!url() || !token()) throw new Error('Live break storage is not configured');
  const response = await fetch(url(), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token(), 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error('Live break storage failed: ' + (data.error || response.status));
  return data.result;
}

module.exports = { redis };
