// src/server/voyage.js
const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';

export async function embed(input, { inputType = 'document' } = {}) {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) throw new Error('VOYAGE_API_KEY is not set');
  const model = process.env.VOYAGE_MODEL || 'voyage-code-3';

  const res = await fetch(VOYAGE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify({ input, model, input_type: inputType })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Voyage embed failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.data[0].embedding;
}
