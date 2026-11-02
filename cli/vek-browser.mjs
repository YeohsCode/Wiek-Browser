#!/usr/bin/env node
import { readFile, mkdir, writeFile, open } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import WebSocket from 'ws';
import {waitForHostExit, shutdownTimeout} from './host-lifecycle.mjs';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packaged = /[\\/]Contents[\\/]Resources[\\/]app$/.test(root);
const defaultData = packaged
  ? process.platform === 'darwin' ? join(homedir(), 'Library/Application Support/Vek Browser')
    : join(process.env.APPDATA || join(homedir(), '.config'), 'Vek Browser')
  : join(root, 'data');
const dataDir = resolve(process.env.VEK_DATA_DIR || defaultData);
const runtimePath = join(dataDir, 'runtime.json');
const args = process.argv.slice(2);
const usage = `Vek Browser — local browser and agent workspace\n\n  vek-browser start                  Open the browser\n  vek-browser status                 Show host status\n  vek-browser scheduler tick         Run opted-in due CLI automations once while closed\n  vek-browser api ACTION --json JSON Call the local workbench API\n  vek-browser skill                  Print the agent API guide\n  vek-browser nodejs [-e JavaScript]  Run a script (or read stdin)\n  vek-browser nodejs --sdk-path PATH  Use an explicit compatible SDK\n  vek-browser stop [--timeout-ms N]  Wait for this browser to exit (default 30000 ms)\n\nExample:\n  const task = await taskSpace('research');\n  const page = task.page('p1');\n  await page.goto('https://example.com');\n  console.log(await page.snapshot());\n\nVEK_DATA_DIR selects an independent persistent browser data directory.\n`;
let rpc;
try {
  if (args.includes('--help') || args[0] === '-h') {
    process.stdout.write(usage);
  } else if (args[0] === 'scheduler') {
    if(args[1]!=='tick'||(args.length!==2&&(args.length!==4||args[2]!=='--timeout-ms')))throw new Error('Usage: vek-browser scheduler tick [--timeout-ms N]');
    const controller=new AbortController(),abort=()=>controller.abort();process.once('SIGINT',abort);process.once('SIGTERM',abort);
    try {const {runSchedulerTick}=require('../app/scheduler-worker.cjs');const result=await runSchedulerTick({dataDir,timeoutMs:args.length===4?Number(args[3]):60000,signal:controller.signal});process.stdout.write(JSON.stringify(result,null,2)+'\n');if(['timed-out','cancelled'].includes(result.status))process.exitCode=2;}finally{process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);}
  } else if (args[0] === 'skill') {
    const text = await readFile(join(root, 'packages/sdk/skill-body/SKILL.md'), 'utf8');
    process.stdout.write(text.replaceAll('ego-browser', 'vek-browser'));
  } else if (args[0] === 'status') {
    rpc = await connect(false);
    process.stdout.write(JSON.stringify(await rpc.call('browserInfo'), null, 2) + '\n');
  } else if (args[0] === 'stop') {
    const timeoutMs = shutdownTimeout(args.slice(1));
    rpc = await connect(false);
    const host = await rpc.call('browserInfo');
    if (!Number.isSafeInteger(host.pid) || host.pid <= 0 || host.pid !== rpc.runtime.pid || !host.browserInstanceId || host.browserInstanceId !== rpc.runtime.browserInstanceId) throw new Error('Host identity changed; no shutdown request was sent');
    await rpc.call('shutdown');
    rpc.close();
    await waitForHostExit(host.pid, {timeoutMs});
    process.stdout.write('Vek Browser stopped.\n');
  } else if (args[0] === 'start') {
    rpc = await connect(true);
    process.stdout.write('Vek Browser is running.\n');
  } else if (args[0] === 'api' && args[1] === 'help') {
    process.stdout.write(await readFile(join(root,'skills/vek-browser/API.md'),'utf8'));
  } else if (args[0] === 'api') {
    const action = args[1];
    if (!action || !/^(agents|workspace|mcp|catalog|voice|preferences|memory|permissions|download|library|recorder|desktop|profile|homepin|space|spaces):[A-Za-z0-9:_-]+$/.test(action)) throw new Error('Usage: vek-browser api ACTION [--json JSON] (or JSON on stdin)');
    if (args.length > 2 && (args[2] !== '--json' || args.length !== 4)) throw new Error('Expected --json followed by one JSON object');
    const source = args[2] === '--json' ? args[3] : process.stdin.isTTY ? '{}' : await readStdin();
    const value = source.trim() ? JSON.parse(source) : {};
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('API payload must be a JSON object');
    rpc = await connect(true);
    process.stdout.write(JSON.stringify(await rpc.call('workbenchAction', [action, value]), null, 2) + '\n');
  } else {
    const parsed = parseScriptArgs(args);
    const source = parsed.expression ?? await readStdin();
    if (!source.trim()) throw new Error(usage);
    rpc = await connect(true);
    process.env.EGO_BROWSER_STATE_DIR ||= join(dataDir, 'sdk-state');
    process.env.EGO_BROWSER_AGENT_WORKSPACE ||= join(root, 'skills/ego-browser');
    process.env.VEK_BROWSER_INSTANCE_ID = rpc.runtime.browserInstanceId;
    const ego = createEgoAdapter(rpc);
    globalThis.ego = ego;
    const sdkPath = resolve(parsed.sdkPath || join(root, 'packages/sdk/dist/out/index.js'));
    if (!existsSync(sdkPath)) throw new Error('SDK build missing. Run npm run build:sdk first.');
    const sdk = await import(pathToFileURL(sdkPath).href);
    try {
      process.exitCode = await sdk.runMain({ argv: [], stdinText: source });
    } finally {
      await sdk.disposeEgoSdk?.();
    }
  }
} catch (error) {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
} finally {
  rpc?.close();
}

function parseScriptArgs(argv) {
  const rest = [...argv];
  if (rest[0] === 'nodejs') rest.shift();
  let sdkPath;
  let expression;
  while (rest.length) {
    const arg = rest.shift();
    if (arg === '--sdk-path') {
      sdkPath = rest.shift();
      if (!sdkPath) throw new Error('--sdk-path requires a file');
    } else if (arg === '-e' || arg === '--eval') {
      expression = rest.shift();
      if (expression === undefined) throw new Error(`${arg} requires JavaScript`);
    } else throw new Error(`Unknown argument: ${arg}\n${usage}`);
  }
  return { sdkPath, expression };
}

async function readStdin() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function connect(autoStart) {
  try { return await connectExisting(); } catch (error) {
    if (autoStart && process.env.VEK_BROWSER_AUTOSTART==='0') throw new Error('Browser auto-start is disabled in this automation worker');
    if (!autoStart) throw new Error(`Vek Browser is not running (${error.message}). Run vek-browser start.`);
  }
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const log = await open(join(dataDir, 'browser.log'), 'a', 0o600);
  const electron = process.env.VEK_ELECTRON_PATH || (packaged
    ? resolve(root, '../../MacOS/Vek Browser')
    : require('electron'));
  const env = { ...process.env, VEK_DATA_DIR: dataDir };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [root], {
    detached: true, env, stdio: ['ignore', log.fd, log.fd],
  });
  let spawnError;
  child.on('error', error => { spawnError = error; });
  child.unref();
  await log.close();
  const deadline = Date.now() + 25000;
  let last;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    try { return await connectExisting(); } catch (error) { last = error; }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Vek Browser did not start: ${last?.message}. See ${join(dataDir, 'browser.log')}`);
}

async function connectExisting() {
  const runtime = JSON.parse(await readFile(runtimePath, 'utf8'));
  if (!Number.isInteger(runtime.port) || !runtime.token || !runtime.pid) throw new Error('Invalid runtime metadata');
  process.kill(runtime.pid, 0);
  const socket = new WebSocket(`ws://127.0.0.1:${runtime.port}/rpc?token=${encodeURIComponent(runtime.token)}`, {
    handshakeTimeout: 2000,
  });
  await new Promise((res, rej) => {
    socket.once('open', res);
    socket.once('error', rej);
  });
  let seq = 0;
  const pending = new Map();
  const listeners = new Set();
  socket.on('message', bytes => {
    let msg;
    try { msg = JSON.parse(bytes.toString()); } catch { return; }
    if (msg.event) { for (const listener of listeners) listener(msg); return; }
    const request = pending.get(msg.id);
    if (!request) return;
    pending.delete(msg.id);
    clearTimeout(request.timer);
    if (msg.error) {
      const error = new Error(msg.error.message || String(msg.error));
      error.error_code = msg.error.error_code;
      request.reject(error);
    } else request.resolve(msg.result);
  });
  const fail = error => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  };
  socket.on('close', () => fail(new Error('Vek Browser connection closed')));
  socket.on('error', fail);
  return {
    runtime,
    listen(fn) { listeners.add(fn); },
    call(method, args = [], spaceId) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Vek RPC timed out: ${method}`)); }, 120000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, args, ...(spaceId === undefined ? {} : {spaceId}) }), error => {
          if (error) { pending.delete(id); clearTimeout(timer); reject(error); }
        });
      });
    },
    close() { socket.close(); setTimeout(() => socket.terminate(), 100).unref(); },
  };
}

function createEgoAdapter(rpc) {
  let selectedSpace;
  const ego = {};
  const noArg = new Set(['getBrowserVersion','listProfiles','listTabs','listTaskSpaces','closeTaskSpace','completeTaskSpace','handOffTaskSpace','takeOverTaskSpace']);
  for (const method of [
    'getBrowserVersion','listProfiles','createTab','listTabs','snapshot','listTaskSpaces',
    'createTaskSpace','claimTaskSpace','closeTaskSpace','completeTaskSpace','handOffTaskSpace',
    'takeOverTaskSpace','setAgentTaskState','animationHighlightMouseToPosition',
  ]) {
    ego[method] = (...args) => {
      if (noArg.has(method) && args.length) throw invalid(`${method} accepts no arguments`);
      if (method === 'createTab' && (args.length !== 1 || typeof args[0] !== 'string')) throw invalid('createTab requires a URL string');
      return rpc.call(method, args, selectedSpace);
    };
  }
  ego.useTaskSpace = (...args) => {
    if (args.length !== 1 || !Number.isInteger(args[0]) || args[0] < 0) throw invalid('useTaskSpace requires a non-negative integer id');
    selectedSpace = args[0];
    return selectedSpace;
  };
  ego.sendCDPMessage = (...args) => {
    if (args.length !== 1 || typeof args[0] !== 'string') throw invalid('sendCDPMessage requires a JSON string');
    void rpc.call('sendCDPMessage', args, selectedSpace).catch(error => ego.onSendCDPMessageError?.(error.message, error.error_code || 'EGO_CDP_SEND_FAILED'));
  };
  rpc.listen(msg => {
    if (msg.event === 'cdp') ego.onCDPMessage?.(msg.payload);
    if (msg.event === 'cdp-error') ego.onSendCDPMessageError?.(msg.message, msg.error_code);
  });
  return ego;
}
function invalid(message) { const e = new TypeError(message); e.error_code = 'EGO_INVALID_ARGUMENT'; return e; }
