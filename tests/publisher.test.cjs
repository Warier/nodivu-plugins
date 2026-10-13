const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {Updater}=require('tuf-js');const {keys,root,metadata}=require('../scripts/publisher.cjs');
test('real TUF client advances revisions and cross-signed root; rejects altered target and old metadata',async t=>{
 const initial=keys(),initialRoot=root(initial),files=new Map([['catalog.json',Buffer.from('{"plugins":[]}')]]);
 const served=new Map([['/metadata/1.root.json',initialRoot]]);
 function update(k,version){for(const [n,b]of Object.entries(metadata(k,files,version)))served.set('/metadata/'+n,b);for(const[n,b]of files)served.set('/targets/'+n,b);}
 update(initial,1);const firstTimestamp=served.get('/metadata/timestamp.json');
 const server=http.createServer((req,res)=>{const b=served.get(req.url);res.writeHead(b?200:404);res.end(b);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'nodivu-publisher-'));t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(temp,{recursive:true,force:true});});
 async function client(name){const dir=path.join(temp,name);await fs.mkdir(dir);await fs.writeFile(path.join(dir,'root.json'),initialRoot);return new Updater({metadataDir:dir,targetDir:dir,metadataBaseUrl:`http://127.0.0.1:${server.address().port}/metadata/`,targetBaseUrl:`http://127.0.0.1:${server.address().port}/targets/`});}
 const c=await client('a');await c.refresh();const info=await c.getTargetInfo('catalog.json');assert.ok(info);await c.downloadTarget(info);
 const next=keys();served.set('/metadata/2.root.json',root(next,2,initial));files.set('catalog.json',Buffer.from('{"plugins":[1]}'));update(next,2);
 // New Updater against existing cache must traverse 1 -> 2 signed by both roots.
 const d=new Updater({metadataDir:path.join(temp,'a'),targetDir:path.join(temp,'a'),metadataBaseUrl:`http://127.0.0.1:${server.address().port}/metadata/`,targetBaseUrl:`http://127.0.0.1:${server.address().port}/targets/`});await d.refresh();assert.equal((await fs.readFile(await d.downloadTarget(await d.getTargetInfo('catalog.json')))).toString(),'{"plugins":[1]}');
 served.set('/targets/catalog.json',Buffer.from('{"plugins":[9]}'));const e=await client('b');await e.refresh();await assert.rejects(e.downloadTarget(await e.getTargetInfo('catalog.json')),/hash|verify/i);
 served.set('/metadata/timestamp.json',firstTimestamp);const f=await client('c');await assert.rejects(f.refresh());
});
