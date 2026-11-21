// Maintainer tooling. Keys are encrypted by Windows DPAPI, never written as plaintext.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const {Metadata,Root,Key,Signature,Targets,TargetFile,MetaFile,Snapshot,Timestamp}=require('@tufjs/models');
const roles=['root','targets','snapshot','timestamp'];
const publishingRoles = ['targets', 'snapshot', 'timestamp'];
const hashes=b=>({sha256:crypto.createHash('sha256').update(b).digest('hex')});
const expires=days=>new Date(Date.now()+days*86400000).toISOString();
function pair(){const k=crypto.generateKeyPairSync('ed25519');const pub=k.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex');return {id:hashes(pub).sha256,public:pub,private:k.privateKey.export({format:'pem',type:'pkcs8'})};}
function keys(){return Object.fromEntries(roles.map(r=>[r,pair()]));}
function signed(data,key,appendKey){const m=new Metadata(data);for(const k of [key,appendKey].filter(Boolean))m.sign(b=>new Signature({keyID:k.id,sig:crypto.sign(null,b,k.private).toString('hex')}),true);return Buffer.from(JSON.stringify(m.toJSON()));}
function root(keys,version=1,previous){const r=new Root({version,expires:expires(365),consistentSnapshot:false});for(const role of roles)r.addKey(new Key({keyID:keys[role].id,keyType:'ed25519',scheme:'ed25519',keyVal:{public:keys[role].public}}),role);return signed(r,keys.root,previous?.root);}
function metadata(keys,files,version){
 const t=new Targets({version,expires:expires(90)});for(const [name,data] of files)t.addTarget(new TargetFile({path:name,length:data.length,hashes:hashes(data)}));
 const targets=signed(t,keys.targets);
 const snapshot=signed(new Snapshot({version,expires:expires(30),meta:{'targets.json':new MetaFile({version,length:targets.length,hashes:hashes(targets)})}}),keys.snapshot);
 const timestamp=signed(new Timestamp({version,expires:expires(14),snapshotMeta:new MetaFile({version,length:snapshot.length,hashes:hashes(snapshot)})}),keys.timestamp);
 return {'targets.json':targets,'snapshot.json':snapshot,'timestamp.json':timestamp};
}
function dpapi(bytes,decode=false){
 if(process.platform!=='win32')throw Error('Private-key operations require Windows DPAPI CurrentUser.');
 const operation=decode?'Unprotect':'Protect';
 const script=`Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $r=[System.Security.Cryptography.ProtectedData]::${operation}($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
 return Buffer.from(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{input:Buffer.from(bytes).toString('base64'),encoding:'utf8',windowsHide:true}).trim(),'base64');
}
function atomic(file,data){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',data,{flag:'wx'});fs.renameSync(file+'.tmp',file);}
// Routine publishing must work even when the recovery bundle has been taken offline.
function provisionSigners(directory, allKeys) {
 const publishing = Object.fromEntries(publishingRoles.map(role => [role, allKeys[role]]));
 atomic(path.join(directory, 'publish.dpapi'), dpapi(Buffer.from(JSON.stringify(publishing))));
 atomic(path.join(directory, 'timestamp.dpapi'), dpapi(Buffer.from(JSON.stringify(allKeys.timestamp))));
}
function requireRoleKeys(rootMetadata, roleKeys, names) {
 for (const role of names) {
  if (!rootMetadata.signed.roles[role].keyIDs.includes(roleKeys[role]?.id))
   throw Error('Signing credentials do not match the active root for ' + role);
 }
}
function timestampSigner(rootMetadata, pem) {
 if (!pem) throw Error('Missing timestamp private key');
 const publicKey = crypto.createPublicKey(crypto.createPrivateKey(pem));
 if (publicKey.asymmetricKeyType !== 'ed25519') throw Error('Expected an Ed25519 timestamp key');
 const publicHex = publicKey.export({format:'der', type:'spki'}).subarray(-32).toString('hex');
 const id = rootMetadata.signed.roles.timestamp.keyIDs.find(id => rootMetadata.signed.keys[id]?.keyVal.public === publicHex);
 if (!id || ['root','snapshot','targets'].some(role =>
  rootMetadata.signed.roles[role].keyIDs.some(other => rootMetadata.signed.keys[other]?.keyVal.public === publicHex)))
  throw Error('The Actions credential must belong exclusively to the active timestamp role');
 return {id, private:pem};
}
function trustedRoot(repo) {
 const folder = path.join(repo,'public','metadata');
 const parse = data => Metadata.fromJSON('root',JSON.parse(data));
 let trusted = parse(JSON.parse(fs.readFileSync(path.join(repo,'source.json'))).root);
 trusted.verifyDelegate('root',trusted);
 const head = parse(fs.readFileSync(path.join(folder,'root.json')));
 while (trusted.signed.version < head.signed.version) {
  const version = trusted.signed.version + 1;
  const next = parse(fs.readFileSync(path.join(folder,version+'.root.json')));
  if (next.signed.version !== version) throw Error('Nonconsecutive root rotation');
  trusted.verifyDelegate('root',next);
  next.verifyDelegate('root',next);
  trusted = next;
 }
 if (!trusted.signed.equals(head.signed)) throw Error('Published root differs from trusted root chain');
 trusted.verifyDelegate('root',head);
 return trusted;
}
function renewTimestamp(rootMetadata, previousBytes, snapshotBytes, targetsBytes, signer, now = new Date()) {
 const previous = Metadata.fromJSON('timestamp', JSON.parse(previousBytes));
 const snapshot = Metadata.fromJSON('snapshot', JSON.parse(snapshotBytes));
 const targets = Metadata.fromJSON('targets', JSON.parse(targetsBytes));
 for (const [role, record] of Object.entries({timestamp: previous, snapshot, targets}))
  rootMetadata.verifyDelegate(role, record);
 const targetsRef = snapshot.signed.meta['targets.json'];
 for (const [ref, bytes] of [[previous.signed.snapshotMeta,snapshotBytes],[targetsRef,targetsBytes]]) {
  if (!Number.isSafeInteger(ref?.length) || ref.length < 1 || !/^[a-f0-9]{64}$/i.test(ref.hashes?.sha256 ?? ''))
   throw Error('Signed metadata is missing its size or SHA-256');
  ref.verify(bytes);
 }
 if (previous.signed.snapshotMeta.version !== snapshot.signed.version || targetsRef.version !== targets.signed.version)
  throw Error('Catalog metadata versions disagree');
 const deadline = Math.min(now.getTime() + 14 * 86400000,
  ...[rootMetadata, snapshot, targets].map(m => Date.parse(m.signed.expires)));
 if (!Number.isFinite(deadline) || deadline <= now.getTime() + 7 * 86400000)
  throw Error('Root, snapshot or targets need operator renewal before extending timestamp');
 requireRoleKeys(rootMetadata, {timestamp: signer}, ['timestamp']);
 if (Date.parse(previous.signed.expires) > now.getTime() + 7 * 86400000) return null;
 const next = signed(new Timestamp({version: previous.signed.version + 1,
  expires: new Date(deadline).toISOString(), snapshotMeta: previous.signed.snapshotMeta}), signer);
 rootMetadata.verifyDelegate('timestamp', Metadata.fromJSON('timestamp', JSON.parse(next)));
 return next;
}
function walk(folder,prefix=''){let out=[];for(const e of fs.readdirSync(folder,{withFileTypes:true})){if(e.isSymbolicLink())throw Error('Symlink prohibited');const name=prefix+e.name;if(e.isDirectory())out.push(...walk(path.join(folder,e.name),name+'/'));else if(e.isFile())out.push([name,fs.readFileSync(path.join(folder,e.name))]);else throw Error('Special file');}return out;}
function main(){
 const [command,arg,ghExecutable]=process.argv.slice(2),repo=path.resolve(__dirname,'..'),site=path.join(repo,'public'),meta=path.join(site,'metadata');
 function renew(currentRoot,signer) {
  const read = role => fs.readFileSync(path.join(meta,role+'.json'));
  const next = renewTimestamp(currentRoot,read('timestamp'),read('snapshot'),read('targets'),signer);
  if(next) atomic(path.join(meta,'timestamp.json'),next);
  console.log(next ? 'Renewed timestamp until '+JSON.parse(next).signed.expires : 'Timestamp is still fresh.');
 }
 if (command==='renew-actions') {
  const currentRoot = trustedRoot(repo);
  renew(currentRoot,timestampSigner(currentRoot,process.env.STORE_TIMESTAMP_KEY));
  return;
 }
 if(command==='add'){
  const project=path.resolve(arg),pkg=path.join(project,'dist/package');
  const m=JSON.parse(fs.readFileSync(path.join(pkg,'nodivu-package.json'))),a=JSON.parse(fs.readFileSync(path.join(pkg,'plugin.json')));
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(m.plugin_id)||!/^\d+\.\d+\.\d+$/.test(m.version)||m.plugin_id!==a.plugin_id||m.host_api!==2||m.platform!=='win32-x64')throw Error('Package identity/contract invalid');
  const prefix=m.plugin_id+'/'+m.version,target=path.join(site,'targets',prefix);
  if(fs.existsSync(target))throw Error('Immutable version already exists; bump version for new bytes.');
  const name=path.basename(project),zip=fs.readFileSync(path.join(project,'dist',name+'-'+m.version+'-windows-x64.zip'));
  fs.mkdirSync(target,{recursive:true});fs.writeFileSync(path.join(target,'plugin.zip'),zip);fs.copyFileSync(path.join(pkg,'README.md'),path.join(target,'README.md'));
  const row={id:m.plugin_id,version:m.version,title:a.title,author:m.author,publisher_id:'nodivu',description:a.description,archive:prefix+'/plugin.zip',download_bytes:zip.length,readme:prefix+'/README.md',platform:m.platform,host_api:m.host_api,resource_tier:m.resource_tier,repository:m.repository};
  if(fs.existsSync(path.join(pkg,'logo.png'))){fs.copyFileSync(path.join(pkg,'logo.png'),path.join(target,'logo.png'));row.logo=prefix+'/logo.png';row.images={'logo.png':row.logo};}
  const file=path.join(repo,'catalog.json'),c=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):{schema_version:1,plugins:[]};c.plugins=c.plugins.filter(p=>p.id!==row.id);c.plugins.push(row);atomic(file,JSON.stringify(c,null,2)+'\n');console.log('Staged '+row.id+' '+row.version);return;
 }
 if(!['init','provision-signers','configure-actions','publish','renew','rotate'].includes(command)||!arg)throw Error('Usage: publisher.cjs add PROJECT | init/provision-signers/configure-actions/publish/renew/rotate PRIVATE_DIRECTORY | renew-actions');
 const privateDir=path.resolve(arg);if(privateDir===repo||privateDir.startsWith(repo+path.sep))throw Error('Keys must be OUTSIDE this repository.');
 const keyfile=path.join(privateDir,'keys.dpapi');let k;
 fs.mkdirSync(meta,{recursive:true});
 if(command==='init'){
  if(fs.existsSync(keyfile)||fs.existsSync(path.join(meta,'root.json')))throw Error('Already initialized');
  k=keys();fs.mkdirSync(privateDir,{recursive:true});atomic(keyfile,dpapi(Buffer.from(JSON.stringify(k))));
  provisionSigners(privateDir,k);
  const data=root(k);atomic(path.join(meta,'1.root.json'),data);atomic(path.join(meta,'root.json'),data);
  atomic(path.join(repo,'source.json'),JSON.stringify({schema_version:1,metadata_url:'https://warier.github.io/nodivu-plugins/metadata/',target_url:'https://warier.github.io/nodivu-plugins/targets/',root:data.toString(),official_publishers:['nodivu']},null,2)+'\n');
  console.log('Initialized public root; private keys protected with DPAPI.');return;
 }
 const readRole = filename => JSON.parse(dpapi(fs.readFileSync(path.join(privateDir, filename)), true));
 const currentRoot = trustedRoot(repo);
 if(command==='configure-actions') {
  const signer=timestampSigner(currentRoot,readRole('timestamp.dpapi').private);
  // gh encrypts the secret for this repository. Keep it off disk, argv and logs.
  execFileSync(ghExecutable || 'gh',['secret','set','STORE_TIMESTAMP_KEY','--repo','Warier/nodivu-plugins'],
   {input:signer.private,stdio:['pipe','ignore','inherit'],windowsHide:true});
  console.log('Configured the timestamp-only Actions secret for Warier/nodivu-plugins.');
  return;
 }
 if(command==='provision-signers') {
  const recovery = readRole('keys.dpapi');
  requireRoleKeys(currentRoot,recovery,roles);
  provisionSigners(privateDir,recovery);
  console.log('Provisioned separate DPAPI credentials for routine publishing and timestamp-only renewal.');
  return;
 }
 if(command==='renew') {
  renew(currentRoot,timestampSigner(currentRoot,readRole('timestamp.dpapi').private));
  return;
 }
 k=readRole(command==='rotate'?'keys.dpapi':'publish.dpapi');
 requireRoleKeys(currentRoot,k,command==='rotate'?roles:publishingRoles);
 if(command==='rotate'){
  const previous=JSON.parse(fs.readFileSync(path.join(meta,'root.json'))),next=keys(),data=root(next,previous.signed.version+1,k);
  const before=Metadata.fromJSON('root',previous),after=Metadata.fromJSON('root',JSON.parse(data));before.verifyDelegate('root',after);after.verifyDelegate('root',after);
  // Archive encrypted old material before switching. Never delete old versioned roots.
  fs.copyFileSync(keyfile,path.join(privateDir,'keys-root-'+previous.signed.version+'.dpapi'),fs.constants.COPYFILE_EXCL);
  atomic(keyfile,dpapi(Buffer.from(JSON.stringify(next))));atomic(path.join(meta,(previous.signed.version+1)+'.root.json'),data);atomic(path.join(meta,'root.json'),data);
  provisionSigners(privateDir,next);
  k=next; // source.json deliberately keeps the original bootstrap for existing clients.
 }
 const publicRoot=Metadata.fromJSON('root',JSON.parse(fs.readFileSync(path.join(meta,'root.json'))));
 requireRoleKeys(publicRoot,k,publishingRoles);
 const index=fs.readFileSync(path.join(repo,'catalog.json'));atomic(path.join(site,'targets/catalog.json'),index);
 const existing=path.join(meta,'timestamp.json'),version=fs.existsSync(existing)?JSON.parse(fs.readFileSync(existing)).signed.version+1:1;
 const output=metadata(k,walk(path.join(site,'targets')),version);
 for(const name of ['targets.json','snapshot.json','timestamp.json']){
  publicRoot.verifyDelegate(name.split('.')[0],Metadata.fromJSON(name.split('.')[0],JSON.parse(output[name])));
  atomic(path.join(meta,name),output[name]);
 }
 console.log('Signed catalog revision '+version+'; renew before '+JSON.parse(output['timestamp.json']).signed.expires);
}
if(require.main===module){try{main();}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={keys,root,metadata,hashes,renewTimestamp,timestampSigner,trustedRoot};
