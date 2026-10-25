#!/usr/bin/env node
import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {createReadStream,createWriteStream,readFileSync,statSync,openSync,readSync,closeSync,writeFileSync,rmSync} from 'node:fs';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';

const MAGIC=Buffer.from('SUNLAND1');
const HEADER=MAGIC.length+12,TAG=16;
const [command,keyPath,input,output]=process.argv.slice(2);
if(!['encrypt','decrypt','verify'].includes(command)||!keyPath||!input||(command==='decrypt'&&!output)) {
  console.error('usage: aead-file.mjs encrypt KEY OUTPUT < stdin | decrypt KEY INPUT OUTPUT | verify KEY INPUT');
  process.exit(2);
}
const key=readFileSync(keyPath);
if(key.length!==32) throw new Error('encryption key must contain exactly 32 bytes');
function meter(){let bytes=0;const hash=createHash('sha256');const transform=new Transform({transform(chunk,_encoding,callback){bytes+=chunk.length;hash.update(chunk);callback(null,chunk);}});return {transform,result:()=>({bytes,sha256:hash.digest('hex')})};}
function outputStream(path){return path==='-'?process.stdout:createWriteStream(path,{fd:openSync(path,'wx',0o600),autoClose:true});}
if(command==='encrypt') {
  const outputPath=input,iv=randomBytes(12),header=Buffer.concat([MAGIC,iv]);
  const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(header);
  // Open before entering cleanup: an EEXIST failure never owns the old file.
  const out=outputStream(outputPath);out.write(header);
  let sidecarCreated=false;
  const count=meter();
  async function* authenticated(source){for await(const chunk of source)yield chunk;yield cipher.getAuthTag();}
  try {
    await pipeline(process.stdin,count.transform,cipher,authenticated,out);
    const sidecar=openSync(outputPath+'.source.json','wx',0o600);sidecarCreated=true;
    try {writeFileSync(sidecar,JSON.stringify(count.result())+'\n');} finally {closeSync(sidecar);}
  } catch(error){rmSync(outputPath,{force:true});if(sidecarCreated)rmSync(outputPath+'.source.json',{force:true});throw error;}
} else {
  const size=statSync(input).size;if(size<HEADER+TAG)throw new Error('encrypted file is too small');
  const fd=openSync(input,'r'),header=Buffer.alloc(HEADER),tag=Buffer.alloc(TAG);
  try {readSync(fd,header,0,HEADER,0);readSync(fd,tag,0,TAG,size-TAG);} finally {closeSync(fd);}
  if(!header.subarray(0,MAGIC.length).equals(MAGIC))throw new Error('unsupported encrypted file format');
  const decipher=createDecipheriv('aes-256-gcm',key,header.subarray(MAGIC.length));decipher.setAAD(header);decipher.setAuthTag(tag);
  const count=meter(),destination=command==='verify'?null:output;
  const out=command==='verify'?new Transform({transform(chunk,_encoding,callback){callback(null,chunk);}}):outputStream(destination);
  try {
    if(command==='verify')await pipeline(createReadStream(input,{start:HEADER,end:size-TAG-1}),decipher,count.transform,out,new Transform({transform(_chunk,_encoding,callback){callback();}}));
    else await pipeline(createReadStream(input,{start:HEADER,end:size-TAG-1}),decipher,count.transform,out);
    const expected=JSON.parse(readFileSync(input+'.source.json','utf8')),actual=count.result();
    if(expected.bytes!==actual.bytes||expected.sha256!==actual.sha256)throw new Error('plaintext size or SHA-256 mismatch');
    if(command==='verify')console.log(`AES-256-GCM verified: ${actual.bytes} plaintext bytes`);
  } catch(error){if(destination&&destination!=='-')rmSync(destination,{force:true});throw error;}
}
