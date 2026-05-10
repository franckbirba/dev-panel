#!/usr/bin/env node
// scripts/supergroup-probe.js
// Run AFTER manually creating the supergroup, enabling topics, and adding
// the legacy bot. Posts a probe message in each topic, captures the
// returned message_thread_id, prints the SUPERGROUP_TOPIC_IDS env block
// to paste into .env.production.
//
// Telegram doesn't expose a `listForumTopics` Bot API — topic IDs are
// learned only by sending a message and reading message_thread_id from
// the response. This is the one-shot way to bootstrap the routing config.
//
// Usage:
//   TELEGRAM_BOT_TOKEN=... SUPERGROUP_CHAT_ID=-100... \
//     SUPERGROUP_TOPICS="general:1,DEVPA:2,ZENO:3,EDMS:4,deploys:5,captures:6" \
//     node scripts/supergroup-probe.js
//
// SUPERGROUP_TOPICS: comma-separated <name>:<thread_id>. The thread_id
// is printed at the bottom of each topic in the Telegram UI when you
// hover the topic title (or read it from the URL after clicking in).
// This script then sends "Shelly online — <name> topic" to each and
// confirms the round-trip works.

const token = process.env.TELEGRAM_BOT_TOKEN;
const chat_id = process.env.SUPERGROUP_CHAT_ID;
const topicsRaw = process.env.SUPERGROUP_TOPICS;

if (!token) {
  console.error('TELEGRAM_BOT_TOKEN required');
  process.exit(1);
}
if (!chat_id) {
  console.error('SUPERGROUP_CHAT_ID required (the supergroup id, starts with -100)');
  process.exit(1);
}
if (!topicsRaw) {
  console.error('SUPERGROUP_TOPICS required (comma-separated <name>:<thread_id>)');
  process.exit(1);
}

const topics = topicsRaw.split(',').map(pair => {
  const [name, thread_id] = pair.split(':').map(s => s.trim());
  return { name, thread_id: parseInt(thread_id, 10) };
});

async function probe(topic) {
  const text = `🟢 Shelly online — ${topic.name} topic probe (${new Date().toISOString()})`;
  const body = {
    chat_id,
    text,
    message_thread_id: topic.thread_id,
  };
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || !json.ok) {
    return { topic, ok: false, error: json.description || `HTTP ${r.status}` };
  }
  return {
    topic,
    ok: true,
    message_id: json.result?.message_id,
    confirmed_thread_id: json.result?.message_thread_id ?? topic.thread_id,
  };
}

const results = [];
for (const t of topics) {
  process.stdout.write(`probing #${t.name} (thread=${t.thread_id})… `);
  const r = await probe(t);
  if (r.ok) {
    console.log(`✓ message_id=${r.message_id}`);
  } else {
    console.log(`✗ ${r.error}`);
  }
  results.push(r);
  await new Promise(res => setTimeout(res, 200)); // gentle on the API
}

const failed = results.filter(r => !r.ok);
if (failed.length > 0) {
  console.error(`\n✗ ${failed.length}/${results.length} probes failed.`);
  process.exit(1);
}

console.log('\n✓ All probes succeeded. Add to .env.production:\n');
console.log(`SUPERGROUP_ENABLED=true`);
console.log(`SUPERGROUP_CHAT_ID=${chat_id}`);
for (const r of results) {
  const env = `SUPERGROUP_TOPIC_${r.topic.name.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`;
  console.log(`${env}=${r.confirmed_thread_id}`);
}
console.log('\nThen restart devpanel-api so notifyEvent picks up the env.');
