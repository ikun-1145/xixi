import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const helpers = ['getUserFromRequest','getUserStatus','accountStatusRejection','applicationSigningSecret',
  'signJWT','callIdentityRpc','readJsonBodyWithLimit','json','createEmailOtp'];
export async function buildPhoneAuthWorker({workerRoot=process.env.SUNLAND_AUTH_WORKER_ROOT || resolve(project,'../../sunland_ai_app/worker')}={}) {
  const expected = JSON.parse(await readFile(resolve(project,'workers/phone-auth/source-provenance.json'),'utf8'));
  workerRoot = resolve(workerRoot);
  const files = {};
  for (const [name, hash] of Object.entries(expected.files)) {
    const bytes = await readFile(resolve(workerRoot,name));
    if (sha(bytes) !== hash) throw Error(`Unreviewed original Worker source changed: ${name}`);
    files[name] = hash;
  }
  const srcFiles=(await readdir(resolve(workerRoot,'src'),{recursive:true})).filter(f=>f.endsWith('.js')).map(f=>'src/'+f).sort();
  if (srcFiles.join('\n') !== Object.keys(expected.files).filter(f=>f.startsWith('src/')).sort().join('\n')) throw Error('Original Worker source file set changed');
  const require = createRequire(resolve(workerRoot,'package.json'));
  const esbuild = require('esbuild');
  const index = resolve(workerRoot,'src/index.js');
  const result = await esbuild.build({entryPoints:[resolve(project,'workers/phone-auth/entry.js')],
    bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',metafile:true,logLevel:'silent',
    plugins:[{name:'existing-auth-helpers',setup(build) {
      build.onResolve({filter:/^sunland-existing-auth-worker$/},()=>({path:index}));
      build.onLoad({filter:/\.js$/},async args=>{
        const name=relative(workerRoot,args.path);
        if (!Object.hasOwn(expected.files,name)) return;
        const contents=await readFile(args.path,'utf8');
        if (sha(contents)!==expected.files[name]) throw Error(`Worker changed during build: ${name}`);
        return {contents:contents+(args.path===index ? `\nexport { ${helpers.join(', ')} };\n` : ''),loader:'js',resolveDir:dirname(args.path)};
      });
    }}]});
  // Catch concurrent edits to authoritative source while dependencies compile.
  for (const [name,hash] of Object.entries(expected.files)) if(sha(await readFile(resolve(workerRoot,name)))!==hash) throw Error(`Worker changed during build: ${name}`);
  return {code:result.outputFiles[0].text,provenance:{...expected,esbuildVersion:esbuild.version,files}};
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output=process.argv[2];
  if (!output) throw Error('Usage: node scripts/build-phone-auth-worker.mjs /absolute/new-output.mjs');
  if (!output.startsWith('/')) throw Error('Output path must be absolute');
  const result=await buildPhoneAuthWorker();
  await writeFile(output,result.code,{flag:'wx',mode:0o600});
  console.log(`Local Worker build written: ${output}; ${Object.keys(result.provenance.files).length} verified source files. No deployment performed.`);
}
