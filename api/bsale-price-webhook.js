const BSALE = "https://api.bsale.io";
const SHOPIFY_API_VERSION = "2026-01";

// Solo variantes cuya vinculacion Bsale <-> Shopify fue validada.
const BSALE_VARIANT_TO_SKU = new Map([
  [5911, "PP-10X20"],
  [6082, "PP-5X10"],
  [5907, "PP-10X15"],
  [5930, "PP-12X20"],
  [5960, "PP-15X25"],
  [7059, "ZIP-2.5X2.5"],
  [7027, "ZIP-3X4"],
  [6998, "ZIP-4X6"],
  [6340, "CAM-60X70-N"],
  [7058, "CAM-60X70-B"],
  [6833, "PAP-1-8K-B"],
  [6832, "PAP-1-4K-B"],
  [6831, "PAP-1-2K-B"],
  [6828, "PAP-1K-K"],
  [6834, "PAP-2K-K"],
  [6835, "PAP-3K-K"],
  [6838, "PAP-7K-K"],
  [7055, "TNT-40X50-VD"],
  [7054, "TNT-40X50-RJ"],
  [7053, "TNT-40X50-AZ"],
  [7056, "TNT-40X50-FC"],
  [7057, "TNT-40X50-NG"]
]);

// Sin excepciones manuales vigentes: los SKU revisados fueron aprobados para automatizacion.
const MANUAL_REVIEW_SKUS = new Set();

function jsonBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "object") return req.body;
  try {
    return JSON.parse(req.body);
  } catch {
    return {};
  }
}

async function bsaleGet(path) {
  const token = process.env.BSALE_ACCESS_TOKEN;
  if (!token) throw new Error("Falta BSALE_ACCESS_TOKEN");

  const r = await fetch(BSALE + path, {
    headers: { access_token: token, Accept: "application/json" }
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Bsale ${r.status}: ${JSON.stringify(data)}`);
  return data;
}

async function bsalePriceBySku(sku) {
  const listId = process.env.BSALE_PRICE_LIST_ID;
  if (!listId) throw new Error("Falta BSALE_PRICE_LIST_ID");

  const query = new URLSearchParams({
    code: sku,
    expand: "[variant]",
    limit: "50"
  });

  const data = await bsaleGet(`/v1/price_lists/${encodeURIComponent(listId)}/details.json?${query}`);
  const items = Array.isArray(data.items) ? data.items : [];
  const exact = items.find(item => String(item?.variant?.code || "") === String(sku));

  if (!exact) throw new Error(`SKU ${sku} no encontrado en la lista de precios Bsale`);

  const priceWithTaxes = Number(exact.variantValueWithTaxes);
  if (!Number.isFinite(priceWithTaxes)) {
    throw new Error(`Precio Bsale con impuestos invalido para ${sku}`);
  }

  return {
    sku,
    bsaleVariantId: Number(exact?.variant?.id || 0) || null,
    bsalePriceWithTaxes: priceWithTaxes,
    targetShopifyPrice: priceWithTaxes > 0 ? Math.ceil(priceWithTaxes) : null
  };
}

function shopifyDomain() {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  if (!domain) throw new Error("Falta SHOPIFY_STORE_DOMAIN");
  return domain;
}

async function getShopifyToken() {
  const staticToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN;
  if (staticToken) return staticToken;

  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Faltan credenciales Shopify");

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret
  });

  const r = await fetch(`https://${shopifyDomain()}/admin/oauth/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body
  });
  const data = await r.json();
  if (!r.ok || !data.access_token) throw new Error(`Shopify auth ${r.status}: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function shopify(query, variables = {}) {
  const token = await getShopifyToken();
  const r = await fetch(`https://${shopifyDomain()}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token
    },
    body: JSON.stringify({ query, variables })
  });
  const data = await r.json();
  if (!r.ok || data.errors) throw new Error(`Shopify: ${JSON.stringify(data)}`);
  return data;
}

async function shopifyVariantBySku(sku) {
  const data = await shopify(
    `query TodoPackVariantBySku($query: String!) {
      productVariants(first: 10, query: $query) {
        nodes {
          id
          sku
          price
          product { id title }
        }
      }
    }`,
    { query: `sku:${sku}` }
  );

  const variants = data.data?.productVariants?.nodes || [];
  const exact = variants.find(v => String(v.sku) === String(sku));
  if (!exact) throw new Error(`SKU ${sku} no encontrado en Shopify`);

  return {
    variantId: exact.id,
    productId: exact.product?.id,
    productName: exact.product?.title || "",
    currentPrice: Number(exact.price)
  };
}

async function updateShopifyVariantPrice(productId, variantId, price) {
  const data = await shopify(
    `mutation TodoPackUpdateVariantPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id sku price }
        userErrors { field message }
      }
    }`,
    {
      productId,
      variants: [{ id: variantId, price: String(price) }]
    }
  );

  const payload = data.data?.productVariantsBulkUpdate;
  const errors = payload?.userErrors || [];
  if (errors.length) {
    throw new Error(`Shopify update: ${JSON.stringify(errors)}`);
  }

  return payload?.productVariants?.[0] || null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Metodo no permitido" });
  }

  try {
    const body = jsonBody(req);
    const topic = String(body.topic || "").toLowerCase();
    const action = String(body.action || "").toLowerCase();
    const incomingPriceListId = String(body.priceListId || "");
    const configuredPriceListId = String(process.env.BSALE_PRICE_LIST_ID || "");
    const resourceId = Number(body.resourceId);

    if (topic !== "price" || action !== "put") {
      return res.status(202).json({ ok: true, ignored: true, reason: "Evento no es actualizacion de precio" });
    }

    if (!configuredPriceListId || incomingPriceListId !== configuredPriceListId) {
      return res.status(202).json({ ok: true, ignored: true, reason: "Lista de precios no autorizada" });
    }

    const sku = BSALE_VARIANT_TO_SKU.get(resourceId);
    if (!sku) {
      return res.status(202).json({ ok: true, ignored: true, reason: "Variante no validada" });
    }

    if (MANUAL_REVIEW_SKUS.has(sku)) {
      return res.status(200).json({
        ok: true,
        updated: false,
        manualReview: true,
        sku,
        reason: "SKU temporalmente excluido para revision manual"
      });
    }

    const [bsale, shopifyVariant] = await Promise.all([
      bsalePriceBySku(sku),
      shopifyVariantBySku(sku)
    ]);

    if (bsale.bsaleVariantId !== resourceId) {
      return res.status(409).json({
        ok: false,
        updated: false,
        sku,
        error: "El variantId de Bsale no coincide con el webhook"
      });
    }

    if (!bsale.targetShopifyPrice || bsale.targetShopifyPrice <= 0) {
      return res.status(200).json({
        ok: true,
        updated: false,
        safetyBlocked: true,
        sku,
        reason: "Precio Bsale con impuestos es 0 o negativo"
      });
    }

    if (shopifyVariant.currentPrice === bsale.targetShopifyPrice) {
      return res.status(200).json({
        ok: true,
        updated: false,
        noChange: true,
        sku,
        productName: shopifyVariant.productName,
        shopifyPrice: shopifyVariant.currentPrice,
        bsalePriceWithTaxes: bsale.bsalePriceWithTaxes,
        targetShopifyPrice: bsale.targetShopifyPrice
      });
    }

    const updated = await updateShopifyVariantPrice(
      shopifyVariant.productId,
      shopifyVariant.variantId,
      bsale.targetShopifyPrice
    );

    return res.status(200).json({
      ok: true,
      updated: true,
      sku,
      productName: shopifyVariant.productName,
      previousShopifyPrice: shopifyVariant.currentPrice,
      bsalePriceWithTaxes: bsale.bsalePriceWithTaxes,
      newShopifyPrice: Number(updated?.price ?? bsale.targetShopifyPrice),
      roundingRule: "Math.ceil"
    });
  } catch (e) {
    return res.status(500).json({ ok: false, updated: false, error: e.message });
  }
}
