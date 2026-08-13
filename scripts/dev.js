import { spawn } from 'node:child_process';
import net from 'node:net';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const defaultApiPort = Number(process.env.API_PORT || process.env.PORT || 8787);
const defaultClientPort = Number(process.env.VITE_PORT || 5173);
const host = process.env.HOST || '127.0.0.1';

function canListen(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
        resolve(false);
        return;
      }

      reject(error);
    });

    server.once('listening', () => {
      server.close(() => resolve(true));
    });

    server.listen(port, host);
  });
}

async function findAvailablePort(startPort) {
  for (let port = startPort; port < startPort + 50; port += 1) {
    if (await canListen(port)) {
      return port;
    }
  }

  throw new Error(`No available port found from ${startPort} to ${startPort + 49}`);
}

function runScript(script, env) {
  return spawn(npmCommand, ['run', script], {
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
}

const apiPort = await findAvailablePort(defaultApiPort);
const clientPort = await findAvailablePort(defaultClientPort);

if (apiPort !== defaultApiPort) {
  console.log(`API port ${defaultApiPort} is in use, using ${apiPort} instead.`);
}

if (clientPort !== defaultClientPort) {
  console.log(`Client port ${defaultClientPort} is in use, using ${clientPort} instead.`);
}

console.log(`Starting API on http://${host}:${apiPort}`);
console.log(`Starting client on http://${host}:${clientPort}`);

const children = [
  runScript('dev:server', { PORT: String(apiPort), HOST: host }),
  runScript('dev:client', {
    API_PORT: String(apiPort),
    VITE_PORT: String(clientPort),
  }),
];

let shuttingDown = false;

function shutdown(signal, exitCode = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  for (const child of children) {
    if (!child.killed) {
      child.kill(signal);
    }
  }

  process.exitCode = exitCode;
}

for (const child of children) {
  child.on('exit', (code, signal) => {
    if (!shuttingDown) {
      shutdown(signal || 'SIGTERM', code ?? 1);
    }
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
