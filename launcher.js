const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const port = Number(process.env.PORT || 3000);
const noBrowser = process.argv.includes('--no-browser');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function probe() {
  return new Promise(resolve => {
    const request = http.get({ hostname: '127.0.0.1', port, path: '/api/health', timeout: 1000 }, response => {
      let body = '';
      response.on('data', chunk => { if (body.length < 4096) body += chunk; });
      response.on('end', () => {
        try {
          resolve(response.statusCode === 200 && JSON.parse(body).app === 'ops-deck-jira' ? 'ready' : 'occupied');
        } catch { resolve('occupied'); }
      });
      response.on('error', () => resolve('occupied'));
    });
    request.on('timeout', () => request.destroy());
    request.on('error', error => resolve(error.code === 'ECONNREFUSED' ? 'free' : 'occupied'));
  });
}

function openBrowser(url) {
  if (noBrowser) return;
  const browser = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'start', '', url], {
    detached: true, stdio: 'ignore', windowsHide: true
  });
  browser.on('error', () => console.log(`Open this address in your browser: ${url}`));
  browser.on('exit', code => { if (code) console.log(`Open this address in your browser: ${url}`); });
  browser.unref();
}

async function main() {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be a number between 1 and 65535. Check your .env file.');
  }
  process.env.PORT = String(port);
  const url = `http://localhost:${port}`;
  const status = await probe();
  if (status === 'ready') {
    console.log(`Aether Desk is already running: ${url}`);
    openBrowser(url);
    return;
  }
  if (status === 'occupied') {
    throw new Error(`Port ${port} is being used by another application. Set a different PORT in .env and try again.`);
  }
  const server = require('./server');
  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await probe() === 'ready') {
        console.log('Keep this window open while using Aether Desk. Close it or press Ctrl+C to stop.');
        openBrowser(url);
        return;
      }
      await sleep(250);
    }
    throw new Error(`Aether Desk did not become ready. Check the messages above and try ${url}.`);
  } catch (error) {
    server.close();
    throw error;
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
