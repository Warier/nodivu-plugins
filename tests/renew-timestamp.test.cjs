const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Metadata, Signature } = require('@tufjs/models');
const { keys, root, metadata, timestampSigner, renewTimestamp, trustedRoot } = require('../scripts/publisher.cjs');

const day = 24 * 60 * 60 * 1000;
const readRoot = bytes => Metadata.fromJSON('root', JSON.parse(bytes));
const expiry = bytes => Date.parse(JSON.parse(bytes).signed.expires);

function fixture() {
  const roles = keys();
  const authority = readRoot(root(roles));
  const files = metadata(roles, new Map([['catalog.json', Buffer.from('{"plugins":[]}')]]), 7);
  const signer = timestampSigner(authority, roles.timestamp.private);
  function renewAt(time, input = files, activeSigner = signer) {
    return renewTimestamp(authority, input['timestamp.json'], input['snapshot.json'],
      input['targets.json'], activeSigner, new Date(time));
  }
  return { roles, authority, files, renewAt };
}

function removeSignatures(bytes) {
  const document = JSON.parse(bytes);
  document.signatures = [];
  return Buffer.from(JSON.stringify(document));
}

test('fresh é no-op; timestamp a sete dias ou já vencido é renovado sem mudar snapshot nem targets', () => {
  const { authority, files, renewAt } = fixture();
  const oldTimestamp = JSON.parse(files['timestamp.json']).signed;
  const original = Object.fromEntries(Object.entries(files).map(([name, buffer]) => [name, Buffer.from(buffer)]));
  const expires = expiry(files['timestamp.json']);
  assert.equal(renewAt(expires - 7 * day - 1), null);
  for (const now of [expires - 7 * day, expires + day, expires + 5 * day]) {
    const bytes = renewAt(now);
    const updated = Metadata.fromJSON('timestamp', JSON.parse(bytes));
    authority.verifyDelegate('timestamp', updated);
    assert.equal(updated.signed.version, oldTimestamp.version + 1);
    assert.deepEqual(updated.signed.toJSON().meta['snapshot.json'], oldTimestamp.meta['snapshot.json']);
    updated.signed.snapshotMeta.verify(files['snapshot.json']);
    assert.equal(expiry(bytes), Math.min(now + 14 * day, expiry(files['snapshot.json'])));
    assert.deepEqual(files, original);
  }
});

test('recusa metadados superiores vencidos ou próximos e verifica assinaturas mesmo em no-op', () => {
  const { files, roles, renewAt } = fixture();
  const snapshotEnd = expiry(files['snapshot.json']);
  for (const now of [snapshotEnd - 7 * day, snapshotEnd + 1]) {
    assert.throws(() => renewAt(now), /operator renewal/i);
  }
  const fresh = expiry(files['timestamp.json']) - 10 * day;
  assert.throws(() => renewAt(fresh, files, roles.root), /timestamp/i);
  for (const name of ['timestamp.json', 'snapshot.json', 'targets.json']) {
    const unsigned = { ...files, [name]: removeSignatures(files[name]) };
    assert.throws(() => renewAt(fresh, unsigned), /sign|threshold/i);
  }
  for (const name of ['snapshot.json', 'targets.json']) {
    const changed = { ...files, [name]: Buffer.concat([files[name], Buffer.from('\n')]) };
    assert.throws(() => renewAt(fresh, changed), /length|hash/i);
  }
});

test('uma assinatura válida de timestamp ainda exige tamanho, SHA-256 e versão do snapshot', () => {
  const { files, roles, renewAt } = fixture();
  const fresh = expiry(files['timestamp.json']) - 10 * day;
  for (const [field, message] of [['length', /size|length/i], ['hashes', /SHA-256|hash/i], ['version', /versions/i]]) {
    const document = JSON.parse(files['timestamp.json']);
    const ref = document.signed.meta['snapshot.json'];
    if (field === 'version') ref.version += 1;
    else delete ref[field];
    const record = Metadata.fromJSON('timestamp', document);
    record.sign(data => new Signature({
      keyID: roles.timestamp.id,
      sig: crypto.sign(null, data, roles.timestamp.private).toString('hex'),
    }));
    const changed = { ...files, 'timestamp.json': Buffer.from(JSON.stringify(record.toJSON())) };
    assert.throws(() => renewAt(fresh, changed), message);
  }
});

test('aceita apenas uma chave privada Ed25519 exclusiva do papel timestamp ativo', () => {
  const { authority, roles } = fixture();
  assert.equal(timestampSigner(authority, roles.timestamp.private).id, roles.timestamp.id);
  for (const role of ['root', 'snapshot', 'targets']) {
    assert.throws(() => timestampSigner(authority, roles[role].private));
  }
  const shared = readRoot(root({ ...roles, snapshot: roles.timestamp }));
  assert.throws(() => timestampSigner(shared, roles.timestamp.private));
  const onlyPublic = crypto.createPublicKey(roles.timestamp.private).export({ format: 'pem', type: 'spki' });
  assert.throws(() => timestampSigner(authority, onlyPublic));
});

test('bootstrap autentica a rotação, a versão publicada e as assinaturas de raiz', async t => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'nodivu-renew-root-'));
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const directory = path.join(repo, 'public', 'metadata');
  await fs.mkdir(directory, { recursive: true });
  const initial = keys();
  const first = root(initial);
  const next = keys();
  const second = root(next, 2, initial);
  const writeSource = bytes => fs.writeFile(path.join(repo, 'source.json'), JSON.stringify({ root: bytes.toString() }));
  const write = (name, bytes) => fs.writeFile(path.join(directory, name), bytes);
  await writeSource(first);
  await write('2.root.json', second);
  await write('root.json', second);
  assert.equal(trustedRoot(repo).signed.version, 2);
  assert.equal(timestampSigner(trustedRoot(repo), next.timestamp.private).id, next.timestamp.id);
  assert.throws(() => timestampSigner(trustedRoot(repo), initial.timestamp.private));

  await write('root.json', removeSignatures(second));
  assert.throws(() => trustedRoot(repo));
  const unsignedByPrevious = root(next, 2);
  await write('2.root.json', unsignedByPrevious);
  await write('root.json', unsignedByPrevious);
  assert.throws(() => trustedRoot(repo));
  await writeSource(removeSignatures(first));
  await write('root.json', first);
  assert.throws(() => trustedRoot(repo));
});
