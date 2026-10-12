#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { AmazonScraperError, closeBrowser, scrapeProduct, searchProducts } from './scraper.js';

const server = new McpServer({
  name: 'amazon-scraper-mcp',
  version: '0.1.0',
});

/**
 * Convert an unknown thrown value into MCP tool-error content.
 * Never let a raw stack trace reach the model.
 */
function toolError(error: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const message = error instanceof Error ? error.message : String(error);
  const hint = error instanceof AmazonScraperError ? error.hint : undefined;
  return {
    content: [{ type: 'text', text: hint ? `${message}\n\nHint: ${hint}` : message }],
    isError: true,
  };
}

server.registerTool(
  'search_products',
  {
    title: 'Search Amazon',
    description:
      'Search Amazon for products by keyword. Returns title, price, rating, review count, image and ASIN ' +
      'for each hit. Use `scrape_product` on a returned ASIN or URL for full detail.',
    inputSchema: {
      query: z.string().min(1).describe('Search terms, e.g. "usb c hub" or "mechanical keyboard"'),
      max_results: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Maximum number of products to return (1-50, default 10)'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ query, max_results }) => {
    try {
      const products = await searchProducts(query, max_results ?? 10);

      if (products.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No products found for "${query}". Try a broader or differently-worded query.`,
            },
          ],
        };
      }

      const lines = products.map((product, index) => {
        const parts = [`${index + 1}. ${product.title}`, `   ASIN: ${product.asin}`, `   URL: ${product.url}`];
        if (product.price) parts.push(`   Price: ${product.price}`);
        if (product.rating) parts.push(`   Rating: ${product.rating}`);
        if (product.reviewCount) parts.push(`   Reviews: ${product.reviewCount}`);
        return parts.join('\n');
      });

      return {
        content: [
          {
            type: 'text',
            text: `Found ${products.length} product(s) for "${query}":\n\n${lines.join('\n\n')}`,
          },
        ],
      };
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  'scrape_product',
  {
    title: 'Scrape Amazon Product',
    description:
      'Fetch full detail for a single Amazon product from its detail page. Accepts either a full product ' +
      'URL containing /dp/ASIN or a bare 10-character ASIN. Returns title, brand, price, rating, review ' +
      'count, availability, feature bullets and description.',
    inputSchema: {
      product_url_or_asin: z
        .string()
        .min(1)
        .describe('Full Amazon product URL (containing /dp/ASIN) or a bare 10-character ASIN'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ product_url_or_asin }) => {
    try {
      const product = await scrapeProduct(product_url_or_asin);

      const lines = [
        product.title,
        '',
        `ASIN:         ${product.asin}`,
        `URL:          ${product.url}`,
      ];

      if (product.brand) lines.push(`Brand:        ${product.brand}`);
      if (product.price) lines.push(`Price:        ${product.price}`);
      if (product.rating) lines.push(`Rating:       ${product.rating}`);
      if (product.reviewCount) lines.push(`Reviews:      ${product.reviewCount}`);
      if (product.availability) lines.push(`Availability: ${product.availability}`);

      if (product.features.length > 0) {
        lines.push('', 'Features:');
        for (const feature of product.features) lines.push(`- ${feature}`);
      }

      if (product.description) {
        lines.push('', 'Description:', product.description);
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      return toolError(error);
    }
  },
);

// Release Chromium when the client disconnects, rather than leaving the
// browser process running.
process.on('SIGINT', () => {
  void closeBrowser().finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  void closeBrowser().finally(() => process.exit(0));
});

const transport = new StdioServerTransport();
await server.connect(transport);

// stdout is the MCP transport channel, so all diagnostics must go to stderr.
console.error('amazon-scraper-mcp server running on stdio');