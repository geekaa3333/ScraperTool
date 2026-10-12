// Smoke test: connect to the built server over stdio and exercise both tools.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js'],
  stderr: 'inherit',
});

const client = new Client({ name: 'smoke-test', version: '1.0.0' });
await client.connect(transport);

const tools = await client.listTools();
console.log('TOOLS:', tools.tools.map((t) => t.name).join(', '));

// --- error handling: bad input should come back as a tool error, not a crash
const bad = await client.callTool({ name: 'scrape_product', arguments: { product_url_or_asin: 'not-a-url' } });
console.log('\n[bad input] isError =', bad.isError);
console.log((bad.content[0]?.text ?? '').split('\n')[0]);

// --- live search
console.log('\n[search_products] querying...');
const search = await client.callTool({
  name: 'search_products',
  arguments: { query: 'usb c hub', max_results: 3 },
});
console.log('isError =', search.isError);
console.log((search.content[0]?.text ?? '').slice(0, 1200));

// --- live product scrape using the first ASIN we found
const asin = /ASIN:\s*([A-Z0-9]{10})/.exec(search.content[0]?.text ?? '')?.[1];
if (asin) {
  console.log(`\n[scrape_product] ASIN ${asin}...`);
  const product = await client.callTool({
    name: 'scrape_product',
    arguments: { product_url_or_asin: asin },
  });
  console.log('isError =', product.isError);
  console.log((product.content[0]?.text ?? '').slice(0, 900));
} else {
  console.log('\n[scrape_product] skipped — no ASIN from search');
}

await client.close();