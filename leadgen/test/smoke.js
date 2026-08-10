const { chromium } = require('playwright');
const path = require('path');
const H = require('../src/humanize');
const { countOpenings } = require('../src/careers');
const { extractResultCards } = require('../src/scrape');

const EXEC = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

(async () => {
  const b = await chromium.launch({ headless: true, executablePath: EXEC });
  const p = await (await b.newContext({ viewport:{width:1280,height:800} })).newPage();
  const persona = H.newPersona();
  console.log('persona:', JSON.stringify(persona));

  // --- 1. delay distribution ------------------------------------------------
  const ds = Array.from({length:5000},()=>H.humanDelay(2000,3000)).sort((a,b)=>a-b);
  const mean = ds.reduce((a,b)=>a+b,0)/ds.length;
  console.log(`delay(2000,3000) p10=${ds[500]} p50=${ds[2500]} p90=${ds[4500]} p99=${ds[4950]} max=${ds[4999]} mean=${Math.round(mean)}`);

  // --- 2. scroll behaviour on a tall page -----------------------------------
  await p.goto('file://'+path.resolve(__dirname,'fixtures/careers.html'), {waitUntil:'domcontentloaded'});
  const trace = [];
  const t0 = Date.now();
  const timer = setInterval(async()=>{ try{ trace.push(await p.evaluate(()=>Math.round(window.scrollY))); }catch{} }, 120);
  await H.humanScroll(p, persona, { depth:'full' });
  clearInterval(timer);
  let ups=0; for(let i=1;i<trace.length;i++) if(trace[i]<trace[i-1]) ups++;
  console.log(`scroll: ${Date.now()-t0}ms, ${trace.length} samples, max scrollY=${Math.max(...trace)}, upward transitions=${ups} (${Math.round(ups/trace.length*100)}%)`);

  // --- 3. mouse path --------------------------------------------------------
  const pts=[]; p.on('console', m=>{ if(m.text().startsWith('M ')) pts.push(m.text()); });
  await p.evaluate(()=>document.addEventListener('mousemove', e=>console.log('M '+e.clientX+','+e.clientY)));
  await H.moveMouse(p, 900, 600, persona);
  await new Promise(r=>setTimeout(r,300));
  console.log(`mouse: ${pts.length} intermediate move events (a bot teleport would be 1)`);

  // --- 4. careers counting --------------------------------------------------
  console.log('countOpenings:', JSON.stringify(await countOpenings(p)));

  // --- 5. search card extraction --------------------------------------------
  await p.goto('file://'+path.resolve(__dirname,'fixtures/search.html'), {waitUntil:'domcontentloaded'});
  console.log('extractResultCards:');
  for (const c of await extractResultCards(p)) console.log('   ', JSON.stringify(c));

  // --- 6. typing ------------------------------------------------------------
  await p.setContent('<input id="q" style="font-size:20px;width:400px">');
  const tt=Date.now();
  await H.humanType(p, p.locator('#q'), 'CHRO India', persona, [90,260]);
  console.log(`typed "${await p.inputValue('#q')}" in ${Date.now()-tt}ms`);

  // --- 7. ordering ----------------------------------------------------------
  const ord = H.humanOrder([1,2,3,4,5,6,7,8,9,10], {skipRate:0.15});
  console.log('humanOrder sample:', ord.join(','));
  await b.close();
})();
