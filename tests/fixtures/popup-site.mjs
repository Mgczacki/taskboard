// A local test site for the switch of the task browser view to new tabs and popups (server/tab-switch.ts). The main
// page has one control for each case, at a fixed place, so a test can click it through the view (mouse messages):
// - y 40: window.open from a click
// - y 90: window.open in a timer, 300 ms after the click
// - y 140: a popup with a size (a window feature string)
// - y 190: an OAuth style popup: /oauth/start redirects twice, then /oauth/done posts 'token' to the opener (the main
//   page puts it in its title) and closes itself
// - y 240: two popups from one click (Chrome's popup blocker lets only the first one open)
// - y 290: a link with target=_blank
// - y 340: a plain link, for a middle click or a Cmd click (a background tab)
// - y 390: a blank popup that closes before its click handler returns
// /?autotimer=1 calls window.open 500 ms after the load, without a click (Chrome blocks it).
// Run alone: node tests/fixtures/popup-site.mjs [port]. It prints the port.
import http from 'node:http';

const btn = (i, id, label, js) => `<button id="${id}" style="position:absolute;left:20px;top:${20 + i * 50}px;width:300px;height:40px" onclick="${js}">${label}</button>`;
const link = (y, id, label, attrs) => `<a id="${id}" ${attrs} style="position:absolute;left:20px;top:${y}px;width:300px;height:40px;display:block;background:#ddd">${label}</a>`;
const main = `<!doctype html><title>main</title><body style="margin:0">
${btn(0, 'open', 'window.open', "window.open('/popup?click')")}
${btn(1, 'timer', 'window.open in a timer', "setTimeout(() => window.open('/popup?timer'), 300)")}
${btn(2, 'sized', 'sized popup', "window.open('/popup?sized','login','width=500,height=600')")}
${btn(3, 'oauth', 'OAuth popup', "window.open('/oauth/start','oauth','popup,width=500,height=600')")}
${btn(4, 'two', 'two popups', "window.open('/popup?one','one','width=400,height=400'); window.open('/popup?two','two','width=400,height=400')")}
${link(270, 'blank', 'target=_blank link', 'target="_blank" href="/target"')}
${link(320, 'bg', 'background link (middle or Cmd click)', 'href="/bgtarget"')}
${btn(7, 'quick', 'blank popup that closes at once', "const w = window.open(''); w.close()")}
<script>addEventListener('message', e => { document.title = 'got ' + e.data; });
if (location.search.includes('autotimer')) setTimeout(() => window.open('/popup?nogesture'), 500);</script>`;
const pages = {
  '/': main,
  '/popup': '<!doctype html><title>popup</title><h1>popup</h1>',
  '/target': '<!doctype html><title>target blank</title><h1>target</h1>',
  '/bgtarget': '<!doctype html><title>background</title><h1>bg</h1>',
  '/oauth/done': "<!doctype html><title>oauth done</title><script>opener && opener.postMessage('token', '*'); setTimeout(() => close(), 300);</script>",
};
export function startPopupSite(port = 0) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/oauth/start') { res.writeHead(302, { location: '/oauth/step2' }); return res.end(); }
      if (u.pathname === '/oauth/step2') { setTimeout(() => { res.writeHead(302, { location: '/oauth/done' }); res.end(); }, 50); return; }
      const body = pages[u.pathname];
      if (!body) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': 'text/html' }); res.end(body);
    });
    server.listen(port, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }));
  });
}
if (import.meta.url === `file://${process.argv[1]}`) startPopupSite(Number(process.argv[2] || 0)).then(s => console.log(s.url));
