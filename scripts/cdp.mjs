import fs from 'node:fs';
const mode = process.argv[2];
const arg = process.argv[3];
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find(t => t.type === 'page');
if (!page) { console.log('NO_PAGE'); process.exit(2); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map(); let id = 0;
function send(method, params) { return new Promise((res, rej) => { const myId = ++id; pending.set(myId, { res, rej }); ws.send(JSON.stringify({ id: myId, method, params })); }); }
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.rej(new Error(JSON.stringify(m.error))); else p.res(m.result); } });
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
if (mode === 'read' || mode === 'attach') {
  const expr = fs.readFileSync(arg, 'utf8');
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) console.log('EXC ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description));
  else console.log(typeof r.result.value === 'string' ? r.result.value : JSON.stringify(r.result.value));
} else if (mode === 'shot') {
  const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  fs.writeFileSync(arg, Buffer.from(r.data, 'base64'));
  console.log('SHOT ' + fs.statSync(arg).size);
} else if (mode === 'click') {
  const [x, y] = arg.split(',').map(Number);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
  await sleep(80);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(60);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  console.log('CLICK ' + x + ',' + y);
} else if (mode === 'dblclick') {
  const [x, y] = arg.split(',').map(Number);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
  await sleep(80);
  for (let i = 1; i <= 2; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: i });
    await sleep(30);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: i });
    await sleep(60);
  }
  console.log('DBLCLICK ' + x + ',' + y);
} else if (mode === 'dblclick-img') {
  const expr = "(function(){ var im=document.querySelectorAll('img')[0]; if(!im) return null; im.scrollIntoView({block:'center'}); var r=im.getBoundingClientRect(); return JSON.stringify({x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2), src:im.getAttribute('src')}); })()";
  const rr = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (!rr.result.value) { console.log('NO_IMG'); ws.close(); process.exit(0); }
  const info = JSON.parse(rr.result.value);
  await sleep(250);
  const rr2 = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  const p = JSON.parse(rr2.result.value);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', clickCount: 0 });
  await sleep(60);
  for (let i = 1; i <= 2; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: i });
    await sleep(30);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: i });
    await sleep(70);
  }
  console.log('DBLCLICK_IMG ' + p.x + ',' + p.y + ' ' + p.src);
} else if (mode === 'key') {
  const parts = arg.split('+');
  const mods = []; let key = parts[parts.length - 1];
  const modMap = { ctrl: 2, alt: 1, shift: 8, meta: 4 };
  for (let i = 0; i < parts.length - 1; i++) mods.push(modMap[parts[i].toLowerCase()] || 0);
  const mask = mods.reduce((a, b) => a | b, 0);
  const keyMap = { '`': { code: 'Backquote', key: '`', vk: 192 }, enter: { code: 'Enter', key: 'Enter', vk: 13 }, tab: { code: 'Tab', key: 'Tab', vk: 9 }, escape: { code: 'Escape', key: 'Escape', vk: 27 }, arrowup: { code: 'ArrowUp', key: 'ArrowUp', vk: 38 }, arrowdown: { code: 'ArrowDown', key: 'ArrowDown', vk: 40 }, delete: { code: 'Delete', key: 'Delete', vk: 46 }, backspace: { code: 'Backspace', key: 'Backspace', vk: 8 } };
  const lk = key.toLowerCase();
  const info = keyMap[lk] || { code: 'Key' + key.toUpperCase(), key: key.length === 1 ? key : key, vk: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0 };
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: mask, code: info.code, key: info.key, windowsVirtualKeyCode: info.vk, nativeVirtualKeyCode: info.vk });
  await sleep(50);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: mask, code: info.code, key: info.key, windowsVirtualKeyCode: info.vk, nativeVirtualKeyCode: info.vk });
  console.log('KEY ' + arg);
} else if (mode === 'type') {
  for (const ch of arg) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    await sleep(30);
  }
  console.log('TYPE ' + arg);
} else { console.log('UNKNOWN_MODE'); }
ws.close();