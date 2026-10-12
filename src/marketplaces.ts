/**
 * Centralised Amazon marketplace configuration.
 *
 * Every other module takes a marketplace identifier and asks this file for the
 * facts. Nothing outside here may hardcode a domain: adding a marketplace must
 * be a change to `MARKETPLACES` and to nothing else.
 *
 * Two invariants are enforced here rather than trusted to callers:
 *
 *  1. **Marketplace identity is never inferred from an ASIN.** The same ASIN
 *     routinely exists on several Amazon sites, so an ASIN alone proves nothing.
 *     `resolveMarketplace` therefore only answers from an explicit input (a
 *     region code, a country name, a domain, or a full URL) — never from the
 *     ASIN itself.
 *
 *  2. **Only exact known hosts are trusted.** `marketplaceFromUrl` matches
 *     against an allow-list of hostnames, so `amazon.com.evil.test` and
 *     `notamazon.co.uk` cannot masquerade as a supported marketplace.
 */

import type { Destination } from './types.js';

export type MarketplaceId = 'eg' | 'ae' | 'sa' | 'uk' | 'ca' | 'us';

export interface Marketplace {
  /** Stable internal identifier; also the database/cache namespace. */
  id: MarketplaceId;
  /** Amazon host, without a scheme. */
  domain: string;
  /** Display name used in the UI. */
  label: string;
  /** Country name. */
  country: string;
  /** ISO 3166-1 alpha-2 country code. */
  countryCode: string;
  /** ISO 4217 currency code. Prices are NEVER converted between these. */
  currency: string;
  /** Symbol shown next to amounts in the UI. */
  currencySymbol: string;
  /** Browser locale sent to Playwright for this marketplace. */
  locale: string;
  /** Languages the marketplace serves; used for parsing hints, never for translation. */
  languages: Array<'ar' | 'en'>;
  /** Hostnames (and bare domains) accepted for this marketplace. */
  hosts: string[];
  /** Cache namespace, kept separate per marketplace. */
  cacheNamespace: string;
  /** Default delivery destination used when none is chosen. */
  defaultDestination: Omit<Destination, 'verified'> & { verified: boolean };
  /** Seller-offer page path. */
  offersPath: string;
}

/**
 * The five supported marketplaces.
 *
 * `languages` is a *parsing* hint only. Scraped text is stored and exported
 * verbatim in whatever language Amazon served — see FEATURE 11. A marketplace
 * serving both English and Arabic listings gets both listed.
 */
export const MARKETPLACES: Record<MarketplaceId, Marketplace> = {
  eg: {
    id: 'eg',
    domain: 'amazon.eg',
    label: 'Amazon Egypt',
    country: 'Egypt',
    countryCode: 'EG',
    currency: 'EGP',
    currencySymbol: 'EGP',
    locale: 'ar-EG',
    languages: ['ar', 'en'],
    hosts: ['amazon.eg', 'www.amazon.eg', 'amzn.eg', 'www.amzn.eg'],
    cacheNamespace: 'eg',
    defaultDestination: {
      id: 'cairo',
      label: 'Cairo, Egypt',
      countryCode: 'EG',
      amazonLabel: 'القاهرة',
      postalCode: '11511',
      verified: true,
    },
    offersPath: '/gp/offer-listing/',
  },
  ae: {
    id: 'ae',
    domain: 'amazon.ae',
    label: 'Amazon UAE',
    country: 'United Arab Emirates',
    countryCode: 'AE',
    currency: 'AED',
    currencySymbol: 'AED',
    locale: 'en-AE',
    // Amazon.ae serves a large English catalogue alongside Arabic listings.
    languages: ['en', 'ar'],
    hosts: ['amazon.ae', 'www.amazon.ae', 'amzn.ae', 'www.amzn.ae'],
    cacheNamespace: 'ae',
    defaultDestination: {
      id: 'dubai',
      label: 'Dubai, UAE',
      countryCode: 'AE',
      amazonLabel: 'Dubai',
      postalCode: '00000',
      verified: true,
    },
    offersPath: '/gp/offer-listing/',
  },
  sa: {
    id: 'sa',
    domain: 'amazon.sa',
    label: 'Amazon Saudi Arabia',
    country: 'Saudi Arabia',
    countryCode: 'SA',
    currency: 'SAR',
    currencySymbol: 'ر.س',
    locale: 'ar-SA',
    // Amazon.sa serves a substantial English catalogue alongside Arabic
    // listings, exactly like amazon.eg and amazon.ae. Assuming Arabic-only
    // would misparse those pages, and nothing here is ever translated.
    languages: ['ar', 'en'],
    hosts: ['amazon.sa', 'www.amazon.sa', 'amzn.sa', 'www.amzn.sa'],
    cacheNamespace: 'sa',
    defaultDestination: {
      id: 'riyadh',
      label: 'Riyadh, Saudi Arabia',
      countryCode: 'SA',
      amazonLabel: 'الرياض',
      postalCode: '11564',
      // NOT verified: unlike the other markets, Amazon's public location
      // selector has not been confirmed to accept this from an automated
      // session. Left false so the UI never claims a destination that was
      // silently ignored — and so delivery estimates are labelled as such.
      verified: false,
    },
    offersPath: '/gp/offer-listing/',
  },
  uk: {
    id: 'uk',
    domain: 'amazon.co.uk',
    label: 'Amazon UK',
    country: 'United Kingdom',
    countryCode: 'GB',
    currency: 'GBP',
    currencySymbol: '£',
    locale: 'en-GB',
    languages: ['en'],
    hosts: ['amazon.co.uk', 'www.amazon.co.uk', 'amzn.co.uk', 'www.amzn.co.uk'],
    cacheNamespace: 'uk',
    defaultDestination: {
      id: 'london',
      label: 'London, UK',
      countryCode: 'GB',
      amazonLabel: 'London',
      postalCode: 'EC1A',
      verified: true,
    },
    offersPath: '/gp/offer-listing/',
  },
  ca: {
    id: 'ca',
    domain: 'amazon.ca',
    label: 'Amazon Canada',
    country: 'Canada',
    countryCode: 'CA',
    currency: 'CAD',
    currencySymbol: 'CA$',
    locale: 'en-CA',
    languages: ['en'],
    hosts: ['amazon.ca', 'www.amazon.ca', 'amzn.ca', 'www.amzn.ca'],
    cacheNamespace: 'ca',
    defaultDestination: {
      id: 'toronto',
      label: 'Toronto, Canada',
      countryCode: 'CA',
      amazonLabel: 'Toronto',
      postalCode: 'M5V',
      verified: true,
    },
    offersPath: '/gp/offer-listing/',
  },
  us: {
    id: 'us',
    domain: 'amazon.com',
    label: 'Amazon USA',
    country: 'United States',
    countryCode: 'US',
    currency: 'USD',
    currencySymbol: '$',
    locale: 'en-US',
    languages: ['en'],
    hosts: ['amazon.com', 'www.amazon.com', 'amzn.com', 'www.amzn.com'],
    cacheNamespace: 'us',
    defaultDestination: {
      id: 'newyork',
      label: 'New York, USA',
      countryCode: 'US',
      amazonLabel: 'New York',
      postalCode: '10001',
      verified: true,
    },
    offersPath: '/gp/offer-listing/',
  },
};

/** Stable display order for the UI. */
export const MARKETPLACE_IDS: MarketplaceId[] = ['eg', 'ae', 'sa', 'uk', 'ca', 'us'];

export const DEFAULT_MARKETPLACE: MarketplaceId = 'eg';

/** Marketplace config for an id, falling back to Egypt for unknown input. */
export function getMarketplace(id: string | null | undefined): Marketplace {
  if (id && id in MARKETPLACES) {
    return MARKETPLACES[id as MarketplaceId];
  }
  return MARKETPLACES[DEFAULT_MARKETPLACE];
}

/** True when the string is one of the five supported ids. */
export function isMarketplaceId(value: unknown): value is MarketplaceId {
  return typeof value === 'string' && value in MARKETPLACES;
}

/** Base origin for a marketplace, e.g. `https://www.amazon.eg`. */
export function originOf(marketplace: Marketplace): string {
  return `https://www.${marketplace.domain}`;
}

/** Canonical product page URL. */
export function productUrl(marketplace: Marketplace, asin: string): string {
  return `${originOf(marketplace)}/dp/${asin}`;
}

/** Canonical all-offers page URL. */
export function offersUrl(marketplace: Marketplace, asin: string): string {
  return `${originOf(marketplace)}${marketplace.offersPath}${asin}`;
}

/** Canonical search URL. */
export function searchUrl(marketplace: Marketplace, query: string): string {
  return `${originOf(marketplace)}/s?k=${encodeURIComponent(query)}`;
}

/**
 * Aliases accepted from a user's Excel "Region"/"Marketplace" column.
 *
 * Keys are compared after normalisation (lower-cased, trimmed, punctuation
 * collapsed), so `United Kingdom`, `united_kingdom` and `UNITED KINGDOM` all
 * resolve identically.
 */
const REGION_ALIASES: Record<string, MarketplaceId> = {
  // country codes
  eg: 'eg', egy: 'eg', egypt: 'eg',
  ae: 'ae', uae: 'ae', are: 'ae', 'united arab emirates': 'ae', dubai: 'ae',
  sa: 'sa', sau: 'sa', 'saudi arabia': 'sa', 'saudi': 'sa', ksa: 'sa', riyadh: 'sa',
  jeddah: 'sa', 'makkah': 'sa', mecca: 'sa', 'medina': 'sa',
  uk: 'uk', gb: 'uk', gbr: 'uk', britain: 'uk', 'great britain': 'uk',
  'united kingdom': 'uk', england: 'uk', london: 'uk',
  ca: 'ca', can: 'ca', canada: 'ca',
  us: 'us', usa: 'us', usa_usa: 'us', 'united states': 'us', 'united states of america': 'us',
  america: 'us', newyork: 'us',

  // domains
  'amazon eg': 'eg', 'amazoncom eg': 'eg',
  'amazon ae': 'ae', 'amazoncom ae': 'ae',
  'amazon sa': 'sa', 'amazonsa': 'sa', 'amazoncom sa': 'sa',
  'amazoncouk': 'uk', 'amazonuk': 'uk',
  'amazonca': 'ca', 'amazoncomca': 'ca',
  'amazoncom': 'us',
};

/**
 * Normalise a region-ish string: lower-case, strip everything but letters and
 * digits, then collapse spaces. Handles `amazon.co.uk`, `amazon_co_uk`,
 * `Amazon UK` and `UK` uniformly.
 */
function normalizeRegionKey(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalise a region-ish string for alias lookup (no spaces). */
function aliasKey(value: string): string {
  return normalizeRegionKey(value).replace(/ /g, '');
}

/**
 * Resolve a user-supplied region/marketplace string to a marketplace id.
 *
 * Accepts `EG`, `AE`, `UK`, `GB`, `CA`, `US`, `Egypt`, `UAE`, `United Kingdom`,
 * `Canada`, `USA`, `amazon.eg`, `amazon.co.uk`, and full product URLs.
 *
 * Returns `null` for anything unrecognised — callers must surface that as
 * unknown rather than defaulting silently.
 */
export function resolveMarketplace(input: unknown): MarketplaceId | null {
  if (!input) return null;

  const raw = String(input).trim();
  if (!raw) return null;

  // 1. A full or partial Amazon URL: identify by its host.
  if (raw.includes('amazon') || raw.includes('amzn')) {
    const fromUrl = marketplaceFromUrl(raw);
    if (fromUrl) return fromUrl;

    // Bare domain forms such as "amazon.co.uk" or "www.amazon.ae".
    const bare = raw.replace(/^https?:\/\//i, '').split(/[/?#]/)[0] ?? '';
    const hostMatch = MARKETPLACE_IDS.find((id) =>
      MARKETPLACES[id].hosts.some(
        (host) => host.toLowerCase() === bare.toLowerCase(),
      ),
    );
    if (hostMatch) return hostMatch;
  }

  // 2. Exact marketplace id.
  if (isMarketplaceId(raw.toLowerCase())) return raw.toLowerCase() as MarketplaceId;

  // 3. Alias table, with and without spaces.
  const spaced = normalizeRegionKey(raw);
  if (REGION_ALIASES[spaced]) return REGION_ALIASES[spaced] as MarketplaceId;

  const tight = aliasKey(raw);
  if (REGION_ALIASES[tight]) return REGION_ALIASES[tight] as MarketplaceId;

  return null;
}

/**
 * Identify the marketplace from a URL or host string.
 *
 * Matching is against an explicit allow-list of hostnames. A host such as
 * `amazon.com.evil.test` does not equal any allowed host, so it is rejected —
 * there is no substring or suffix matching that could be spoofed.
 */
export function marketplaceFromUrl(input: string): MarketplaceId | null {
  if (!input) return null;

  let host = input.trim().toLowerCase();

  // Accept a bare host, or extract the host from a URL.
  if (host.includes('://') || host.includes('/')) {
    try {
      host = new URL(host.includes('://') ? host : `https://${host}`).hostname.toLowerCase();
    } catch {
      return null;
    }
  }

  // Strip a trailing dot ("amazon.co.uk." is a valid FQDN form).
  host = host.replace(/\.$/, '');

  for (const id of MARKETPLACE_IDS) {
    if (MARKETPLACES[id].hosts.includes(host)) return id;
  }
  return null;
}

/**
 * True when a URL points at one of the five supported Amazon hosts.
 *
 * Used to reject pasted links that are either unsupported or unsafe before any
 * navigation happens.
 */
export function isSupportedAmazonUrl(input: string): boolean {
  return marketplaceFromUrl(input) !== null;
}

/**
 * Describe how a marketplace was determined, for auditability.
 *
 * The distinction between "the user told us" and "we confirmed the product
 * exists there" is preserved all the way into the export so a reader can tell a
 * stated region from a verified one.
 */
export type DetectionMethod =
  | 'url'
  | 'column'
  | 'single-marketplace'
  | 'direct-upload'
  | 'auto-detected'
  | 'default'
  | 'unknown';

export type DetectionStatus =
  | 'CONFIRMED_FOUND'
  | 'CONFIRMED_NOT_FOUND'
  | 'ACCESS_RESTRICTED'
  | 'REQUEST_FAILED'
  | 'MULTIPLE_MARKETPLACES'
  | 'PROVIDED'
  | 'NOT_CHECKED'
  | 'UNKNOWN';

export interface MarketplaceResolution {
  /** Resolved marketplace, or `null` when it could not be established. */
  marketplaceId: MarketplaceId | null;
  /** The value the user originally supplied, preserved for traceability. */
  originalInput: string;
  method: DetectionMethod;
  status: DetectionStatus;
}

/**
 * Resolve a marketplace with provenance.
 *
 * Kept separate from `resolveMarketplace` so callers always record *how* they
 * decided, never just the answer.
 */
export function resolveWithProvenance(input: unknown): MarketplaceResolution {
  const originalInput = input === null || input === undefined ? '' : String(input).trim();

  if (!originalInput) {
    return { marketplaceId: null, originalInput: '', method: 'unknown', status: 'UNKNOWN' };
  }

  const looksLikeUrl = /amazon|amzn/i.test(originalInput) && /[./]/.test(originalInput);

  if (looksLikeUrl && marketplaceFromUrl(originalInput)) {
    return {
      marketplaceId: marketplaceFromUrl(originalInput),
      originalInput,
      method: 'url',
      status: 'PROVIDED',
    };
  }

  const resolved = resolveMarketplace(originalInput);
  if (resolved) {
    return { marketplaceId: resolved, originalInput, method: 'column', status: 'PROVIDED' };
  }

  return { marketplaceId: null, originalInput, method: 'unknown', status: 'UNKNOWN' };
}