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
  brand: string | null;
  productUrl: string | null;
  /** Numeric where a reliable number was parsed; null when Amazon stated none. */
  productPrice: number | null;
  /** The price exactly as displayed, beside the numeric value. */
  productPriceText: string | null;
  productRating: string | null;
  reviewCount: string | null;
  productAvailability: string | null;
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

export const EXPORT_COLUMNS: Column[] = [
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
  { key: 'brand', header: 'Brand', width: 18 },
  { key: 'productUrl', header: 'Product URL', width: 40 },
  { key: 'productPrice', header: 'Product Price', width: 14, numeric: true },
  { key: 'productPriceText', header: 'Product Price (as displayed)', width: 22 },
  { key: 'productRating', header: 'Product Rating', width: 14 },
  { key: 'reviewCount', header: 'Review Count', width: 13 },
  { key: 'productAvailability', header: 'Availability', width: 18 },

  { key: 'sellerName', header: 'Seller Name', width: 26 },
  { key: 'sellerId', header: 'Seller ID', width: 16 },
  { key: 'sellerPrice', header: 'Seller Price', width: 13, numeric: true },
  { key: 'shippingCost', header: 'Shipping Cost', width: 14, numeric: true },
  { key: 'totalPrice', header: 'Total Price', width: 13, numeric: true },
  { key: 'sellerRating', header: 'Seller Rating', width: 13, numeric: true },
  { key: 'sellerFeedback', header: 'Seller Feedback', width: 15, numeric: true },
  { key: 'fulfillment', header: 'FBA/FBM', width: 10 },
  { key: 'productCondition', header: 'Product Condition', width: 17 },
  { key: 'stockAvailability', header: 'Stock Availability', width: 18 },
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

/** Build the export rows for one scraped product. */
export function rowsForProduct(product: ProductWithOffers): ExportRow[] {
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
    brand: product.brand,
    productUrl: product.url,
    // Numeric so Excel can sort and sum, with the verbatim string beside it
    // as the proof of what Amazon printed.
    productPrice: product.price,
    productPriceText: product.priceText ?? null,
    productRating: product.rating,
    reviewCount: product.reviewCount,
    productAvailability: product.availability,
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

  return product.offers.map((offer) => rowForOffer(base, offer, product));
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

/** Build the export row for a single seller offer. */
function rowForOffer(
  base: Omit<
    ExportRow,
    | 'sellerName' | 'sellerId' | 'sellerPrice' | 'shippingCost' | 'totalPrice'
    | 'sellerRating' | 'sellerFeedback' | 'fulfillment' | 'productCondition'
    | 'stockAvailability' | 'isBuyBox' | 'estimatedDeliveryDate' | 'earliestDeliveryDate'
    | 'latestDeliveryDate' | 'deliveryDays' | 'deliveryDestination' | 'deliveryText'
    | 'status' | 'statusDetail'
  >,
  offer: SellerOffer,
  product: ProductWithOffers,
): ExportRow {
  const delivery = offer.delivery;

  // `INCOMPLETE` means data was retrieved but Amazon withheld part of the list,
  // which must never be presented as a complete success.
  const status: RowStatus = product.offersComplete ? 'OK' : 'INCOMPLETE';

  return {
    ...base,
    sellerName: offer.sellerName,
    sellerId: offer.sellerId,
    sellerPrice: offer.price,
    shippingCost: offer.shippingFee,
    totalPrice: offer.totalPrice,
    sellerRating: offer.rating,
    sellerFeedback: offer.feedbackCount,
    fulfillment: offer.fulfillment === 'UNKNOWN' ? null : offer.fulfillment,
    productCondition: offer.condition,
    stockAvailability: offer.availability,
    isBuyBox: offer.isBuyBox,
    estimatedDeliveryDate: delivery?.estimatedDate ?? null,
    earliestDeliveryDate: delivery?.earliestDate ?? null,
    latestDeliveryDate: delivery?.latestDate ?? null,
    deliveryDays: delivery?.estimatedDays ?? null,
    deliveryDestination: delivery?.destination ?? product.destination?.label ?? null,
    deliveryText: delivery?.originalText ?? null,
    // Falls back to the offer's own recorded status, so a row with no delivery
    // block says so rather than staying blank for no stated reason.
    deliveryStatus: offer.deliveryStatus ?? delivery?.unavailableReason ?? null,
    status,
    statusDetail: product.offersComplete ? null : product.offersCompletenessNote,
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
    brand: null,
    productUrl: null,
    productPrice: null,
    productPriceText: null,
    productRating: null,
    reviewCount: null,
    productAvailability: null,
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