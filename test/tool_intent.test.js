'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { installToolIntent } = require('../src/tool_intent.js');
const { ToolPresentation } = require('../src/tool_presentation.js');
const { createProxyPipeline } = require('../src/proxy.js');
const { createMockStreams, collectLines } = require('./helpers.js');

test('provider boundary requires intent for eval, wait and extension tools without changing execution schemas', () => {
  const manager = {};
  const events = new Map();
  let received;
  const agent = { streamFn: (...args) => { received = args; return 'stream'; } };
  const pi = { on: (name, handler) => events.set(name, handler), pi: { AgentRegistry: { global: () => ({ list: () => [{session:{sessionManager:manager,agent}}] }) } } };
  installToolIntent(pi);
  events.get('session_start')({}, {sessionManager:manager});
  const wrapped = agent.streamFn;
  events.get('session_start')({}, {sessionManager:manager});
  assert.equal(agent.streamFn, wrapped);
  const tools = ['eval','wait','extension_tool'].map(name => ({name,parameters:{type:'object',properties:{value:{type:'string'}},required:['value']}}));
  const original = structuredClone(tools);
  const model = {}, options = {};
  assert.equal(agent.streamFn(model,{tools,messages:[]},options), 'stream');
  assert.equal(received[0], model);
  assert.equal(received[2], options);
  for (const tool of received[1].tools) {
    assert.deepEqual(tool.parameters.required, ['value','i']);
    assert.equal(tool.parameters.properties.i.type, 'string');
    assert.match(tool.parameters.properties.i.description, /purpose/);
  }
  assert.deepEqual(tools, original);
});

test('concurrent purposes persist by call id through updates and errors', () => {
  const p = new ToolPresentation();
  const apply = frame => JSON.parse(p.handleDownstreamFrame(JSON.stringify(frame)).line);
  for (const [id,tool,intent] of [['a','read','检查材料参数'],['b','eval','计算透射效率'],['c','custom_tool','检查扩展输出']]) {
    const args = {i:intent,path:'data.json'};
    const start = apply({type:'tool_execution_start',toolCallId:id,toolName:tool,args,intent:' '});
    assert.equal(start.toolName,tool);
    assert.deepEqual(start.args,args);
    assert.equal(start.displayTitle,intent);
  }
  for (const [id,intent] of [['c','检查扩展输出'],['a','检查材料参数'],['b','计算透射效率']]) {
    const update = apply({type:'tool_execution_update',toolCallId:id,intent:' ',partialResult:{content:[]}});
    const end = apply({type:'tool_execution_end',toolCallId:id,isError:true,result:{content:[{type:'text',text:'failure'}]}});
    assert.equal(end.displayTitle,update.displayTitle);
    assert.equal(end.intent,intent);
    assert.equal(end.isError,true);
  }
  assert.equal(p.calls.size,0);
});

test('native intent metadata survives compacted alias arguments and todo completion', () => {
  const p = new ToolPresentation();
  const start = JSON.parse(p.handleDownstreamFrame(JSON.stringify({
    type:'tool_execution_start',toolCallId:'native-intent',toolName:'todo',
    args:{input:'*** Begin Todo\nVIEW\n*** End Todo'},intent:'检查任务进展'
  })).line);
  const end = JSON.parse(p.handleDownstreamFrame(JSON.stringify({
    type:'tool_execution_end',toolCallId:'native-intent',toolName:'todo',result:{content:[]}
  })).line);
  assert.equal(start.displayTitle,'检查任务进展');
  assert.equal(end.displayTitle,start.displayTitle);
  assert.equal(end.intent,'检查任务进展');
});

test('proxy sends purpose displayTitle with canonical tool identity and original output', async () => {
  const {stdin:clientIn,stdout:clientOut}=createMockStreams();
  const {stdin:childIn,stdout:childOut}=createMockStreams();
  const pipeline=createProxyPipeline({clientIn,clientOut,childIn,childOut});
  const output=collectLines(clientOut);
  pipeline.start();
  try {
    childOut.write(JSON.stringify({type:'tool_execution_start',toolCallId:'purpose',toolName:'eval',args:{language:'js',code:'1',i:'检查计算结果'}})+'\n');
    childOut.write(JSON.stringify({type:'tool_execution_end',toolCallId:'purpose',toolName:'eval',result:{content:[{type:'text',text:'1'}]}})+'\n');
    await new Promise(resolve => setImmediate(resolve));
    const frames=output.getJson().filter(f=>f.toolCallId==='purpose');
    assert.equal(frames.length,2);
    for(const frame of frames){assert.equal(frame.toolName,'eval');assert.equal(frame.displayTitle,'检查计算结果');}
    assert.equal(frames[1].result.content[0].text,'1');
  } finally {pipeline.stop();}
});
