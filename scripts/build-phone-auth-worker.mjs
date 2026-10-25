import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const helpers = ['getUserFromRequest','getUserStatus','accountStatusRejection','applicationSigningSecret',
  'signJWT','callIdentityRpc','readJsonBodyWithLimit','json','createEmailOtp'];
export async function buildStandalonePhoneWorker({workerRoot=process.env.SUNLAND_AUTH_WORKER_ROOT || resolve(project,'../../sunland_ai_app/worker')}={}) {
  workerRoot = resolve(workerRoot);
  const esbuild = createRequire(resolve(workerRoot,'package.json'))('esbuild');
  const ref = 'bc5489b6e2962f3e1306aa4de5b4292cecf7ca3d';
  const files = {};
  const plugin = expose => ({name:'production-auth-helpers',setup(build) {
    build.onResolve({filter:/^sunland-production-auth-helpers$/},()=>({path:resolve(workerRoot,'src/index.js')}));
    // The eight auth helpers are self-contained; AI-module initialization is
    // not part of their contract and must not enter the independent Worker.
    if (expose) build.onResolve({filter:/^\.\/.+\.js$/},args=>args.importer===resolve(workerRoot,'src/index.js') ?
      {path:resolve(workerRoot,'src',args.path),sideEffects:false} : undefined);
    build.onLoad({filter:/\.js$/},args=>{
      const name = relative(workerRoot,args.path);
      if (!name.startsWith('src/')) return;
      let contents = execFileSync('git',['-C',workerRoot,'show',`${ref}:worker/${name}`],{encoding:'utf8',maxBuffer:4*1024*1024});
      files[name] = sha(contents);
      if (expose && name==='src/index.js') contents += `\nexport { ${helpers.filter(x=>x!=='createEmailOtp').join(', ')} };\n`;
      return {contents,loader:'js',resolveDir:dirname(args.path)};
    });
  }});
  const options = {absWorkingDir:workerRoot,bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',keepNames:true,logLevel:'silent'};
  const baseline = (await esbuild.build({...options,entryPoints:['src/index.js'],plugins:[plugin(false)]})).outputFiles[0].text;
  const normalized = (await esbuild.transform(baseline,{loader:'js',format:'esm',minifyWhitespace:true,legalComments:'none',target:'es2022'})).code;
  if (sha(normalized)!=='73217b53fa4f0424ee31634000ebbc74e046cb41408290fa8ce7897ab592d645') throw Error('Production baseline drift');
  const built = await esbuild.build({...options,entryPoints:[resolve(project,'workers/phone-auth/standalone-entry.js')],plugins:[plugin(true)]});
  const code = built.outputFiles[0].text;
  for (const forbidden of ['sunland_otp','OTP_MAINTENANCE','CODE_STORE','api.deepseek.com']) if (code.includes(forbidden)) throw Error('Unrelated authentication or AI dependency in standalone bundle');
  return {code,baseline,manifest:{worker:'phone-auth',baselineCommit:ref,baselineNormalizedSha256:sha(normalized),helperSourceFiles:files,esbuildVersion:esbuild.version,bundleSha256:sha(code)}};
}
export async function prepareStandalonePhoneWorker(output) {
  if (!output?.startsWith('/')) throw Error('New absolute output directory required');
  const result = await buildStandalonePhoneWorker();
  const config = JSON.parse(await readFile(resolve(project,'workers/phone-auth/wrangler.jsonc'),'utf8'));
  config.main = 'worker.mjs';
  await mkdir(output,{mode:0o700});
  const files = {'worker.mjs':result.code,'wrangler.json':JSON.stringify(config,null,2)+'\n','manifest.json':JSON.stringify(result.manifest,null,2)+'\n'};
  files.SHA256SUMS = Object.entries(files).map(([name,text])=>`${sha(text)}  ${name}`).join('\n')+'\n';
  for (const [name,text] of Object.entries(files)) await writeFile(resolve(output,name),text,{flag:'wx',mode:0o600});
  return {...result,config};
}
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
  if (process.argv.includes('--standalone')) {
    const result=await prepareStandalonePhoneWorker(output);
    console.log(JSON.stringify(result.manifest));
    process.exit(0);
  }
  const result=await buildPhoneAuthWorker();
  await writeFile(output,result.code,{flag:'wx',mode:0o600});
  console.log(`Local Worker build written: ${output}; ${Object.keys(result.provenance.files).length} verified source files. No deployment performed.`);
}
