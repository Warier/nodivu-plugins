// Probes the public store like a fresh client. Signing keys are never needed.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Updater } = require('tuf-js');

const roles = ['root', 'targets', 'snapshot', 'timestamp'];
const noticeDays = 5;
const dayMs = 24 * 60 * 60 * 1000;

function checkExpiry(metadata, now = Date.now()) {
  const report = [];
  const alerts = [];
  for (const role of roles) {
    const { version, expires } = metadata[role];
    const remaining = Date.parse(expires) - now;
    if (!Number.isFinite(remaining)) throw Error(`Data de validade inválida para ${role}.`);
    const description = `${role} v${version} • ${expires}`;
    report.push(description);
    if (remaining <= 0) alerts.push(`Vencido: ${description}`);
    else if (remaining <= noticeDays * dayMs) alerts.push(`Renovar em até ${noticeDays} dias: ${description}`);
  }
  if (alerts.length) throw Error(alerts.join('\n'));
  return report;
}

function requireDigest(info, name) {
  if (!info || !Number.isSafeInteger(info.length) || info.length < 1 ||
      !/^[0-9a-f]{64}$/i.test(info.hashes?.sha256 ?? '')) {
    throw Error(`Tamanho ou SHA-256 ausente para ${name}.`);
  }
}

async function monitorCatalog(source, expectedIds) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nodivu-catalog-monitor-'));
  try {
    await fs.writeFile(path.join(temp, 'root.json'), source.root);
    const client = new Updater({
      metadataDir: temp,
      metadataBaseUrl: source.metadata_url,
      targetBaseUrl: source.target_url,
      config: { fetchTimeout: 15000, fetchRetries: 2 },
    });
    await client.refresh();
    const metadata = {};
    for (const role of roles) {
      metadata[role] = JSON.parse(await fs.readFile(path.join(temp, role + '.json'), 'utf8')).signed;
    }
    requireDigest(metadata.timestamp.meta['snapshot.json'], 'snapshot.json');
    requireDigest(metadata.snapshot.meta['targets.json'], 'targets.json');

    const catalog = await client.getTargetInfo('catalog.json');
    requireDigest(catalog, 'catalog.json');
    const catalogFile = await client.downloadTarget(catalog, path.join(temp, 'catalog.json'));
    const { schema_version, plugins } = JSON.parse(await fs.readFile(catalogFile, 'utf8'));
    if (schema_version !== 1 || !Array.isArray(plugins)) throw Error('Catálogo público inválido.');
    const publicIds = new Set(plugins.map(plugin => plugin.id));
    if (publicIds.size !== plugins.length) throw Error('IDs duplicados no catálogo público.');
    for (const id of expectedIds) {
      if (!publicIds.has(id)) throw Error(`Plugin esperado ausente no catálogo público: ${id}`);
    }
    const packages = [];
    for (const plugin of plugins) {
      if (typeof plugin.archive !== 'string' ||
          !plugin.archive.split('/').every(part => /^[a-z0-9][a-z0-9._-]*$/i.test(part))) {
        throw Error('Caminho de pacote inválido no catálogo.');
      }
      const info = await client.getTargetInfo(plugin.archive);
      requireDigest(info, plugin.archive);
      if (info.length !== plugin.download_bytes) throw Error(`Tamanho divergente para ${plugin.archive}.`);
      await client.downloadTarget(info, path.join(temp, 'package.zip'));
      packages.push(`${plugin.archive} • ${info.length} bytes • SHA-256 ${info.hashes.sha256}`);
    }
    return [...checkExpiry(metadata), ...packages];
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const expectedIds = require('../catalog.json').plugins.map(plugin => plugin.id);
  monitorCatalog(require('../source.json'), expectedIds)
    .then(lines => console.log(lines.join('\n')))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { checkExpiry, monitorCatalog };
