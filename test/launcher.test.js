'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Exercise launch refusal before any OMP process starts.
async function runLauncher(t, scenario, args = [], env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ompt3-launch-'));
  const log = path.join(dir, 'launches.jsonl');
  const fake = path.join(dir, 'omp');
  fs.writeFileSync(fake, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('omp/18.12.6'); process.exit(0); }
if (args[0] === 'models') { console.log('[]'); process.exit(0); }
fs.appendFileSync(process.env.LAUNCH_LOG, JSON.stringify(args)+'\\n');
fs.appendFileSync(process.env.LAUNCH_LOG+'.pids',process.pid+'\\n');
`);
  fs.chmodSync(fake, 0o755);
  const child = spawn(process.execPath, [path.resolve('bin/omp-t3'), '--mode', 'rpc', ...args], {
    detached: true,
    env: {...process.env, OMP_PATH: fake, LAUNCH_LOG:log, ...env},
    stdio: ['pipe','pipe','pipe']
  });
  let stdout='', stderr='';
  child.stdout.on('data', d=>{stdout+=d;});
  child.stderr.on('data', d=>{stderr+=d;});
  const exited = new Promise(resolve=>child.once('close', code=>resolve(code)));
  const killOwnGroup = ()=>{try {process.kill(-child.pid,'SIGKILL');} catch(err) {if(err.code!=='ESRCH') throw err;}};
  t.after(async()=>{killOwnGroup(); await exited; fs.rmSync(dir,{recursive:true,force:true});});
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Launcher timed out: '+stderr)),7000);
    const check=()=>{if(stdout.includes('"type":"ready"')){clearTimeout(timer);resolve();}};
    child.stdout.on('data',check);
    child.once('close',()=>{clearTimeout(timer);resolve();});
  });
  killOwnGroup();
  await exited;
  const launches=fs.existsSync(log) ? fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse) : [];
  const pids=fs.existsSync(log+'.pids') ? fs.readFileSync(log+'.pids','utf8').trim().split('\n').map(Number) : [];
  return {stdout,stderr,launches,pids};
}



test('launcher refuses an incompatible T3 bridge instead of starting without the guard', async t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ompt3-drift-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const extension=path.join(dir,'pi-t3-mcp-extension.ts');
 fs.writeFileSync(extension,'export default function changedUpstream() {}');
 const result=await runLauncher(t,'single',['--extension',extension]);
 assert.match(result.stderr,/Launch refused: Cannot enforce subagent model policy/);
 assert.doesNotMatch(result.stdout,/"type":"ready"/,'no unguarded final launch');
 assert.equal(result.launches.length,0,'bridge adaptation must precede the only OMP launch');
});

test('launcher refuses malformed model lists before starting OMP', async t => {
 const result=await runLauncher(t,'single',[],{OMPT3_SUBAGENT_ALLOWED_MODELS:'glm-5.3-flash,'});
 assert.equal(result.launches.length,0);
 assert.match(result.stderr,/Launch refused: OMPT3_SUBAGENT_ALLOWED_MODELS/);
});

test('launcher refuses an unwritable policy cache before starting OMP', async t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ompt3-cache-failure-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const blocker=path.join(dir,'file');
 fs.writeFileSync(blocker,'block directory creation');
 const result=await runLauncher(t,'single',[],{XDG_CACHE_HOME:blocker});
 assert.equal(result.launches.length,0);
 assert.match(result.stderr,/Launch refused:/);
});

