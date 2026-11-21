const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { checkExpiry, monitorCatalog } = require('../scripts/monitor-catalog.cjs');
const { keys, root, metadata } = require('../scripts/publisher.cjs');

const roles = ['root', 'timestamp', 'snapshot', 'targets'];
const now = Date.parse('2026-11-21T00:00:00Z');
const dated = (expires) => ({ version: 1, expires });
const healthyRoles = () => Object.fromEntries(roles.map(role => [role, dated('2026-12-15T00:00:00Z')]));

test('validade do monitor considera os quatro papéis e os dois limites inclusivos', () => {
  assert.equal(checkExpiry(healthyRoles(), now).length, 4);
  for (const role of roles) {
    const state = healthyRoles();
    state[role] = dated('2026-11-26T00:00:00.001Z');
    assert.equal(checkExpiry(state, now).length, 4);
    state[role] = dated('2026-11-26T00:00:00Z');
    assert.throws(() => checkExpiry(state, now), new RegExp('Renovar.*' + role));
    state[role] = dated('2026-11-21T00:00:00Z');
    assert.throws(() => checkExpiry(state, now), new RegExp('Vencido.*' + role));
    state[role] = dated('2026-11-20T23:59:59Z');
    assert.throws(() => checkExpiry(state, now), new RegExp('Vencido.*' + role));
  }
});

test('cliente TUF novo confere as duas entregas públicas e exige os IDs esperados', async t => {
  const signingKeys = keys();
  const bootstrap = root(signingKeys);
  const ids = ['org.nodivu.ducking', 'org.nodivu.talk-button'];
  const files = new Map();
  const plugins = ids.map(id => {
    const archive = id + '/1.0.0/plugin.zip';
    const content = Buffer.from('pacote de teste ' + id);
    files.set(archive, content);
    return { id, archive, download_bytes: content.length };
  });
  files.set('catalog.json', Buffer.from(JSON.stringify({ schema_version: 1, plugins })));
  const signed = metadata(signingKeys, files, 1);
  const routes = new Map();
  for (const [name, bytes] of Object.entries(signed)) routes.set('/metadata/' + name, bytes);
  for (const [name, bytes] of files) routes.set('/targets/' + name, bytes);
  const server = http.createServer((req, res) => {
    const bytes = routes.get(req.url);
    res.writeHead(bytes ? 200 : 404);
    res.end(bytes);
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}/`;
  const source = { root: bootstrap, metadata_url: base + 'metadata/', target_url: base + 'targets/' };
  const report = await monitorCatalog(source, ids);
  assert.equal(report.length, 6);
  for (const { archive } of plugins) assert.ok(report.some(line => line.startsWith(archive + ' ')));
  await assert.rejects(monitorCatalog(source, [...ids, 'ausente']), /esperado ausente/);

  // A file of the correct length still has to match the signed SHA-256.
  const modified = plugins[1];
  routes.set('/targets/' + modified.archive, Buffer.alloc(modified.download_bytes));
  await assert.rejects(monitorCatalog(source, ids), /hash/i);
});
