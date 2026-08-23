const BSALE = "https://api.bsale.io";
const SHOPIFY_API_VERSION = "2026-01";

const VALIDATED_PRODUCT_RULES = [
  { family: "Bolsa Camiseta", terms: ["40x50"] },
  { family: "Saco Papel", terms: ["7 Kilos"] },
  { family: "Saco Papel", terms: ["3 Kilos"] },
  { family: "Saco Papel", terms: ["2 Kilos"] },
  { family: "Saco Papel", terms: ["1 Kilo"] },
  { family: "Saco Papel", terms: ["1/2 Kilo"] },
  { family: "Saco Papel", terms: ["1/4 Kilo"] },
  { family: "Saco Papel", terms: ["1/8 Kilo"] },
  { family: "Bolsa Camiseta", terms: ["60x70"] },
  { family: "Bolsa Ziploc", terms: ["4x6"] },
  { family: "Bolsa Ziploc", terms: ["3x4"] },
  { family: "Bolsa Ziploc", terms: ["2,5x2,5"] },
  { family: "Bolsa Polipropileno", terms: ["15x25"] },
  { family: "Bolsa Polipropileno", terms: ["12x20"] },
  { family: "Bolsa Polipropileno", terms: ["10x15"] },
  { family: "Bolsa Polipropileno", terms: ["5x10"] },
  { family: "Bolsa Polipropileno", terms: ["10x20"] }
];

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function isValidatedProduct(title) {
  const normalized = normalize(title);
  return VALIDATED_PRODUCT_RULES.some(rule => {
    if (!normalized.includes(normalize(rule.family))) return false;
    return rule.terms.every(term => normalized.includes(normalize(term)));
  });
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

  const exact = items.find(item => String(item?.variant?.code || "") === String(sku)) || items[0];
  if (!exact) throw new Error(`SKU ${sku} no encontrado en la lista de precios Bsale`);

  const net = Number(exact.variantValue);
  const withTaxes = Number(exact.variantValueWithTaxes);

  if (!Number.isFinite(net) || !Number.isFinite(withTaxes)) {
    throw new Error(`Precio Bsale invalido para ${sku}`);
  }

  const safetyBlocked = withTaxes <= 0;

  return {
    sku,
    bsaleVariantId: exact?.variant?.id || null,
    bsaleVariantCode: exact?.variant?.code || null,
    bsalePriceNet: net,
    bsalePriceWithTaxes: withTaxes,
    targetShopifyPrice: safetyBlocked ? null : Math.ceil(withTaxes),
    safetyBlocked,
    safetyReason: safetyBlocked ? "Precio Bsale con impuestos es 0 o negativo" : null
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
  const domain = shopifyDomain();
  if (!clientId || !clientSecret) throw new Error("Faltan credenciales Shopify");

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret
  });

  const r = await fetch(`https://${domain}/admin/oauth/access_token`, {
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

export default async function handler(req, res) {
  try {
    const data = await shopify(`
      query TodoPackValidatedLinkedProducts {
        products(first: 100, query: "status:active") {
          nodes {
            id
            title
            variants(first: 100) {
              nodes {
                id
                sku
                price
              }
            }
          }
        }
      }
    `);

    const products = data.data?.products?.nodes || [];
    const validatedProducts = products.filter(p => isValidatedProduct(p.title));
    const comparisons = [];

    for (const product of validatedProducts) {
      for (const variant of product.variants?.nodes || []) {
        const sku = String(variant.sku || "").trim();
        if (!sku) {
          comparisons.push({
            ok: false,
            productName: product.title,
            sku: "",
            currentShopifyPrice: Number(variant.price),
            error: "Variante Shopify sin SKU"
          });
          continue;
        }

        try {
          const bsale = await bsalePriceBySku(sku);
          const currentShopifyPrice = Number(variant.price);
          const matches = !bsale.safetyBlocked && currentShopifyPrice === bsale.targetShopifyPrice;
          const wouldUpdate = !bsale.safetyBlocked && currentShopifyPrice !== bsale.targetShopifyPrice;

          comparisons.push({
            ok: true,
            productName: product.title,
            sku,
            currentShopifyPrice,
            bsalePriceNet: bsale.bsalePriceNet,
            bsalePriceWithTaxes: bsale.bsalePriceWithTaxes,
            targetShopifyPrice: bsale.targetShopifyPrice,
            matches,
            difference: bsale.safetyBlocked ? null : bsale.targetShopifyPrice - currentShopifyPrice,
            wouldUpdate,
            safetyBlocked: bsale.safetyBlocked,
            safetyReason: bsale.safetyReason,
            bsaleVariantId: bsale.bsaleVariantId,
            bsaleVariantCode: bsale.bsaleVariantCode
          });
        } catch (e) {
          comparisons.push({
            ok: false,
            productName: product.title,
            sku,
            currentShopifyPrice: Number(variant.price),
            error: e.message
          });
        }
      }
    }

    return res.status(200).json({
      ok: true,
      mode: "read-only-audit",
      writesPerformed: false,
      priceSource: "Bsale variantValueWithTaxes",
      roundingRule: "Math.ceil / redondeo hacia arriba",
      zeroOrNegativePricePolicy: "BLOCK",
      validatedProductsFound: validatedProducts.length,
      validatedProductTitles: validatedProducts.map(p => p.title),
      comparisonCount: comparisons.length,
      matchedCount: comparisons.filter(x => x.ok && x.matches).length,
      differingCount: comparisons.filter(x => x.ok && x.wouldUpdate).length,
      blockedCount: comparisons.filter(x => x.ok && x.safetyBlocked).length,
      errorCount: comparisons.filter(x => !x.ok).length,
      comparisons
    });
  } catch (e) {
    return res.status(500).json({ ok: false, writesPerformed: false, error: e.message });
  }
}
