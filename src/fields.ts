/**
 * Central registry of every field the scraper can produce.
 *
 * Used by:
 *  - the frontend (to render the "Select Data to Scrape" checklist)
 *  - the backend (to decide which extraction operations are necessary)
 *  - the export layer (to emit only the selected columns)
 *
 * `requires` declares which expensive operations a field needs, so the scraper
 * can skip whole page loads when none of the selected fields need them.
 */

export interface FieldDef {
  /** Stable machine id, used in API payloads and localStorage. */
  id: string;
  /** Human-readable label shown in the UI. */
  label: string;
  /** Logical group for the checklist. */
  group: string;
  /** Export column header. */
  header: string;
  /** Export column width. */
  width: number;
  /** Whether the column is numeric in Excel. */
  numeric?: boolean;
  /** Needs the Amazon offers (AOD) page. */
  requiresOffersPage?: boolean;
  /** Needs Buy Box seller extraction from the product page. */
  requiresBuyBox?: boolean;
  /** Needs the English-title fetch (SerpApi). */
  requiresEnglishTitle?: boolean;
  /** ExportRow key this field maps to (when it maps to one). */
  rowKey?: string;
}

export const FIELD_GROUPS = [
  'Basic',
  'Pricing',
  'Ratings & Reviews',
  'Availability',
  'Buy Box Seller',
  'Other Sellers',
  'Delivery',
  'Variation',
  'Marketplace & Meta',
] as const;

export const FIELDS: FieldDef[] = [
  // ---- Basic ----
  { id: 'asin', label: 'ASIN', group: 'Basic', header: 'ASIN', width: 14, rowKey: 'asin' },
  { id: 'title', label: 'Product Title', group: 'Basic', header: 'Product Title', width: 46, rowKey: 'productTitle' },
  { id: 'titleEn', label: 'Product Title (English)', group: 'Basic', header: 'Product Title (English)', width: 46, rowKey: 'productTitleEn', requiresEnglishTitle: true },
  { id: 'image', label: 'Product Image URL', group: 'Basic', header: 'Product Image URL', width: 46, rowKey: 'productImageUrl' },
  { id: 'imageEmbedded', label: 'Product Image (embedded)', group: 'Basic', header: 'Product Image', width: 16, rowKey: 'productImage' },
  { id: 'url', label: 'Product URL', group: 'Basic', header: 'Product URL', width: 40, rowKey: 'productUrl' },
  { id: 'brand', label: 'Brand', group: 'Basic', header: 'Brand', width: 18, rowKey: 'brand' },

  // ---- Pricing ----
  { id: 'price', label: 'Product Price', group: 'Pricing', header: 'Product Price', width: 14, numeric: true, rowKey: 'productPrice' },
  { id: 'priceText', label: 'Product Price (as displayed)', group: 'Pricing', header: 'Product Price (as displayed)', width: 22, rowKey: 'productPriceText' },
  { id: 'currency', label: 'Currency', group: 'Pricing', header: 'Currency', width: 10, rowKey: 'currency' },
  { id: 'priceSource', label: 'Price Source', group: 'Pricing', header: 'Price Source', width: 16, rowKey: 'priceSource' },
  { id: 'priceMissingReason', label: 'Price Missing Reason', group: 'Pricing', header: 'Price Missing Reason', width: 24, rowKey: 'priceMissingReason' },

  // ---- Ratings & Reviews ----
  { id: 'rating', label: 'Rating', group: 'Ratings & Reviews', header: 'Product Rating', width: 14, rowKey: 'productRating' },
  { id: 'reviewCount', label: 'Review Count', group: 'Ratings & Reviews', header: 'Review Count', width: 13, rowKey: 'reviewCount' },

  // ---- Availability ----
  { id: 'availability', label: 'Availability', group: 'Availability', header: 'Availability', width: 18, rowKey: 'productAvailability' },
  { id: 'availabilityStatus', label: 'Availability Status', group: 'Availability', header: 'Availability Status', width: 22, rowKey: 'availabilityStatus' },
  { id: 'availabilityMessage', label: 'Availability Message', group: 'Availability', header: 'Availability Message', width: 40, rowKey: 'availabilityMessage' },
  { id: 'shippingMessage', label: 'Shipping / Dispatch Message', group: 'Availability', header: 'Shipping / Dispatch Message', width: 44, rowKey: 'shippingMessage' },
  { id: 'priceWarning', label: 'Price Warning', group: 'Availability', header: 'Price Warning', width: 34, rowKey: 'priceWarning' },
  { id: 'buyingOptionsMessage', label: 'Buying Options Status', group: 'Availability', header: 'Buying Options Status', width: 28, rowKey: 'buyingOptionsMessage' },

  // ---- Buy Box Seller ----
  { id: 'buyBoxSellerName', label: 'Buy Box Seller Name', group: 'Buy Box Seller', header: 'Seller Name (Buy Box)', width: 26, rowKey: 'sellerName', requiresBuyBox: true },
  { id: 'buyBoxSellerPrice', label: 'Buy Box Seller Price', group: 'Buy Box Seller', header: 'Seller Price (Buy Box)', width: 13, numeric: true, rowKey: 'sellerPrice', requiresBuyBox: true },
  { id: 'buyBoxSellerId', label: 'Buy Box Seller ID', group: 'Buy Box Seller', header: 'Seller ID (Buy Box)', width: 16, rowKey: 'sellerId', requiresBuyBox: true },
  { id: 'buyBoxShipping', label: 'Buy Box Shipping Cost', group: 'Buy Box Seller', header: 'Shipping Cost (Buy Box)', width: 14, numeric: true, rowKey: 'shippingCost', requiresBuyBox: true },
  { id: 'buyBoxTotal', label: 'Buy Box Total Price', group: 'Buy Box Seller', header: 'Total Price (Buy Box)', width: 13, numeric: true, rowKey: 'totalPrice', requiresBuyBox: true },
  { id: 'buyBoxRating', label: 'Buy Box Seller Rating', group: 'Buy Box Seller', header: 'Seller Rating (Buy Box)', width: 13, numeric: true, rowKey: 'sellerRating', requiresBuyBox: true },
  { id: 'buyBoxFeedback', label: 'Buy Box Seller Feedback', group: 'Buy Box Seller', header: 'Seller Feedback (Buy Box)', width: 15, numeric: true, rowKey: 'sellerFeedback', requiresBuyBox: true },
  { id: 'buyBoxFulfillment', label: 'Buy Box Fulfillment (FBA/FBM)', group: 'Buy Box Seller', header: 'FBA/FBM (Buy Box)', width: 10, rowKey: 'fulfillment', requiresBuyBox: true },
  { id: 'buyBoxCondition', label: 'Buy Box Product Condition', group: 'Buy Box Seller', header: 'Product Condition (Buy Box)', width: 17, rowKey: 'productCondition', requiresBuyBox: true },
  { id: 'buyBoxStock', label: 'Buy Box Stock Availability', group: 'Buy Box Seller', header: 'Stock Availability (Buy Box)', width: 18, rowKey: 'stockAvailability', requiresBuyBox: true },
  { id: 'isBuyBox', label: 'Buy Box (YES/NO)', group: 'Buy Box Seller', header: 'Buy Box', width: 10, rowKey: 'isBuyBox', requiresBuyBox: true },

  // ---- Other Sellers ----
  { id: 'otherSellers', label: 'Other Sellers (all)', group: 'Other Sellers', header: 'Other Sellers', width: 26, requiresOffersPage: true },

  // ---- Delivery ----
  { id: 'deliveryDate', label: 'Estimated Delivery Date', group: 'Delivery', header: 'Estimated Delivery Date', width: 22, rowKey: 'estimatedDeliveryDate' },
  { id: 'deliveryDays', label: 'Delivery Days', group: 'Delivery', header: 'Delivery Days', width: 14, numeric: true, rowKey: 'deliveryDays' },
  { id: 'deliveryText', label: 'Delivery Text (original)', group: 'Delivery', header: 'Delivery Text (original)', width: 52, rowKey: 'deliveryText' },
  { id: 'deliveryStatus', label: 'Delivery Status', group: 'Delivery', header: 'Delivery Status', width: 17, rowKey: 'deliveryStatus' },

  // ---- Variation ----
  { id: 'variationAsin', label: 'Variation / Observed ASIN', group: 'Variation', header: 'Selected / Observed ASIN', width: 20, rowKey: 'variationAsin' },
  { id: 'variationType', label: 'Variation Type', group: 'Variation', header: 'Variation Type', width: 15, rowKey: 'variationType' },
  { id: 'selectedSize', label: 'Selected Size', group: 'Variation', header: 'Selected Size', width: 15, rowKey: 'selectedSize' },
  { id: 'selectedColor', label: 'Selected Color', group: 'Variation', header: 'Selected Color', width: 15, rowKey: 'selectedColor' },

  // ---- Marketplace & Meta ----
  { id: 'marketplaceId', label: 'Marketplace', group: 'Marketplace & Meta', header: 'Marketplace', width: 15, rowKey: 'marketplaceId' },
  { id: 'marketplaceDomain', label: 'Marketplace Domain', group: 'Marketplace & Meta', header: 'Marketplace Domain', width: 20, rowKey: 'marketplaceDomain' },
  { id: 'country', label: 'Country', group: 'Marketplace & Meta', header: 'Country', width: 20, rowKey: 'country' },
  { id: 'currency', label: 'Currency', group: 'Marketplace & Meta', header: 'Currency', width: 10, rowKey: 'currency' },
  { id: 'status', label: 'Status', group: 'Marketplace & Meta', header: 'Status', width: 14, rowKey: 'status' },
  { id: 'statusDetail', label: 'Status Detail', group: 'Marketplace & Meta', header: 'Status Detail', width: 44, rowKey: 'statusDetail' },
  { id: 'offersCount', label: 'Offers Found', group: 'Marketplace & Meta', header: 'Offers Found', width: 13, numeric: true, rowKey: 'offersCount' },
  { id: 'offersComplete', label: 'Offers Complete', group: 'Marketplace & Meta', header: 'Offers Complete', width: 15, rowKey: 'offersComplete' },
  { id: 'scrapedAt', label: 'Retrieved At (UTC)', group: 'Marketplace & Meta', header: 'Retrieved At (UTC)', width: 22, rowKey: 'scrapedAt' },
];

export const DEFAULT_FIELDS: string[] = FIELDS.map((f) => f.id);

export const PRESETS: Record<string, string[]> = {
  basic: ['asin', 'title', 'image', 'url'],
  buybox: ['asin', 'title', 'image', 'url', 'buyBoxSellerName', 'buyBoxSellerPrice', 'isBuyBox'],
  full: DEFAULT_FIELDS,
};

export function fieldById(id: string): FieldDef | undefined {
  return FIELDS.find((f) => f.id === id);
}

export function fieldsByIds(ids: string[]): FieldDef[] {
  const set = new Set(ids);
  return FIELDS.filter((f) => set.has(f.id));
}

/** Does this selection require the offers (AOD) page? */
export function needsOffersPage(ids: string[]): boolean {
  return fieldsByIds(ids).some((f) => f.requiresOffersPage);
}

/** Does this selection require Buy Box extraction? */
export function needsBuyBox(ids: string[]): boolean {
  return fieldsByIds(ids).some((f) => f.requiresBuyBox);
}

/** Does this selection require the English-title fetch? */
export function needsEnglishTitle(ids: string[]): boolean {
  return fieldsByIds(ids).some((f) => f.requiresEnglishTitle);
}