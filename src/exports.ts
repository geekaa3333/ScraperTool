import ExcelJS from 'exceljs';
import type { ProductWithOffers, SellerOffer } from './types.js';
import { getMarketplace, getMarketplaceStrict, type MarketplaceId } from './marketplaces.js';
import { resolveCurrency } from './currency.js';

/**
 * Export generation for bulk results.
 *
 * ## One dataset, two formats
 *
 * `buildExportRows()` is the single source of truth. The XLSX writer and the TSV
 * writer both consume its output, so the workbook and the tab-separated file
 * cannot drift apart — the exact records and values appear in both.
 *
 * ## Spreadsheet formula injection
 *
 * Seller and product text is attacker-influenced: a merchant can name a store
 * `=HYPERLINK("http://evil","click")`. Written into a cell verbatim, Excel would
 * evaluate it as a formula. `safeCell()` neutralises any leading `=`, `+`, `-`,
 * `@`, tab or CR by prefixing an apostrophe. Numbers are written as real numeric
 * cells and are never prefixed, so price columns stay sortable and summable.
 */

/** Processing outcome for one ASIN in a batch. */
export type RowStatus = 'OK' | 'NO_OFFERS' | 'FAILED' | 'INCOMPLETE' | 'NOT_FOUND';

export interface ExportRow {
  /**
   * Dynamic seller columns: `otherSeller1Name`, `otherSeller1Price`,
   * `otherSeller2Name`, `otherSeller2Price`, ... up to the largest number of
   * other sellers seen in the batch. Declared here as an index signature so
   * the column count can grow without a fixed upper bound, while the named
   * fields below keep their precise types.
   */
  [sellerColumn: string]: string | number | boolean | null | undefined;
  // --- marketplace provenance (new) ---
  marketplaceId: string;
  /**
   * Nullable on purpose.
   *
   * An unrecognised marketplace leaves these blank rather than being filled
   * from a default. A blank says "not known"; EGP in a UAE row says something
   * false, and this column exists so that can never happen.
   */
  marketplaceDomain: string | null;
  country: string | null;
  regionCode: string | null;
  detectionMethod: string;
  detectionStatus: string;
  /**
   * Human-readable verification outcome, kept separate from the raw status so a
   * reader can see at a glance whether the marketplace was confirmed or merely
   * supplied by the user.
   */
  verificationResult: string;
  originalMarketplaceInput: string | null;
  sourceRow: number | null;
  /** Uploaded file the ASIN was read from. */
  sourceFile: string | null;
  // --- product ---
  asin: string;
  productTitle: string | null;
  /** English title when the marketplace served a different language. */
  productTitleEn: string | null;
  brand: string | null;
  productUrl: string | null;
  /** Absolute URL of the product's main image, when Amazon exposed one. */
  productImageUrl: string | null;
  /** Embedded image marker. The actual image is written into the XLSX cell by
   *  `toWorkbook`; TSV has no image column support and leaves this blank. */
  productImage: string | null;
  /** Numeric where a reliable number was parsed; null when Amazon stated none. */
  productPrice: number | null;
  /** The price exactly as displayed, beside the numeric value. */
  productPriceText: string | null;
  productRating: string | null;
  reviewCount: string | null;
  productAvailability: string | null;
  /**
   * What the page stated, split by kind.
   *
   * These are NOT collapsed into one status. "Currently unavailable" is an
   * availability statement, "dispatched from" is shipping provenance and is not
   * an out-of-stock verdict, "price higher than typical" is a warning ABOUT a
   * price and is not the price, and "see all buying options" is a control that
   * may reveal sellers. Folding them together would turn four different facts
   * into one misleading word.
   */
  availabilityStatus: string | null;
  /** Availability text verbatim. Never translated. */
  availabilityMessage: string | null;
  /** Dispatch/shipping-provenance text verbatim. */
  shippingMessage: string | null;
  /** Price warnings verbatim. Never used as the price. */
  priceWarning: string | null;
  /** Buying-options control text verbatim. */
  buyingOptionsMessage: string | null;
  /** Why the price is absent, or EXTRACTED when present. */
  priceMissingReason: string | null;
  /**
   * Where the price came from, so a reader can judge it without re-scraping.
   *
   * `NONE` means no price was reported. That is a materially different claim
   * from any named source, and the column exists so the two cannot be confused.
   */
  priceSource: string | null;
  /** The selector that produced the price. */
  priceSelector: string | null;
  /** True when the only price on the page was a struck-through list price. */
  priceBasisOnly: boolean | null;
  /** Prices found and refused, each with its reason. */
  priceRejected: string | null;
  /** What kind of page Amazon served. */
  pageStatus: string | null;
  /** Why that classification was reached, in words. */
  pageMessage: string | null;
  /** Internal outcome code. */
  extractionStatus: string | null;
  /** Human-readable explanation for the outcome. */
  extractionNote: string | null;
  /** The ASIN the job asked for. */
  requestedAsin: string | null;
  /** The ASIN that actually rendered, when it differs. */
  variationAsin: string | null;
  variationType: string | null;
  selectedSize: string | null;
  selectedColor: string | null;
  selectedAttributes: string | null;
  /** What variation exploration did and did not cover. */
  variationNote: string | null;
  /** False whenever variation coverage was partial. */
  variationsComplete: boolean | null;
  // --- seller ---
  sellerName: string | null;
  sellerId: string | null;
  sellerPrice: number | null;
  shippingCost: number | null;
  totalPrice: number | null;
  sellerRating: number | null;
  sellerFeedback: number | null;
  fulfillment: string | null;
  productCondition: string | null;
  stockAvailability: string | null;
  isBuyBox: boolean;
  // --- delivery ---
  estimatedDeliveryDate: string | null;
  earliestDeliveryDate: string | null;
  latestDeliveryDate: string | null;
  deliveryDays: number | null;
  deliveryDestination: string | null;
  deliveryText: string | null;
  /**
   * Why this seller's delivery estimate is blank.
   *
   * 'NOT_SHOWN'   Amazon displayed no estimate for THIS seller.
   * 'UNPARSEABLE' Text was displayed but no date could be read — a real gap.
   *
   * Without this, a parsing failure is indistinguishable from an honest blank,
   * and extraction bugs hide behind plausible empty cells.
   */
  deliveryStatus: string | null;
  // --- meta ---
  currency: string | null;
  /** How `currency` was established. An inference is not a fact. */
  currencyStatus: string | null;
  offersCount: number;
  offersComplete: boolean;
  status: RowStatus;
  statusDetail: string | null;
  scrapedAt: string;
}

/**
 * Column definition, in export order. Drives the header, the TSV column order
 * and the XLSX column widths, so adding a column cannot desynchronise formats.
 */
interface Column {
  key: keyof ExportRow;
  header: string;
  width: number;
  /** Write as a numeric cell rather than text. */
  numeric?: boolean;
}

/**
 * The fixed columns, in their canonical order. Seller-related columns are
 * renamed to make the Buy Box seller explicit; the per-product "Other Seller N"
 * columns are appended at runtime by `buildExportColumns()` because their count
 * depends on the whole batch, not on any single product.
 */
const BASE_COLUMNS: Column[] = [
  // Marketplace first, so a mixed export is readable at a glance and can be
  // filtered per market. Prices stay in their original marketplace currency —
  // this tool never converts currencies.
  { key: 'marketplaceId', header: 'Marketplace', width: 15 },
  { key: 'marketplaceDomain', header: 'Marketplace Domain', width: 20 },
  { key: 'country', header: 'Country', width: 20 },
  { key: 'regionCode', header: 'Region Code', width: 12 },
  { key: 'currency', header: 'Currency', width: 10 },
  { key: 'detectionMethod', header: 'Marketplace Detection Method', width: 26 },
  { key: 'detectionStatus', header: 'Marketplace Detection Status', width: 26 },
  { key: 'originalMarketplaceInput', header: 'Original Marketplace Input', width: 24 },
  { key: 'verificationResult', header: 'Marketplace Verification', width: 26 },

  { key: 'asin', header: 'ASIN', width: 14 },
  { key: 'productTitle', header: 'Product Title', width: 46 },
  { key: 'productTitleEn', header: 'Product Title (English)', width: 46 },
  { key: 'brand', header: 'Brand', width: 18 },
  { key: 'productUrl', header: 'Product URL', width: 40 },
  { key: 'productImageUrl', header: 'Product Image URL', width: 46 },
  { key: 'productImage', header: 'Product Image', width: 16 },
  { key: 'productPrice', header: 'Product Price', width: 14, numeric: true },
  { key: 'productPriceText', header: 'Product Price (as displayed)', width: 22 },
  { key: 'productRating', header: 'Product Rating', width: 14 },
  { key: 'reviewCount', header: 'Review Count', width: 13 },
  // What the page actually said. Kept beside the normalised status so a reader
  // can check the classification against Amazon's own words instead of trusting
  // it. Never translated: Arabic stays Arabic.
  { key: 'productAvailability', header: 'Availability', width: 18 },
  { key: 'availabilityStatus', header: 'Availability Status', width: 22 },
  { key: 'availabilityMessage', header: 'Availability Message', width: 40 },
  { key: 'shippingMessage', header: 'Shipping / Dispatch Message', width: 44 },
  { key: 'priceWarning', header: 'Price Warning', width: 34 },
  { key: 'buyingOptionsMessage', header: 'Buying Options Status', width: 28 },
  { key: 'priceMissingReason', header: 'Price Missing Reason', width: 24 },
  { key: 'priceSource', header: 'Price Source', width: 16 },
  { key: 'priceSelector', header: 'Price Selector', width: 44 },
  { key: 'priceBasisOnly', header: 'List Price Only', width: 15 },
  { key: 'priceRejected', header: 'Prices Rejected (and why)', width: 52 },
  { key: 'pageStatus', header: 'Page Status', width: 20 },
  { key: 'pageMessage', header: 'Page Message', width: 46 },
  { key: 'extractionStatus', header: 'Extraction Status', width: 22 },
  { key: 'extractionNote', header: 'Extraction Note', width: 46 },

  // Variation identity. Requested and observed ASIN are separate columns so a
  // child's price is never read as the parent's.
  { key: 'requestedAsin', header: 'Requested ASIN', width: 15 },
  { key: 'variationAsin', header: 'Selected / Observed ASIN', width: 20 },
  { key: 'variationType', header: 'Variation Type', width: 15 },
  { key: 'selectedSize', header: 'Selected Size', width: 15 },
  { key: 'selectedColor', header: 'Selected Color', width: 15 },
  { key: 'selectedAttributes', header: 'Other Selected Attributes', width: 26 },
  { key: 'variationNote', header: 'Variation Note', width: 38 },
  { key: 'variationsComplete', header: 'Variations Complete', width: 18 },

  { key: 'sellerId', header: 'Seller ID (Buy Box)', width: 16 },
  { key: 'shippingCost', header: 'Shipping Cost (Buy Box)', width: 14, numeric: true },
  { key: 'totalPrice', header: 'Total Price (Buy Box)', width: 13, numeric: true },
  { key: 'sellerRating', header: 'Seller Rating (Buy Box)', width: 13, numeric: true },
  { key: 'sellerFeedback', header: 'Seller Feedback (Buy Box)', width: 15, numeric: true },
  { key: 'fulfillment', header: 'FBA/FBM (Buy Box)', width: 10 },
  { key: 'productCondition', header: 'Product Condition (Buy Box)', width: 17 },
  { key: 'stockAvailability', header: 'Stock Availability (Buy Box)', width: 18 },
  { key: 'isBuyBox', header: 'Buy Box', width: 10 },

  { key: 'estimatedDeliveryDate', header: 'Estimated Delivery Date', width: 22 },
  { key: 'earliestDeliveryDate', header: 'Earliest Delivery Date', width: 21 },
  { key: 'latestDeliveryDate', header: 'Latest Delivery Date', width: 21 },
  { key: 'deliveryDays', header: 'Delivery Days', width: 14, numeric: true },
  { key: 'deliveryDestination', header: 'Delivery Destination', width: 20 },
  { key: 'deliveryText', header: 'Delivery Text (original)', width: 52 },
  { key: 'deliveryStatus', header: 'Delivery Status', width: 17 },
  { key: 'currencyStatus', header: 'Currency Verified By', width: 22 },

  { key: 'sourceRow', header: 'Source Excel Row', width: 15, numeric: true },
  { key: 'sourceFile', header: 'Source File', width: 22 },
  { key: 'offersCount', header: 'Offers Found', width: 13, numeric: true },
  { key: 'offersComplete', header: 'Offers Complete', width: 15 },
  { key: 'status', header: 'Status', width: 14 },
  { key: 'statusDetail', header: 'Status Detail', width: 44 },
  { key: 'scrapedAt', header: 'Retrieved At (UTC)', width: 22 },
];

/**
 * The live column set. Grows to fit the widest batch seen so far; reset with
 * `resetExportColumns()` at the start of a new export run if you want it to
 * reflect only that run.
 */
export let EXPORT_COLUMNS: Column[] = [...BASE_COLUMNS];

/**
 * Neutralise spreadsheet formula injection.
 *
 * A leading `=`, `+`, `-`, `@`, tab or carriage return makes Excel treat the
 * cell as a formula. Prefixing a single quote forces text. Empty stays empty so
 * "Not Available" semantics are preserved by the caller's null handling.
 */
export function safeCell(value: string): string {
  if (value.length === 0) return value;
  const first = value[0] as string;
  if (first === '=' || first === '+' || first === '-' || first === '@' || first === '\t' || first === '\r') {
    return `'${value}`;
  }
  return value;
}

/** Collapse whitespace so a TSV cell can never span rows or columns. */
function flatten(value: string): string {
  return value.replace(/[\t\r\n]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

/** Blank cells are written as empty, which Excel and Sheets both read as blank. */
function textOrBlank(value: string | null): string {
  return value === null || value === undefined ? '' : flatten(String(value));
}

/**
 * Reset the live column set to the base columns, dropping any "Other Seller N"
 * columns added by a previous run. Call this between independent export runs
 * (or in tests) so a smaller batch does not inherit a wider column set.
 */
export function resetExportColumns(): void {
  EXPORT_COLUMNS = [...BASE_COLUMNS];
}

/**
 * Ensure the live column set has room for at least `maxOther` other sellers,
 * appending `Other Seller N` / `Other Seller N Price` pairs as needed. Only
 * grows; never shrinks or reorders existing columns.
 */
let currentMaxOther = 0;

function rebuildExportColumns(maxOther: number): void {
  currentMaxOther = Math.max(currentMaxOther, maxOther);
  const sellerBlock: Column[] = [
    { key: 'sellerName', header: 'Seller Name (Buy Box)', width: 26 },
    { key: 'sellerPrice', header: 'Seller Price (Buy Box)', width: 13, numeric: true },
  ];
  for (let n = 1; n <= currentMaxOther; n += 1) {
    sellerBlock.push({ key: `otherSeller${n}Name`, header: `Other Seller ${n}`, width: 26 });
    sellerBlock.push({ key: `otherSeller${n}Price`, header: `Other Seller ${n} Price`, width: 14, numeric: true });
  }
  EXPORT_COLUMNS = [...sellerBlock, ...BASE_COLUMNS];
}

/**
 * Count other (non-Buy Box) sellers for a product, in Amazon's original order.
 */
function otherSellers(product: ProductWithOffers): SellerOffer[] {
  return product.offers.filter((offer) => !offer.isBuyBox);
}

/**
 * The Buy Box seller, if Amazon designated one. Never inferred from price.
 */
function buyBoxSeller(product: ProductWithOffers): SellerOffer | null {
  return product.offers.find((offer) => offer.isBuyBox) ?? null;
}

/**
 * Build export rows for a batch of products.
 *
 * One row per product. The Buy Box seller lands in the dedicated Buy Box
 * columns; every other seller keeps Amazon's listing order in the
 * `Other Seller N` / `Other Seller N Price` columns. The column set grows to
 * fit the widest batch, so a product with fewer sellers simply leaves the
 * trailing cells blank.
 */
export function buildExportRows(products: ProductWithOffers[]): ExportRow[] {
  resetExportColumns();
  const maxOther = products.reduce((acc, p) => Math.max(acc, otherSellers(p).length), 0);
  rebuildExportColumns(maxOther);

  return products.map((product) => {
    const built = rowsForProduct(product, maxOther);
    // rowsForProduct always emits exactly one row per product.
    return built[0] as ExportRow;
  });
}

/** Build the export rows for one scraped product. */
export function rowsForProduct(product: ProductWithOffers, maxOtherSellers?: number): ExportRow[] {
  // STRICT lookup, deliberately. `getMarketplace` falls back to amazon.eg, which
  // would relabel an unrecognised marketplace's prices as EGP — the exact bug
  // this replaced. An unknown marketplace leaves the currency blank and marked
  // unverified instead of asserting a wrong one.
  const marketplace = getMarketplaceStrict(product.marketplaceId);

  const base = {
    // Left as the raw id rather than a substituted default, so an unknown
    // marketplace stays visible as its own value instead of masquerading as EG.
    marketplaceId: product.marketplaceId,
    marketplaceDomain: marketplace?.domain ?? null,
    country: marketplace?.country ?? null,
    regionCode: marketplace?.countryCode ?? null,
    // Verbatim, exactly as Amazon rendered it — never translated.
    asin: product.asin,
    productTitle: product.title,
    productTitleEn: product.titleEn ?? null,
    brand: product.brand,
    productUrl: product.url,
    productImageUrl: product.image ?? null,
    productImage: null,
    // Numeric so Excel can sort and sum, with the verbatim string beside it
    // as the proof of what Amazon printed.
    productPrice: product.price,
    productPriceText: product.priceText ?? null,
    productRating: product.rating,
    reviewCount: product.reviewCount,
    productAvailability: product.availability,
    ...pageMessageFields(product),
    ...variationFields(product),
    // Per-row, resolved by `resolveCurrency`: never a global default. An
    // unknown marketplace yields null rather than silently becoming EGP.
    currency: resolveCurrency(product.marketplaceId, product.currency, marketplace).code,
    currencyStatus: resolveCurrency(product.marketplaceId, product.currency, marketplace).status,
    offersCount: product.offers.length,
    offersComplete: product.offersComplete,
    scrapedAt: product.scrapedAt,
    detectionMethod: product.provenance?.detectionMethod ?? 'single-marketplace',
    detectionStatus: product.provenance?.detectionStatus ?? 'PROVIDED',
    verificationResult: describeVerification(
      product.provenance?.detectionStatus ?? 'PROVIDED',
      product.provenance?.detectionMethod ?? 'single-marketplace',
    ),
    originalMarketplaceInput: product.provenance?.originalInput ?? null,
    sourceRow: product.provenance?.sourceRow ?? null,
    sourceFile: product.provenance?.sourceFile ?? null,
    // Set per offer; declared here so the shared base type is complete.
    deliveryStatus: null,
  };

  // Grow the column set to fit this product's sellers, even when called
  // directly (single-product exports, tests). buildExportRows() does this for
  // the whole batch first, so the common path is a no-op here.
  const others = otherSellers(product);
  const maxOther = maxOtherSellers ?? others.length;
  rebuildExportColumns(maxOther);

  const bb = buyBoxSeller(product);

  // A product with no offers still gets a row, so the ASIN is never silently
  // dropped from the export and the reason stays visible.
  if (product.offers.length === 0) {
    return [
      {
        ...base,
        sellerName: null,
        sellerId: null,
        sellerPrice: null,
        shippingCost: null,
        totalPrice: null,
        sellerRating: null,
        sellerFeedback: null,
        fulfillment: null,
        productCondition: null,
        stockAvailability: null,
        isBuyBox: false,
        estimatedDeliveryDate: null,
        earliestDeliveryDate: null,
        latestDeliveryDate: null,
        deliveryDays: null,
        deliveryDestination: product.destination?.label ?? null,
        deliveryText: null,
        deliveryStatus: 'NO_OFFERS',
        status: 'NO_OFFERS' as RowStatus,
        statusDetail:
          product.offersCompletenessNote ??
          'No publicly accessible seller offers were found for this ASIN.',
      },
    ];
  }

  // One row per product. Buy Box seller in the dedicated columns; every other
  // seller keeps Amazon's listing order in the Other Seller N / Price columns.
  const row: ExportRow = {
    ...base,
    // Buy Box seller (or the first offer when Amazon designated none).
    sellerName: (bb ?? product.offers[0]!).sellerName,
    sellerId: (bb ?? product.offers[0]!).sellerId,
    sellerPrice: (bb ?? product.offers[0]!).price,
    shippingCost: (bb ?? product.offers[0]!).shippingFee,
    totalPrice: (bb ?? product.offers[0]!).totalPrice,
    sellerRating: (bb ?? product.offers[0]!).rating,
    sellerFeedback: (bb ?? product.offers[0]!).feedbackCount,
    fulfillment: (bb ?? product.offers[0]!).fulfillment === 'UNKNOWN' ? null : (bb ?? product.offers[0]!).fulfillment,
    productCondition: (bb ?? product.offers[0]!).condition,
    stockAvailability: (bb ?? product.offers[0]!).availability,
    isBuyBox: bb !== null,
    estimatedDeliveryDate: (bb ?? product.offers[0]!).delivery?.estimatedDate ?? null,
    earliestDeliveryDate: (bb ?? product.offers[0]!).delivery?.earliestDate ?? null,
    latestDeliveryDate: (bb ?? product.offers[0]!).delivery?.latestDate ?? null,
    deliveryDays: (bb ?? product.offers[0]!).delivery?.estimatedDays ?? null,
    deliveryDestination: (bb ?? product.offers[0]!).delivery?.destination ?? product.destination?.label ?? null,
    deliveryText: (bb ?? product.offers[0]!).delivery?.originalText ?? null,
    deliveryStatus: (bb ?? product.offers[0]!).deliveryStatus ?? (bb ?? product.offers[0]!).delivery?.unavailableReason ?? null,
    status: product.offersComplete ? 'OK' : 'INCOMPLETE',
    statusDetail: product.offersComplete ? null : product.offersCompletenessNote,
  };

  // Other sellers, in Amazon's original order, excluding the Buy Box seller.
  others.forEach((offer, index) => {
    const n = index + 1;
    row[`otherSeller${n}Name`] = offer.sellerName;
    row[`otherSeller${n}Price`] = offer.price;
  });

  return [row];
}

/** Describe how strongly the marketplace was established, in plain words. */
function describeVerification(status: string, method: string): string {
  switch (status) {
    case 'CONFIRMED_FOUND':
      return 'Verified: product page confirmed';
    case 'CONFIRMED_NOT_FOUND':
      return 'Verified: not available here';
    case 'MULTIPLE_MARKETPLACES':
      return 'Found in several marketplaces';
    case 'ACCESS_RESTRICTED':
      return 'Unverified: access restricted';
    case 'REQUEST_FAILED':
      return 'Unverified: request failed';
    case 'NOT_CHECKED':
      return 'Unverified: detection not run';
    case 'UNKNOWN':
      return 'Unverified: no marketplace determined';
    case 'PROVIDED':
    default:
      return `Supplied by user (${method}) — not independently verified`;
  }
}


/**
 * Page-message columns for one product record.
 *
 * `pageStatus` and `extractionStatus` are kept separate on purpose: one
 * describes what Amazon served, the other what we did about it. A page can be
 * an Amazon error page (pageStatus) that we nonetheless extracted cleanly from
 * (extractionStatus EXTRACTED), and collapsing them loses that.
 */
function pageMessageFields(product: {
  availabilityStatus?: string | null;
  availabilityMessage?: string | null;
  shippingMessage?: string | null;
  priceWarning?: string | null;
  buyingOptionsMessage?: string | null;
  priceStatus?: string | null;
  priceSource?: string | null;
  priceSelector?: string | null;
  priceBasisPriceOnly?: boolean | null;
  priceRejected?: string[] | null;
  pageState?: string | null;
  pageStateReason?: string | null;
  offersComplete?: boolean;
  offersCompletenessNote?: string | null;
}) {
  return {
    availabilityStatus: product.availabilityStatus ?? 'UNKNOWN',
    availabilityMessage: product.availabilityMessage ?? null,
    shippingMessage: product.shippingMessage ?? null,
    priceWarning: product.priceWarning ?? null,
    buyingOptionsMessage: product.buyingOptionsMessage ?? null,
    priceMissingReason: product.priceStatus ?? null,
    priceSource: product.priceSource ?? 'NONE',
    priceSelector: product.priceSelector ?? null,
    priceBasisOnly: product.priceBasisPriceOnly ?? null,
    priceRejected:
      Array.isArray(product.priceRejected) && product.priceRejected.length > 0
        ? product.priceRejected.join(' | ')
        : null,
    pageStatus: product.pageState ?? 'UNKNOWN',
    pageMessage: product.pageStateReason ?? null,
    // A product that produced a price or a real availability answer is an
    // EXTRACTION, even with no price. Only a genuine failure is a failure.
    extractionStatus: product.pageState === 'PRODUCT' ? 'EXTRACTED' : (product.pageState ?? 'UNKNOWN'),
    extractionNote: product.pageStateReason ?? product.offersCompletenessNote ?? null,
  };
}

/** Variation columns for one product record. */
function variationFields(product: {
  requestedAsin?: string | null;
  asin?: string;
  variationAsin?: string | null;
  variationAttributes?: Record<string, string> | null;
  variationNote?: string | null;
  variationsComplete?: boolean | null;
}) {
  const attributes = product.variationAttributes ?? {};
  const others = Object.entries(attributes)
    .filter(([key]) => key !== 'Size' && key !== 'Color')
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');

  return {
    requestedAsin: product.requestedAsin ?? product.asin ?? null,
    variationAsin: product.variationAsin ?? null,
    variationType: Object.keys(attributes).join(', ') || null,
    selectedSize: attributes.Size ?? null,
    selectedColor: attributes.Color ?? null,
    selectedAttributes: others.length > 0 ? others : null,
    variationNote: product.variationNote ?? null,
    // Stays null when never collected, so a pre-existing row is not retroactively
    // claimed as fully explored.
    variationsComplete: product.variationsComplete ?? null,
  };
}

/**
 * A row recording that one (marketplace, ASIN) pair yielded no scrape.
 *
 * The marketplace is carried through so a failure in one market is still a
 * distinct record from a failure of the same ASIN elsewhere.
 *
 * `detectionStatus` matters for correctness, not cosmetics. An ASIN that Amazon
 * confirmed is **not sold** in a marketplace gets `NOT_FOUND` and is explicitly
 * reported as a verified absence. An ASIN we merely failed to fetch is `FAILED`
 * and reported as unverified. Collapsing the two would turn a checked negative
 * into an unexplained failure — or, worse, imply a product exists when we never
 * confirmed that.
 */
export function failedRow(
  marketplaceId: MarketplaceId,
  asin: string,
  detail: string,
  status: RowStatus = 'FAILED',
  detectionMethod = 'unknown',
  detectionStatus = 'UNKNOWN',
): ExportRow {
  const marketplace = getMarketplace(marketplaceId);
  const method = detectionStatus === 'CONFIRMED_NOT_FOUND' ? 'auto-detected' : detectionMethod;
  const status2 = status === 'NOT_FOUND' ? 'CONFIRMED_NOT_FOUND' : detectionStatus;

  return {
    marketplaceId: marketplace.id,
    marketplaceDomain: marketplace.domain,
    country: marketplace.country,
    regionCode: marketplace.countryCode,
    detectionMethod: method,
    detectionStatus: status2,
    verificationResult: describeVerification(status2, method),
    originalMarketplaceInput: null,
    sourceRow: null,
    sourceFile: null,
    asin,
    productTitle: null,
    productTitleEn: null,
    brand: null,
    productUrl: null,
    productImageUrl: null,
    productImage: null,
    productPrice: null,
    productPriceText: null,
    productRating: null,
    reviewCount: null,
    productAvailability: null,
    // No page was read, so nothing about it is claimed. The failure reason goes
    // in the note rather than being presented as a page observation.
    availabilityStatus: 'UNKNOWN',
    availabilityMessage: null,
    shippingMessage: null,
    priceWarning: null,
    buyingOptionsMessage: null,
    priceMissingReason: null,
    // No page was read, so no price has a source.
    priceSource: 'NONE',
    priceSelector: null,
    priceBasisOnly: null,
    priceRejected: null,
    pageStatus: status === 'NOT_FOUND' ? 'NOT_FOUND' : 'UNKNOWN',
    pageMessage: null,
    extractionStatus: status,
    extractionNote: detail,
    requestedAsin: asin,
    variationAsin: null,
    variationType: null,
    selectedSize: null,
    selectedColor: null,
    selectedAttributes: null,
    variationNote: null,
    variationsComplete: null,
    sellerName: null,
    sellerId: null,
    sellerPrice: null,
    shippingCost: null,
    totalPrice: null,
    sellerRating: null,
    sellerFeedback: null,
    fulfillment: null,
    productCondition: null,
    stockAvailability: null,
    isBuyBox: false,
    estimatedDeliveryDate: null,
    earliestDeliveryDate: null,
    latestDeliveryDate: null,
    deliveryDays: null,
    deliveryDestination: null,
    deliveryText: null,
    deliveryStatus: null,
    currency: marketplace.currency,
    currencyStatus: null,
    offersCount: 0,
    offersComplete: false,
    status,
    statusDetail: detail,
    scrapedAt: new Date().toISOString(),
  };
}

/** Serialise rows to tab-separated text. */
export function toTsv(rows: Iterable<ExportRow>): string {
  const header = EXPORT_COLUMNS.map((column) => column.header).join('\t');
  const body: string[] = [];
  for (const row of rows) body.push(tsvLine(row));
  return [header, ...body].join('\n');
}

/**
 * Stream TSV straight to a writable stream.
 *
 * Used for large batches: rows are formatted and flushed as they are produced
 * instead of being accumulated into one string.
 */
export function writeTsvStream(
  rows: Iterable<ExportRow>,
  write: (chunk: string) => void,
): number {
  write(`${EXPORT_COLUMNS.map((column) => column.header).join('\t')}\n`);
  let count = 0;
  // Flush in batches so a 10k-ASIN export does not issue tens of thousands of
  // tiny writes.
  let buffer: string[] = [];
  for (const row of rows) {
    buffer.push(`${tsvLine(row)}\n`);
    count += 1;
    if (buffer.length >= 500) {
      write(buffer.join(''));
      buffer = [];
    }
  }
  if (buffer.length > 0) write(buffer.join(''));
  return count;
}

/** Format one row as a tab-separated line. */
function tsvLine(row: ExportRow): string {
  return EXPORT_COLUMNS.map((column) => {
    const value = row[column.key as keyof ExportRow];
    if (value === null || value === undefined) return '';
    if (typeof value === 'boolean') return value ? 'YES' : 'NO';
    return textOrBlank(safeCell(String(value)));
  }).join('\t');
}

/**
 * Build the single-workbook Excel file containing every seller row.
 *
 * Accepts any iterable of rows, so a large batch can be streamed in rather
 * than materialised. Row count is tracked for the worksheet's autofilter range.
 */
export async function toWorkbook(rows: Iterable<ExportRow>): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Scraper Tool';
  workbook.created = new Date();

  // One worksheet for everything, as required — never one sheet per product.
  const sheet = workbook.addWorksheet('All Seller Results', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  sheet.columns = EXPORT_COLUMNS.map((column) => ({
    header: column.header,
    key: String(column.key),
    width: column.width,
  }));

  // Style the shared header row.
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
  headerRow.height = 22;

  let rowCount = 0;
  for (const row of rows) {
    rowCount += 1;
    sheet.addRow(
      Object.fromEntries(
        EXPORT_COLUMNS.map((column) => {
          const value = (row as unknown as Record<string, unknown>)[column.key as string];
          // Numbers go in as native numeric cells so Excel can sort and sum.
          if (typeof value === 'number') return [String(column.key), value];
          // Booleans are rendered as YES/NO in BOTH formats so the XLSX and the
          // TSV carry identical values.
          if (typeof value === 'boolean') return [String(column.key), value ? 'YES' : 'NO'];
          if (value === null || value === undefined) return [String(column.key), ''];
          // Text is flattened for alignment and then formula-sanitised.
          return [String(column.key), safeCell(flatten(String(value)))];
        }),
      ),
    );
  }

  // Best-effort embedded thumbnails. Downloaded with a short timeout and a
  // small concurrency cap; a broken or unreachable URL simply leaves the
  // "Product Image" cell blank — the URL column still carries the link.
  const imageColumnIndex = EXPORT_COLUMNS.findIndex((column) => column.key === 'productImage');
  const imageUrlColumnIndex = EXPORT_COLUMNS.findIndex((column) => column.key === 'productImageUrl');
  if (imageColumnIndex >= 0 && imageUrlColumnIndex >= 0 && rowCount > 0) {
    const imageCol = imageColumnIndex + 1; // 1-based for ExcelJS
    const urlCol = imageUrlColumnIndex + 1;
    const tasks: Promise<void>[] = [];
    for (let r = 2; r <= rowCount + 1; r += 1) {
      const row = sheet.getRow(r);
      const url = String(row.getCell(urlCol).value ?? '').trim();
      if (!url) continue;
      const rowIndex = r;
      tasks.push((async () => {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 8000);
          const response = await fetch(url, { signal: controller.signal });
          clearTimeout(timer);
          if (!response.ok) return;
          const buffer = Buffer.from(await response.arrayBuffer()) as any;
          if (buffer.length === 0 || buffer.length > 4_000_000) return;
          const extension = (response.headers.get('content-type') ?? '').toLowerCase().includes('png')
            ? 'png'
            : 'jpeg';
          const imageId = workbook.addImage({ buffer, extension });
          sheet.addImage(imageId, {
            tl: { col: imageCol - 1, row: rowIndex - 1 },
            ext: { width: 64, height: 64 },
          });
          sheet.getRow(rowIndex).height = 52;
        } catch {
          // Skip unreachable/broken images; the URL column still carries the link.
        }
      })());
    }
    // Cap concurrency so a large batch does not open hundreds of sockets.
    const concurrency = 6;
    for (let i = 0; i < tasks.length; i += concurrency) {
      await Promise.all(tasks.slice(i, i + concurrency));
    }
  }

  // Filters across the whole header, so the reader can slice by any column.
  if (rowCount > 0) {
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: rowCount + 1, column: EXPORT_COLUMNS.length },
    };
  }

  // Numeric formatting for money, rating and day columns.
  for (const column of EXPORT_COLUMNS) {
    if (!column.numeric) continue;
    sheet.getColumn(String(column.key)).numFmt = '#,##0.00';
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}