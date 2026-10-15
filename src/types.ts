/**
 * Shared result shapes returned by the scraper and surfaced through the
 * Scraper Tool API.
 *
 * Design rule that runs through this whole file: **a field Amazon did not
 * display is `null`, never a guess.** The dashboard renders `null` as
 * "Not Available" so a reader can never mistake an absent value for a real one.
 *
 * Second rule, enforced by the types here: **all text is preserved verbatim in
 * whatever language Amazon served.** No field is translated, transliterated or
 * paraphrased anywhere in the pipeline — including fields that would normally
 * be "cleaned" (brand wrappers, price text), which are cleaned of markup only,
 * never of language.
 */

import type { DetectionMethod, DetectionStatus, MarketplaceId } from './marketplaces.js';

/** Provenance of the marketplace attached to a stored record. */
export interface MarketplaceProvenance {
  /** Marketplace this record belongs to. */
  marketplaceId: MarketplaceId;
  /** How the marketplace was established. */
  detectionMethod: DetectionMethod;
  /** Outcome of establishing it. */
  detectionStatus: DetectionStatus;
  /** The raw value supplied by the user, preserved for traceability. */
  originalInput: string | null;
  /** Row number in the uploaded file, when the record came from a batch. */
  sourceRow: number | null;
  /** Uploaded file this record came from, when the record came from a batch. */
  sourceFile: string | null;
}

/** A product as returned by a search results page. */
export interface SearchProduct {
  /** Amazon Standard Identification Number, e.g. `B0CX23V2ZK`. */
  asin: string;
  /**
   * Product title exactly as Amazon rendered it. Never translated: an English
   * title on amazon.eg is stored and exported in English.
   */
  title: string;
  /** Absolute canonical product URL. */
  url: string;
  price: string | null;
  /** Average star rating as displayed, e.g. `4.5 out of 5 stars`. */
  rating: string | null;
  /** Review count as displayed, e.g. `1,234`. */
  reviewCount: string | null;
  image: string | null;
}

/** Full detail scraped from a single product detail page. */
export interface ProductDetail extends Omit<SearchProduct, 'price'> {
  brand: string | null;
  /** `In stock`, `Currently unavailable`, or `null` when not stated. */
  availability: string | null;
  /**
   * Normalised availability, e.g. `CURRENTLY_UNAVAILABLE`.
   *
   * `UNKNOWN` whenever the page does not state one. Never inferred from a
   * missing price or a missing Add to Cart button: those absences have too many
   * causes to mean anything on their own.
   */
  availabilityStatus?: string | null;
  /** Availability text exactly as Amazon printed it. Never translated. */
  availabilityMessage?: string | null;
  /** Dispatch/shipping-provenance text verbatim. NOT an out-of-stock verdict. */
  shippingMessage?: string | null;
  /** Price warnings verbatim. A warning about a price is never the price. */
  priceWarning?: string | null;
  /** Buying-options control text verbatim, when Amazon offered one. */
  buyingOptionsMessage?: string | null;
  /** Every distinct message seen, in page order. Diagnostic column. */
  pageMessages?: string[];
  /** True when a variation must be selected before a price can exist. */
  selectionRequired?: boolean;
  /** Which variation Amazon asked for, e.g. `['Size']`. */
  selectionTypes?: string[];
  /**
   * Why the product price is missing, or `EXTRACTED` when there is one.
   *
   * `null` price plus `NOT_AVAILABLE_IN_SOURCE` is a fact about the source, and
   * is not the same as a zero and not the same as a failed extraction.
   */
  priceStatus?: string | null;
  /** What kind of page Amazon served. See `PageState`. */
  pageState?: string | null;
  /** Why that classification was reached, in words. */
  pageStateReason?: string | null;
  /** Bullet-point feature list, cleaned of markup. */
  features: string[];
  description: string | null;
  /** Marketplace host the detail was read from, e.g. `amazon.eg`. */
  domain: string;
  /** Numeric product price, parsed when unambiguous. Null when not stated. */
  price: number | null;
  /**
   * The price exactly as displayed, e.g. `AED64.64`.
   *
   * Kept beside the numeric value rather than instead of it: the number lets
   * Excel sort and sum, the text proves what Amazon actually printed.
   */
  priceText: string | null;
  /** ISO currency code resolved from the page, e.g. `EGP`. */
  currency: string | null;
  /** How `currency` was established, so an inference is not read as a fact. */
  currencyStatus: string | null;
  /**
   * What localisation did before this price was read.
   *
   * Diagnostic only. It records whether the delivery destination and currency
   * preference were actually applied, so a future price that looks wrong can be
   * traced to a session that never localised rather than to the parser.
   */
  localisationNote?: string;
  /**
   * ASIN the job asked for.
   *
   * Distinct from `asin`, which is the ASIN of the variation that actually
   * rendered. Amazon routinely swaps the URL to a child ASIN once a variation is
   * selected, and overwriting the requested one would silently merge two products.
   */
  requestedAsin?: string | null;
  /** Observed ASIN after any variation selection, when it differs. */
  variationAsin?: string | null;
  /** Selected variation attributes, e.g. `{ Size: 'Large' }`. Only what is displayed. */
  variationAttributes?: Record<string, string> | null;
  /**
   * Why this record's observations do or do not cover every variation.
   *
   * `null` when the page required no variation, so the record speaks for the
   * product. A sentence when selection was required or exploration was partial,
   * so a report never implies coverage it does not have.
   */
  variationNote?: string | null;
  /**
   * Whether every variation this page offered was inspected.
   *
   * `false` whenever exploration stopped at the configured bound, on an
   * unavailable variation, or when Amazon restricted access mid-exploration.
   */
  variationsComplete?: boolean;
  /**
   * Marketplace this product was scraped from. `amazon.eg` + ASIN and
   * `amazon.com` + the same ASIN are distinct records throughout the system.
   */
  marketplaceId: MarketplaceId;
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/**
 * Delivery information for **one specific seller offer**, as displayed for
 * `destination`.
 *
 * The Buy Box delivery estimate is never copied onto other offers: if Amazon
 * showed nothing for a seller, every field here stays `null`.
 */
export interface DeliveryEstimate {
  /** Displayed seller name this estimate belongs to. Used for display only. */
  sellerName: string | null;
  /**
   * Verbatim delivery text exactly as Amazon rendered it (Arabic or English),
   * e.g. `توصيل مجاني غداً، 12 أكتوبر`. Preserved so the UI never has to
   * re-render an approximation of what Amazon actually said.
   */
  originalText: string | null;
  /** ISO date (YYYY-MM-DD) for the headline estimate, when unambiguous. */
  estimatedDate: string | null;
  /** ISO date for the soonest date in a displayed range, when present. */
  earliestDate: string | null;
  /** ISO date for the latest date in a displayed range, when present. */
  latestDate: string | null;
  /**
   * Calendar days from scrape date to `estimatedDate`.
   * `null` unless the date could be resolved with confidence — never a
   * fabricated number derived from a partial date.
   */
  estimatedDays: number | null;
  /** Shipping fee text as displayed, e.g. `26 جنيه` or `FREE`. */
  shippingText: string | null;
  /** Numeric shipping fee in the page currency, when one is shown. `null` for free/undisclosed. */
  shippingFee: number | null;
  /** Where the estimate was computed for. `null` when not explicitly set. */
  destination: string | null;
  /** Destination postal code used for the lookup, when one was applied. */
  destinationPostalCode: string | null;
  /**
   * Why this seller has no parsed dates.
   *
   * 'NOT_SHOWN'      Amazon displayed no delivery estimate for THIS seller.
   * 'UNPARSEABLE'    Text was displayed but did not contain a resolvable date.
   * 'DELIVERY_AT_LOAD' Delivery is stated as "at checkout", not as a date.
   *
   * This distinction matters: "Amazon showed nothing for this seller" and "we
   * failed to read something Amazon did show" are different facts, and a report
   * that collapses them hides real extraction bugs behind a plausible blank.
   */
  unavailableReason: DeliveryUnavailableReason | null;
}

/**
 * Why a per-seller delivery estimate is absent.
 *
 * `null` means an estimate WAS parsed. Anything else is an honest reason, never
 * a fabricated date.
 */
export type DeliveryUnavailableReason =
  | 'NOT_SHOWN'
  | 'UNPARSEABLE'
  | 'DELIVERY_AT_LOAD';

/** A user-selectable delivery destination. */
export interface Destination {
  /** Stable id used by the API and stored in the database. */
  id: string;
  /** English label for the UI. */
  label: string;
  /**
   * ISO 3166-1 alpha-2 code of the country this destination belongs to.
   *
   * This is what stops Cairo being applied to an amazon.ae scrape. A
   * destination may only be used with a marketplace in the same country;
   * otherwise it is ignored rather than silently misapplied.
   */
  countryCode: string;
  /** Label exactly as Amazon renders it in the destination selector. */
  amazonLabel: string;
  /** Postal code, when the marketplace accepts one. */
  postalCode: string | null;
  /**
   * Whether this destination can be set explicitly through Amazon's public
   * UI. Cairo is verified; anything not yet verified must be `false` so the UI
   * never claims a destination that was actually ignored.
   */
  verified: boolean;
}

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------

/** How an order is fulfilled. */
export type Fulfillment = 'FBA' | 'FBM' | 'UNKNOWN';

/** One seller's offer on a product. */
export interface SellerOffer {
  /** Stable id for this offer row within the scrape. */
  id: string;
  /** Displayed seller name, e.g. `The.Value.Store`. Never translated. */
  sellerName: string | null;
  /** Amazon seller id (`A…`) when the seller link exposes it. */
  sellerId: string | null;
  /** Canonical seller profile URL when available. */
  sellerUrl: string | null;
  /** Displayed price text, e.g. `320.50 جنيه`. */
  priceText: string | null;
  /** Numeric price, parsed when unambiguous. */
  price: number | null;
  /** Displayed shipping text, e.g. `26 جنيه` / `مجاني`. */
  shippingText: string | null;
  /** Numeric shipping fee; `0` when Amazon explicitly shows free shipping. */
  shippingFee: number | null;
  /** Displayed shipping fee was explicitly "free". */
  shippingFree: boolean | null;
  /** price + shipping, when both numbers were resolvable. */
  totalPrice: number | null;
  /**
   * Currency code for THIS offer's amounts, resolved per row.
   *
   * Never inherited from a global default. See `currency.ts` for the rules;
   * the short version is that a currency Amazon displayed wins, the
   * marketplace is the fallback, and an unknown marketplace yields null.
   */
  currency: string | null;
  /** How `currency` was established, so an inferred value is not read as a fact. */
  currencyStatus: import('./currency.js').CurrencyStatus | null;
  /**
   * Why this offer has no delivery estimate.
   *
   * Separate from `delivery === null` so "Amazon showed none" is distinguishable
   * from "we could not parse one", and so a Buy Box date is never borrowed to
   * fill a seller's blank.
   */
  deliveryStatus: import('./delivery.js').DeliveryStatus | null;
  /** Seller star rating as displayed, e.g. `4.6 من أصل 5 نجوم`. */
  ratingText: string | null;
  /** Numeric seller rating 0–5, when parseable. */
  rating: number | null;
  /** Seller feedback / rating count, e.g. `315`. */
  feedbackCount: number | null;
  /** Percentage of positive feedback in the trailing window, when displayed. */
  positiveFeedbackPercent: number | null;
  /** `FBA` when Amazon states it fulfils the order, `FBM` for the merchant. */
  fulfillment: Fulfillment;
  /** Product condition text, e.g. `جديد`. */
  condition: string | null;
  /** Stock availability text for this offer. */
  availability: string | null;
  /** True only for the offer Amazon itself designates as the Buy Box winner. */
  isBuyBox: boolean;
  /** Per-seller delivery. `null` when Amazon displayed nothing for this seller. */
  delivery: DeliveryEstimate | null;
  /** Extra offer text that did not map to a known field. */
  notes: string | null;
}

/** Everything a single ASIN scrape produced. */
export interface ProductWithOffers extends ProductDetail {
  /** All offers visible to an anonymous shopper, best-effort. */
  offers: SellerOffer[];
  /**
   * Whether we can prove the offer list is complete. `false` whenever Amazon
   * hid part of the list, paginated it, or we could not find a total count —
   * the dashboard must never imply we saw every seller when we did not.
   */
  offersComplete: boolean;
  /** Human-readable reason `offersComplete` is false. */
  offersCompletenessNote: string | null;
  /** Total offer count as advertised by Amazon, when displayed. */
  offersTotalCount: number | null;
  /** Pages of the offers list actually read. */
  offersPagesFetched: number;
  /**
   * Whether Amazon's buying-options panel was opened for this product.
   *
   * Distinct from `offersComplete`: a product with no offers at all is a
   * different fact from one whose offers Amazon hid.
   */
  buyingOptionsOpened?: boolean;
  /**
   * One record per explored variation.
   *
   * Kept beside the parent rather than merged into it, because merging would
   * attribute one child's sellers and price to another. Each entry carries its
   * own `asin`, `requestedAsin` and `variationAttributes`.
   */
  variationSnapshots?: ProductWithOffers[];
  /** Marketplace host. */
  domain: string;
  /** ISO timestamp of when this snapshot was taken. */
  scrapedAt: string;
  /** The destination the delivery estimates were computed for. */
  destination: Destination | null;
  /** Raw delivery text for the Buy Box, kept separate from per-seller data. */
  buyBoxDeliveryText: string | null;
  /**
   * How this product's marketplace was established. Present on every record so
   * an export reader can distinguish a stated region from a verified one.
   */
  provenance: MarketplaceProvenance | null;
}

/** Result envelope so the UI can distinguish fresh data from a cache hit. */
export interface ScrapeResult<T> {
  data: T;
  /** True when the payload came from the local cache rather than a live fetch. */
  fromCache: boolean;
  /** Age of the cached payload in seconds, when `fromCache` is true. */
  cacheAgeSeconds: number | null;
  /**
   * Set when a live fetch failed but cached data is being shown instead.
   * The reason is surfaced so the UI can be explicit that this is stale.
   */
  staleReason: string | null;
}