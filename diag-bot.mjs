import { chromium } from 'playwright';
const b = await chromium.launch({ headless:true });
const ctx = await b.newContext({ locale:'ar-EG', viewport:{width:1440,height:900} });
const p = await ctx.newPage();
await p.goto('https://www.amazon.eg/dp/B0CTHHR6YF', { waitUntil:'domcontentloaded', timeout:45000 });
await p.waitForTimeout(5000);
const html = await p.content();
const lower = html.toLowerCase();
const markers = ['robot check','type the characters you see below','automated access to amazon data',"sorry, we just need to make sure you're not a robot",'enter the characters you see below','api-services-support@amazon.com'];
console.log('page size:', html.length);
console.log('=== marker check ===');
for (const m of markers) console.log(`  ${JSON.stringify(m)}: ${lower.includes(m)}`);
console.log('\n=== status code ===');
const r = await p.reload({waitUntil:'domcontentloaded'}).catch(()=>null);
console.log('  reload status:', r ? r.status() : 'n/a');
console.log('\n=== title ===');
console.log('  ', (await p.title()).slice(0,80));
// Show the snippet around any hit.
for (const m of markers) {
  if (lower.includes(m)) {
    const i = lower.indexOf(m);
    console.log(`\n  snippet for "${m}":\n  ...${html.slice(Math.max(0,i-80), i+120).replace(/\s+/g,' ').trim()}...`);
  }
}
await b.close();
