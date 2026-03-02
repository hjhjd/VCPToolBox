#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const DEBUG_LOG = path.resolve(__dirname, 'debug.log');
function probe(msg) {
  try { fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}][BRIDGE] ${msg}\n`); } catch(e) {}
}

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { data += chunk; });
process.stdin.on('end', () => {
  const logFile = path.resolve(__dirname, 'debug_input.log');
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${data.trim()}\n`);

  probe(`stdin received, length=${data.length}`);

  const { execFileSync } = require('child_process');
  try {
    const result = execFileSync('node', [path.resolve(__dirname, 'GitOperator.js')], {
      input: data,
      encoding: 'utf8',
      timeout: 28000,
      maxBuffer: 1024 * 1024 * 5
    });
    probe(`TRY-OK | result.length=${result ? result.length : 0} | first200=${result ? result.substring(0, 200) : '(null)'}`);
    probe(`stdout.writable=${process.stdout.writable}`);
    process.stdout.write(result);
    probe(`stdout.write completed`);
  } catch (e) {
    probe(`CATCH | e.status=${e.status} | e.signal=${e.signal} | stderr.length=${e.stderr ? e.stderr.length : 0} | stdout.length=${e.stdout ? e.stdout.length : 0}`);
    probe(`CATCH stderr first200=${e.stderr ? e.stderr.substring(0, 200) : '(null)'}`);
    probe(`CATCH stdout first200=${e.stdout ? e.stdout.substring(0, 200) : '(null)'}`);
    if (e.stdout) process.stdout.write(e.stdout);
    else console.log(JSON.stringify({ status: 'error', error: e.message }));
    process.exit(1);
  }
});