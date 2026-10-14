// Validate checkout bytes before deployment. Git newline conversion must never
// modify a file after its length/hash has been signed by the publisher.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../public');
function verify(file,info){
 const bytes=fs.readFileSync(file);
 if(bytes.length!==info.length||crypto.createHash('sha256').update(bytes).digest('hex')!==info.hashes.sha256)
  throw new Error('Published bytes differ from signed metadata: '+path.relative(root,file));
}
const read=name=>JSON.parse(fs.readFileSync(path.join(root,'metadata',name))).signed;
verify(path.join(root,'metadata/snapshot.json'),read('timestamp.json').meta['snapshot.json']);
verify(path.join(root,'metadata/targets.json'),read('snapshot.json').meta['targets.json']);
for(const [name,info] of Object.entries(read('targets.json').targets)){
 if(name.split('/').some(part=>!part||part==='.'||part==='..')||name.includes('\\'))throw Error('Invalid target path');
 verify(path.join(root,'targets',name),info);
}
console.log('PASS: published checkout preserves every signed target and metadata hash');
