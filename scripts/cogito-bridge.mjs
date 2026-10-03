import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import WebSocket from 'ws';
import { completeInBrowser } from './deep-cogito.mjs';

const configPath = process.argv[2];
if (!configPath) throw new Error('Pass the path to the private bridge configuration.');
const config = JSON.parse(await readFile(configPath, 'utf8'));
if (config.url !== 'wss://gnome.science/__cogito/connect' || typeof config.key !== 'string' || config.key.length < 32) {
  throw new Error('Invalid bridge configuration');
}

let browserPromise;
let socket;
let retryTimer;
let stopping = false;
let retryDelay = 1000;
let active = 0;
const log = (...args) => console.log(new Date().toISOString(), ...args);

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ channel: 'chrome', headless: true }).then(browser => {
      browser.on('disconnected', () => { browserPromise = undefined; });
      return browser;
    }).catch(error => { browserPromise = undefined; throw error; });
  }
  return browserPromise;
}

function connect() {
  if (stopping) return;
  const ws = new WebSocket(config.url, {
    headers: { Authorization: `Bearer ${config.key}` }, handshakeTimeout: 15_000, maxPayload: 150_000,
  });
  socket = ws;
  let lastPong = Date.now();
  const heartbeat = setInterval(() => {
    if (Date.now() - lastPong > 60_000) return ws.terminate();
    if (ws.readyState === WebSocket.OPEN) ws.send('ping');
  }, 25_000);

  ws.on('open', () => { retryDelay = 1000; lastPong = Date.now(); log('Bridge connected'); });
  ws.on('message', async data => {
    if (data.toString() === 'pong') { lastPong = Date.now(); return; }
    let job;
    try { job = JSON.parse(data.toString()); } catch { return; }
    if (job.type !== 'completion' || typeof job.id !== 'string' || typeof job.body !== 'string') return;
    if (active >= 2) {
      ws.send(JSON.stringify({ type: 'result', id: job.id, status: 429, contentType: 'text/plain', text: '' }));
      return;
    }
    active++;
    const start = Date.now();
    let result;
    try {
      result = await completeInBrowser(await getBrowser(), job.body);
      log('Deep Cogito response', result.status, `${Date.now() - start}ms`);
    } catch (error) {
      log('Browser request failed:', error.name);
      result = { status: 502, contentType: 'text/plain', text: '' };
    } finally { active--; }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'result', id: job.id, ...result }));
  });
  ws.on('error', error => log('Bridge connection:', error.message));
  ws.on('close', () => {
    clearInterval(heartbeat);
    if (!stopping) {
      log('Bridge reconnecting');
      retryTimer = setTimeout(connect, retryDelay);
      retryDelay = Math.min(30_000, retryDelay * 2);
    }
  });
}

async function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(retryTimer);
  socket?.close();
  if (browserPromise) await (await browserPromise).close().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
connect();
