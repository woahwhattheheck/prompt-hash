const assert = require('node:assert/strict');
const { createClient } = require('redis');

const cases = [
  { pattern: '*', suffix: 'a', other: 'a', otherNamespace: 'search' },
  { pattern: 'a*b?c', suffix: 'axxbyc', other: 'axxbzzc' },
  { pattern: '?', suffix: 'a', other: 'ab' },
  { pattern: '[ab]', suffix: 'a', other: 'c' },
  { pattern: '[c-a]', suffix: 'b', other: 'd' },
  { pattern: '[a-é]', suffix: '0', other: 'b' },
  { pattern: '[^a-c]', suffix: 'd', other: 'b' },
  { pattern: '\\*', suffix: '*', other: 'a' },
  { pattern: '[\\]]', suffix: ']', other: 'a' },
  { pattern: '\\', suffix: '\\', other: 'a' },
  { pattern: '??', suffix: 'é', other: 'a' },
];

(async () => {
  const client = createClient({ url: 'redis://127.0.0.1:6379' });
  client.on('error', error => { throw error; });
  await client.connect();
  try {
    const info = await client.info('server');
    const redisVersion = /^redis_version:(.+)\r?$/m.exec(info)?.[1].trim();
    const os = /^os:(.+)\r?$/m.exec(info)?.[1].trim();
    assert.equal(redisVersion, '7.2.5');
    const observations = [];
    for (const [index, row] of cases.entries()) {
      const prefix = `ph272:${index}:prompts:`;
      const pattern = `${prefix}detail:${row.pattern}`;
      const key = `${prefix}detail:${row.suffix}`;
      const otherKey = `${prefix}${row.otherNamespace ?? 'detail'}:${row.other}`;
      await client.set(key, 'matching');
      await client.set(otherKey, 'unrelated');
      let cursor = '0';
      const matches = [];
      do {
        const reply = await client.scan(cursor, { MATCH: pattern, COUNT: 100 });
        cursor = String(reply.cursor);
        matches.push(...reply.keys);
      } while (cursor !== '0');
      assert.deepEqual([...new Set(matches)], [key], row.pattern);
      observations.push({ pattern: row.pattern, match: row.suffix, nonmatch: row.other, passed: true });
      await client.del([key, otherKey]);
    }
    console.log(JSON.stringify({ redisVersion, os, node: process.version, observations }, null, 2));
  } finally {
    await client.quit();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
