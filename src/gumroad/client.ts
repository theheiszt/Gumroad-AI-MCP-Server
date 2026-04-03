import type { LicenseCheck, OfferCode, Product, ProductVariant, Sale, SyncSalesArgs, VariantCategory } from "../types.js";
import { normalizeLicenseCheck, normalizeOfferCode, normalizeProduct, normalizeSale, normalizeVariant, normalizeVariantCategory } from "./normalize.js";

const GUMROAD_API = "https://api.gumroad.com";

export class UnsupportedGumroadOperationError extends Error {}

export class GumroadClient {
  constructor(private readonly accessToken: string) {}

  async getProfile() {
    const response = await this.requestJson("GET", "/v2/user");
    return response?.user ?? null;
  }

  async listProducts(query?: string): Promise<Product[]> {
    const response = await this.requestJson("GET", "/v2/products");
    const rows = Array.isArray(response?.products) ? response.products : [];
    const products = rows.map((row: Record<string, any>) => normalizeProduct(row));
    const q = query?.trim().toLowerCase();
    if (!q) return products;

    return products.filter((product) => {
      const haystack = [product.name, product.description ?? "", ...(product.tags ?? [])].join(" ").toLowerCase();
      return haystack.includes(q);
    });
  }

  async getProduct(productId: string): Promise<Product | null> {
    const response = await this.requestJson("GET", `/v2/products/${encodeURIComponent(productId)}`);
    if (!response?.product) return null;
    return normalizeProduct(response.product);
  }

  async listSales(args: SyncSalesArgs = {}): Promise<Sale[]> {
    const limit = Math.min(args.limit ?? 100, 500);
    const params = new URLSearchParams();
    if (args.productId) params.set("product_id", args.productId);
    if (args.after) params.set("after", args.after.slice(0, 10));
    if (args.before) params.set("before", args.before.slice(0, 10));

    const sales: Sale[] = [];
    let nextPageKey: string | undefined;

    while (sales.length < limit) {
      if (nextPageKey) params.set("page_key", nextPageKey);
      const response = await this.requestJson("GET", `/v2/sales?${params.toString()}`);
      const pageRows = Array.isArray(response?.sales)
        ? response.sales.map((row: Record<string, any>) => normalizeSale(row))
        : [];
      sales.push(...pageRows);
      nextPageKey = typeof response?.next_page_key === "string" ? response.next_page_key : undefined;
      if (!nextPageKey || pageRows.length === 0) break;
    }

    sales.sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());
    return sales.slice(0, limit);
  }

  async createProduct(payload: Record<string, string>) {
    const body = new URLSearchParams(payload);
    return this.requestJson("POST", "/v2/products", body);
  }

  async createVariantCategory(payload: Record<string, string>) {
    return this.requestJson("POST", "/v2/variants", new URLSearchParams(payload));
  }

  async editVariantCategory(payload: Record<string, string>) {
    return this.requestJson("PUT", "/v2/variants", new URLSearchParams(payload));
  }

  async deleteVariantCategory(payload: Record<string, string>) {
    return this.requestJson("DELETE", "/v2/variants", new URLSearchParams(payload));
  }

  async createVariant(payload: Record<string, string>) {
    return this.requestJson("POST", "/v2/variants/values", new URLSearchParams(payload));
  }

  async editVariant(payload: Record<string, string>) {
    return this.requestJson("PUT", "/v2/variants/values", new URLSearchParams(payload));
  }

  async deleteVariant(payload: Record<string, string>) {
    return this.requestJson("DELETE", "/v2/variants/values", new URLSearchParams(payload));
  }

  async createOfferCode(payload: Record<string, string>) {
    return this.requestJson("POST", "/v2/offer_codes", new URLSearchParams(payload));
  }

  async deleteOfferCode(payload: Record<string, string>) {
    return this.requestJson("DELETE", "/v2/offer_codes", new URLSearchParams(payload));
  }

  async disableOfferCode(): Promise<never> {
    throw new UnsupportedGumroadOperationError(
      "Disable offer code is not supported by the currently implemented Gumroad endpoint set. Use delete_offer_code instead.",
    );
  }

  async listProductVariantCategories(productId: string): Promise<VariantCategory[]> {
    const response = await this.requestJson("GET", `/v2/products/${encodeURIComponent(productId)}/variants`);
    const rows = Array.isArray(response?.variants) ? response.variants : [];
    return rows.map((row: Record<string, any>) => normalizeVariantCategory(productId, row));
  }

  async listProductVariants(productId: string): Promise<ProductVariant[]> {
    const response = await this.requestJson("GET", `/v2/products/${encodeURIComponent(productId)}/variant_values`);
    const rows = Array.isArray(response?.variants) ? response.variants : [];
    return rows.map((row: Record<string, any>) => normalizeVariant(productId, row));
  }

  async listOfferCodes(productId: string): Promise<OfferCode[]> {
    const response = await this.requestJson("GET", `/v2/products/${encodeURIComponent(productId)}/offer_codes`);
    const rows = Array.isArray(response?.offer_codes) ? response.offer_codes : [];
    return rows.map((row: Record<string, any>) => normalizeOfferCode(productId, row));
  }

  async verifyLicense(productId: string, licenseKey: string): Promise<LicenseCheck> {
    const body = new URLSearchParams({
      product_id: productId,
      license_key: licenseKey,
      increment_uses_count: "false",
    });
    const response = await this.requestJson("POST", "/v2/licenses/verify", body);
    return normalizeLicenseCheck(productId, licenseKey, response);
  }

  private async requestJson(method: "GET" | "POST" | "PUT" | "DELETE", path: string, formBody?: URLSearchParams) {
    const headers: Record<string, string> = {};
    let url = `${GUMROAD_API}${path}`;
    let body: string | undefined;

    if (method === "GET") {
      const separator = url.includes("?") ? "&" : "?";
      url = `${url}${separator}access_token=${encodeURIComponent(this.accessToken)}`;
    } else {
      headers["content-type"] = "application/x-www-form-urlencoded";
      const form = formBody ?? new URLSearchParams();
      form.set("access_token", this.accessToken);
      body = form.toString();
    }

    const response = await fetch(url, { method, headers, body });
    const text = await response.text();
    const json = text ? safeJsonParse(text) : {};
    if (!response.ok || json?.success === false) {
      const message = typeof json?.message === "string" ? json.message : text || response.statusText;
      if (response.status === 404 || response.status === 405) {
        throw new UnsupportedGumroadOperationError(`Unsupported Gumroad operation at ${path}: ${message}`);
      }
      throw new Error(`Gumroad API error ${response.status}: ${message}`);
    }
    return json;
  }
}

function safeJsonParse(text: string) {
  try {
    return JSON.parse(text) as Record<string, any>;
  } catch {
    return { raw: text };
  }
}
