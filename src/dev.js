import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep API, worker, and local provider isolated so each owns its DB/Redis lifecycle.
const backendRoot = path.dirname(fileURLToPath(import.meta.url));
const scripts = [
  'src/server.js',
  'src/workers/simulation.worker.js',
  'src/mock-brain/server.js',
];
const children = scripts.map((script) => spawn(process.execPath, ['--watch', script], {
  cwd: path.resolve(backendRoot, '..'),
  env: process.env,
  stdio: 'inherit',
}));

let stopping = false;
function stopChildren() {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
}

process.once('SIGINT', stopChildren);
process.once('SIGTERM', stopChildren);
for (const child of children) child.once('error', stopChildren);
