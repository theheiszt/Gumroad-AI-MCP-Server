import type { LicenseCheck, OfferCode, Product, Sale, SyncSalesArgs, Variant, VariantCategory } from "../types.js";
import {
  normalizeLicenseCheck,
  normalizeOfferCode,
  normalizeProduct,
  normalizeSale,
  normalizeVariant,
  normalizeVariantCategory,
} from "./normalize.js";

const GUMROAD_API = "https://api.gumroad.com";

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

    return products.filter((product) => [product.name, product.description ?? "", ...(product.tags ?? [])].join(" ").toLowerCase().includes(q));
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
      const pageRows = Array.isArray(response?.sales) ? response.sales.map((row: Record<string, any>) => normalizeSale(row)) : [];
      sales.push(...pageRows);
      nextPageKey = typeof response?.next_page_key === "string" ? response.next_page_key : undefined;
      if (!nextPageKey || pageRows.length === 0) break;
    }

    sales.sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());
    return sales.slice(0, limit);
  }

  async createProduct(payload: Record<string, string>) {
    return this.requestJson("POST", "/v2/products", new URLSearchParams(payload));
  }

  async createVariantCategory(productId: string, payload: Record<string, string>) {
    return this.requestJson("POST", `/v2/products/${encodeURIComponent(productId)}/variant_categories`, new URLSearchParams(payload));
  }

  async editVariantCategory(productId: string, categoryId: string, payload: Record<string, string>) {
    return this.requestJson(
      "PATCH",
      `/v2/products/${encodeURIComponent(productId)}/variant_categories/${encodeURIComponent(categoryId)}`,
      new URLSearchParams(payload),
    );
  }

  async deleteVariantCategory(productId: string, categoryId: string) {
    return this.requestJson("DELETE", `/v2/products/${encodeURIComponent(productId)}/variant_categories/${encodeURIComponent(categoryId)}`);
  }

  async listVariantCategories(productId: string): Promise<VariantCategory[]> {
    const response = await this.requestJson("GET", `/v2/products/${encodeURIComponent(productId)}/variant_categories`);
    const rows = Array.isArray(response?.variant_categories) ? response.variant_categories : [];
    return rows.map((row: Record<string, any>) => normalizeVariantCategory(row, productId));
  }

  async createVariant(productId: string, payload: Record<string, string>) {
    return this.requestJson("POST", `/v2/products/${encodeURIComponent(productId)}/variants`, new URLSearchParams(payload));
  }

  async editVariant(productId: string, variantId: string, payload: Record<string, string>) {
    return this.requestJson(
      "PATCH",
      `/v2/products/${encodeURIComponent(productId)}/variants/${encodeURIComponent(variantId)}`,
      new URLSearchParams(payload),
    );
  }

  async deleteVariant(productId: string, variantId: string) {
    return this.requestJson("DELETE", `/v2/products/${encodeURIComponent(productId)}/variants/${encodeURIComponent(variantId)}`);
  }

  async listVariants(productId: string): Promise<Variant[]> {
    const response = await this.requestJson("GET", `/v2/products/${encodeURIComponent(productId)}/variants`);
    const rows = Array.isArray(response?.variants) ? response.variants : [];
    return rows.map((row: Record<string, any>) => normalizeVariant(row, productId));
  }

  async createOfferCode(productId: string, payload: Record<string, string>) {
    return this.requestJson("POST", `/v2/products/${encodeURIComponent(productId)}/offer_codes`, new URLSearchParams(payload));
  }

  async listOfferCodes(productId: string): Promise<OfferCode[]> {
    const response = await this.requestJson("GET", `/v2/products/${encodeURIComponent(productId)}/offer_codes`);
    const rows = Array.isArray(response?.offer_codes) ? response.offer_codes : [];
    return rows.map((row: Record<string, any>) => normalizeOfferCode(row, productId));
  }

  async disableOfferCode(): Promise<never> {
    throw new Error("Unsupported operation: disable offer code endpoint is not available in current Gumroad API wrapper.");
  }

  async deleteOfferCode(productId?: string, offerCodeId?: string): Promise<Record<string, unknown>> {
    if (!productId || !offerCodeId) {
      throw new Error("Unsupported operation: delete offer code endpoint requires productId and offerCodeId.");
    }
    return this.requestJson("DELETE", `/v2/products/${encodeURIComponent(productId)}/offer_codes/${encodeURIComponent(offerCodeId)}`);
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

  private async requestJson(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, formBody?: URLSearchParams) {
    const headers: Record<string, string> = {};
    let url = `${GUMROAD_API}${path}`;
    let body: string | undefined;

    if (method === "GET" || method === "DELETE") {
      const separator = url.includes("?") ? "&" : "?";
      url = `${url}${separator}access_token=${encodeURIComponent(this.accessToken)}`;
      if (method === "DELETE" && formBody) {
        const extra = formBody.toString();
        if (extra) url = `${url}&${extra}`;
      }
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
