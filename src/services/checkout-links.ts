import { z } from "zod";
import type { Product } from "../types.js";

const GUMROAD_HOST = "https://gumroad.com";

const checkoutFrequencySchema = z.enum(["monthly", "quarterly", "biannually", "yearly"]);

export const checkoutOptionsSchema = z
  .object({
    wanted: z.boolean().optional(),
    email: z.string().email().optional(),
    price: z.number().int().min(1).optional(),
    quantity: z.number().int().min(1).max(100).optional(),
    variant: z.string().trim().min(1).optional(),
    frequency: checkoutFrequencySchema.optional(),
    referrer: z.string().trim().min(1).max(200).optional(),
    discountCode: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

const checkoutProductSchema = z
  .object({
    id: z.string().trim().min(1).optional(),
    permalink: z.string().trim().min(1),
    name: z.string().trim().min(1).optional(),
  })
  .strict();

export type CheckoutOptions = z.infer<typeof checkoutOptionsSchema>;

export type CheckoutUrlProductInput = Pick<Product, "permalink"> & Partial<Pick<Product, "id" | "name">>;

export type CheckoutUrlData = {
  baseUrl: string;
  path: string;
  query: Record<string, string>;
  url: string;
  copyPaste: string;
  product: {
    id?: string;
    name?: string;
    permalink: string;
  };
};

export function buildCheckoutUrl(product: CheckoutUrlProductInput, options: CheckoutOptions = {}): CheckoutUrlData {
  const parsedProduct = checkoutProductSchema.parse(product);
  const parsedOptions = checkoutOptionsSchema.parse(options);
  const permalinkPath = resolvePermalinkPath(parsedProduct.permalink);

  const pathParts = [permalinkPath];
  if (parsedOptions.discountCode) {
    pathParts.push(encodeURIComponent(parsedOptions.discountCode));
  }

  const query = new URLSearchParams();
  if (parsedOptions.wanted === true) query.set("wanted", "true");
  if (parsedOptions.email) query.set("email", parsedOptions.email);
  if (parsedOptions.price != null) query.set("price", String(parsedOptions.price));
  if (parsedOptions.quantity != null) query.set("quantity", String(parsedOptions.quantity));
  if (parsedOptions.variant) query.set("variant", parsedOptions.variant);
  if (parsedOptions.frequency) query.set("frequency", parsedOptions.frequency);
  if (parsedOptions.referrer) query.set("referrer", parsedOptions.referrer);

  const path = pathParts.join("/");
  const queryString = query.toString();
  const url = `${GUMROAD_HOST}${path}${queryString ? `?${queryString}` : ""}`;

  return {
    baseUrl: GUMROAD_HOST,
    path,
    query: Object.fromEntries(query.entries()),
    url,
    copyPaste: url,
    product: {
      id: parsedProduct.id,
      name: parsedProduct.name,
      permalink: parsedProduct.permalink,
    },
  };
}

export function parseCheckoutLinkRequest(input: unknown) {
  const schema = z
    .object({
      product: checkoutProductSchema.optional(),
      productId: z.string().trim().min(1).optional(),
      productUrl: z.string().trim().min(1).optional(),
      options: checkoutOptionsSchema.optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (!value.product && !value.productId && !value.productUrl) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["product"], message: "Either product or productId is required." });
      }
    });

  return schema.parse(input);
}

function resolvePermalinkPath(permalink: string) {
  const trimmed = permalink.trim();
  if (!trimmed) throw new Error("Product permalink is required.");

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    const url = new URL(trimmed);
    if (!url.hostname.endsWith("gumroad.com")) {
      throw new Error("Permalink must point to gumroad.com.");
    }
    return normalizePath(url.pathname);
  }

  return normalizePath(trimmed);
}

function normalizePath(input: string) {
  let path = input.trim();
  if (!path.startsWith("/")) path = `/${path}`;
  path = path.replace(/\/+$/g, "");
  if (!path) throw new Error("Unable to derive checkout path from permalink.");
  return path;
}
