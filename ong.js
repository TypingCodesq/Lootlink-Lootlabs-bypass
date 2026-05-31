import puppeteer from 'puppeteer';
import WebSocket from 'ws';
import chalk from 'chalk';

// config
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'; // headers uwu
const MAX_WAIT = 99_000;
const POLL = 20;
const HB = 30_000;
const RETRY = 400;

const BLOCK = new Set(['image', 'media', 'font']); // ignore this
const SKIP_RE = /upload|developer|fonts|\.css|\/cdn-cgi\/rum|\/favicon\.ico|fonts\.googleapis\.com|fonts\.gstatic\.com|googleapis\.com\/css|stripe|api\.taboola\.com/i; //js ignore this

const XOR_LENS = [5, 4, 6, 8, 3];

const log = (tag, msg, ...args) => console.log(chalk.dim(`[${tag}]`), msg, ...args);

const host = (url) => {
  try { return new URL(url).hostname; } 
  catch { return 'loot-link.com'; } // retarded return
};

const isUrl = (s) => /^https?:\/\//i.test(String(s ?? '').trim()); // check 

const safeDec = (s) => {
  try { return decodeURIComponent(s); } 
  catch { return s; }
};

const fixB64 = (s) => String(s).replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '');

const scrape = (html) => {
  log('scrape', 'Extracting params...');
  const d = { tid: null, key: null, cdn: null, syn: null, vs: null };

  const sm = html.match(/document\.session\s*=\s*['"]([^'"]+)['"]/);
  if (sm) { d.vs = sm[1]; log('scrape', `session: ${d.vs}`); }

  d.tid =
    html.match(/p\[['"]TID['"]\]\s*=\s*(\d+)/)?.[1] ?? // for lootlinks
    html.match(/conf_rew\s*=\s*\{[\s\S]*?\bcd:\s*(\d+)/)?.[1]; // for rapid-links
  if (d.tid) log('scrape', `tid: ${d.tid}`);

  d.key =
    html.match(/p\[['"]KEY['"]\]\s*=\s*['"](\d+)['"]/)?.[1] ?? // for lootlinks
    html.match(/\bkey:\s*['"](\d{10,})['"]/)?.[1]; // for rapid-links
  if (d.key) log('scrape', `key: ${d.key}`);

  const cm = html.match(/p\['CDN_DOMAIN'\]\s*=\s*'([^']+)';/)?.[1]; // universal (lootlinks & rapid-links)
  if (cm) { d.cdn = cm; log('scrape', `cdn: ${cm}`); }

  if (!d.tid || !d.key) log('scrape', chalk.yellow('Incomplete params'), JSON.stringify(d));
  return d;
};

// nigga
const xor = (enc, len) => {
  const raw = Buffer.from(fixB64(enc), 'base64').toString('utf-8');
  const key = raw.slice(0, len);
  const data = raw.slice(len);
  let out = '';
  for (let i = 0; i < data.length; i++) {
    out += String.fromCharCode(data.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return out;
};

const firstUrl = (...xs) => xs.find(isUrl) ?? null;

const tryXor = (raw, label) => {
  for (const len of XOR_LENS) {
    try {
      const dec = xor(raw, len);
      const hit = firstUrl(dec, safeDec(dec));
      if (hit) { log('decode', chalk.green(`XOR${len} ${label}`), hit); return hit; }
    } catch {}
  }
  return null;
};

const decode = (raw, t0) => {
  const s = String(raw).trim();
  log('decode', `Payload ${s.length} chars`);

  const d = safeDec(s);
  if (isUrl(d)) { 
    const time = ((Date.now() - t0) / 1000).toFixed(2);
    console.log(`${d} (${time}s)`);
    return d; 
  }

  try {
    const p = Buffer.from(fixB64(s), 'base64').toString('utf-8');
    const hit = firstUrl(p, safeDec(p));
    if (hit) { log('decode', chalk.green('b64 ok'), hit); return hit; }
  } catch {}

  const x = tryXor(s, 'raw') ?? tryXor(safeDec(s), 'decoded');
  if (x) return x;

  try {
    const f = safeDec(xor(s, 5));
    log('decode', chalk.yellow('fallback'), f);
    return f;
  } catch {
    log('decode', chalk.red('all failed'));
    return s;
  }
};

const hdrs = (h) => ({
  referer: `https://${h}/`,
  origin: `https://${h}/`,
  'user-agent': UA,
});

const fire = (uid, tid, t, sid, d, h) => {
  const sub = parseInt(uid.slice(-5), 10) % 3;
  const syn = d.syn || 'nerventualken.com';
  const hd = hdrs(h);

  log('http', `sub=${sub} <--`);

  const reqs = [
    ...(d.vs
      ? [{ url: `https://${h}/verify`, method: 'POST', headers: { ...hd, 'content-type': 'text/plain;charset=UTF-8' }, body: d.vs }]
      : []),
      { url: `https://${sub}.onsultingco.com/st?uid=${uid}&cat=${tid}`, method: 'POST', headers: hd }
  ]; // urls,

  reqs.forEach(({ url, method, headers, body }) => {
    fetch(url, { method, headers, body, keepalive: true })
      .then(() => log('http', chalk.green('OK'), url.split('?')[0]))
      .catch((e) => log('http', chalk.red('ERR'), `${url.split('?')[0]} - ${e.message}`));
  });
};

const wsConnect = (uid, tid, t, sid, d, h, st) =>
  new Promise((done) => {
    const sub = parseInt(uid.slice(-5), 10) % 3;
    const url = `wss://${sub}.onsultingco.com/c?uid=${uid}&cat=${tid},2&key=${d.key}&session_id=${sid}&is_loot=1&tid=${t}`;
    log('ws', `Connecting (${((Date.now() - st) / 1000).toFixed(1)}s)`);
// ws ekfkedfdm
    const ws = new WebSocket(url, { 
      headers: hdrs(h),
      handshakeTimeout: 3000,
    });
    let ok = false;

    const end = (v) => {
      if (ok) return;
      ok = true;
      clearInterval(ping);
      try { ws.close(); } catch {}
      done(v);
    };

    const ping = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('0'); }, HB);

    ws.on('open', () => { log('ws', chalk.green('Connected')); ws.send('0'); });

    ws.on('message', (ev) => {
      const txt = ev.toString('utf-8');
      const i = txt.indexOf('r:');
      if (i === -1) return;
      log('ws', chalk.green('Payload received'));
      end(decode(txt.slice(i + 2), st));
    });

    ws.on('error', (e) => { log('ws', chalk.red(e.message)); end(null); });
  });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

class Resolver {
  constructor() {
    this.br = null;
    this.pg = null;
    this.url = null;
    this.busy = false;
    this.t0 = 0;
  }

  async _init(h) {
    log('browser', 'Launching...');
    this.br = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-extensions', '--disable-background-networking', '--blink-settings=imagesEnabled=false',
      ], //browser kokokokoko
    });
    this.pg = await this.br.newPage();
    await this.pg.setUserAgent(UA);
    await this.pg.setCacheEnabled(false);
    await this.pg.setRequestInterception(true);
    log('browser', chalk.green('Ready'));

    await this.pg.evaluateOnNewDocument(() => {
      const clean = () => {
        document.querySelectorAll('.modal,.popup,.overlay,.ad,.interstitial,[class*=modal],[class*=popup],[class*=overlay],.cookie,.gdpr,div[style*="position:fixed"],div[style*="z-index:9999"]')
          .forEach((e) => e.remove());
      };
      clean();
      new MutationObserver(clean).observe(document.body, { childList: true, subtree: true });
      window.alert = window.confirm = window.prompt = () => {};
    });

    this.pg.on('request', (req) => {
      if (BLOCK.has(req.resourceType()) || SKIP_RE.test(req.url())) {
        req.abort();
        return;
      }
      req.continue();
    });
  }

  async _scrape() {
    log('scrape', 'Reading page...');
    let d = scrape(await this.pg.content());
    if (d.tid && d.key) return d;
    await wait(RETRY);
    log('scrape', chalk.yellow('Retrying...'));
    return scrape(await this.pg.content());
  }

  async _onResp(resp, link) {
    if (this.url || this.busy) return;
    const u = resp.url();
    if (!u.includes('/tc') || resp.request().method() !== 'POST') return;
    log('resp', '/tc'); // blblbl /tc

    const ct = resp.headers()['content-type'] || '';
    if (!ct.includes('application/json')) { log('resp', chalk.red('Not JSON')); return; }

    let json;
    try { json = await resp.json(); } 
    catch { log('resp', chalk.red('Parse error')); return; }

    if (!Array.isArray(json) || !json.length) { log('resp', chalk.yellow('Empty array')); return; }

    this.busy = true;
    try {
      const { urid: uid, tier_id: tid = '8', session_id: sid = '' } = json[0];
      log('data', `uid=${uid} tid=${tid} sid=${sid}`);

      const d = await this._scrape();
      const { tid: t, key } = d;
      if (!t || !key) { log('data', chalk.red('Missing tid/key')); return; }

      log('data', `tid=${t} key=${key}`);
      const h = host(link);

      fire(uid, tid, t, sid, d, h);
      log('pipe', 'Waiting for WS...');

      const final = await wsConnect(uid, tid, t, sid, d, h, this.t0);
      if (final) {
        this.url = final;
      }
    } finally {
      this.busy = false;
    }
  }

  async go(link) {
    if (!link) { log('err', chalk.red('link????r[]we[pkfgdr')); return null; }

    this.url = null;
    this.busy = false;
    this.t0 = Date.now();
    log('go', link);

    try {
      await this._init(host(link));

      this.pg.on('response', (r) => {
        this._onResp(r, link).catch((e) => log('err', e.message));
      });

      log('nav', 'Loading page...');
      await this.pg.goto(link, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      log('nav', chalk.green('DOM ready'));

      const dl = Date.now() + MAX_WAIT;
      while (!this.url && Date.now() < dl) await wait(POLL);

      return this.url;
    } catch (e) {
      log('err', chalk.red(e.message));
      return null;
    } finally {
      if (this.br) await this.br.close();
    }
  }
}

const r = new Resolver();
r.go('https://rapid-links.com/s?HiW6incB'').then((u) => {
  if (!u) {
    const time = ((Date.now() - r.t0) / 1000).toFixed(2);
    console.log(chalk.bgRed.black(`[TIMEOUT] (${time}s)`));
  }
}); // nigga

// example link with lootlink: https://links.lootlabs.gg/s?UvQO6IEp&data=BKLXBOPVcyptATUon%2BS6z57I8yM2EmTH4n7aeg656NWWox1unkG5zy9JBKRgaDdt&redirect=javascript:eval(decodeURI(atob(%22bG9jYXRpb24ucmVwbGFjZShsb2NhdGlvbi5vcmlnaW4lMjArJTIwbG9jYXRpb24ucGF0aG5hbWUlMjArJTIwbG9jYXRpb24uc2VhcmNoLnNwbGl0KCcmJyklNUIwJTVEJTIwKyUyMCcmZGF0YT1CS0xYQk9QVmN5cHRBVFVvbiUyNTJCUzZ6NEY5azVJYy8xRXJsdEs0dG82dms0dyUyNTNEJyk7%22)));

// credits to TypingCodesq (https://github.com/TypingCodesq)

// skid it and kys
