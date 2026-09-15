const BSALE = "https://api.bsale.io";
const SHOPIFY_API_VERSION = "2026-01";

async function bsaleGet(path) {
  const token = process.env.BSALE_ACCESS_TOKEN;
  if (!token) throw new Error("Falta BSALE_ACCESS_TOKEN");

  const response = await fetch(BSALE + path, {
    headers: { access_token: token, Accept: "application/json" }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Bsale ${response.status}: ${JSON.stringify(data)}`);
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
    bsaleVariantId: exact?.variant?.id || null,
    bsaleVariantCode: exact?.variant?.code || null,
    bsalePriceNet: net,
    bsalePriceWithTaxes: withTaxes,
    targetShopifyPrice: safetyBlocked ? null : Math.ceil(withTaxes),
    safetyBlocked
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

  const response = await fetch(`https://${shopifyDomain()}/admin/oauth/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(`Shopify auth ${response.status}: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

async function shopify(query, variables = {}) {
  const token = await getShopifyToken();
  const response = await fetch(`https://${shopifyDomain()}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token
    },
    body: JSON.stringify({ query, variables })
  });
  const data = await response.json();
  if (!response.ok || data.errors) throw new Error(`Shopify: ${JSON.stringify(data)}`);
  return data;
}

export default async function handler(req, res) {
  try {
    const data = await shopify(`
      query TodoPackAllActiveProducts {
        products(first: 100, query: "status:active") {
          nodes {
            id
            title
            variants(first: 100) {
              nodes { id sku price }
            }
          }
        }
      }
    `);

    const products = data.data?.products?.nodes || [];
    const comparisons = [];

    for (const product of products) {
      for (const variant of product.variants?.nodes || []) {
        const sku = String(variant.sku || "").trim();
        const currentShopifyPrice = Number(variant.price);
        if (!sku) {
          comparisons.push({ ok: false, productName: product.title, sku: "", currentShopifyPrice, error: "Variante Shopify sin SKU" });
          continue;
        }

        try {
          const bsale = await bsalePriceBySku(sku);
          const matches = !bsale.safetyBlocked && currentShopifyPrice === bsale.targetShopifyPrice;
          comparisons.push({
            ok: true,
            productName: product.title,
            sku,
            currentShopifyPrice,
            bsalePriceNet: bsale.bsalePriceNet,
            bsalePriceWithTaxes: bsale.bsalePriceWithTaxes,
            targetShopifyPrice: bsale.targetShopifyPrice,
            matches,
            wouldUpdate: !bsale.safetyBlocked && !matches,
            safetyBlocked: bsale.safetyBlocked,
            bsaleVariantId: bsale.bsaleVariantId,
            bsaleVariantCode: bsale.bsaleVariantCode
          });
        } catch (error) {
          comparisons.push({ ok: false, productName: product.title, sku, currentShopifyPrice, error: error.message });
        }
      }
    }

    return res.status(200).json({
      ok: true,
      mode: "read-only-audit-all-active-products",
      writesPerformed: false,
      activeProductCount: products.length,
      activeVariantCount: comparisons.length,
      matchedCount: comparisons.filter(x => x.ok && x.matches).length,
      differingCount: comparisons.filter(x => x.ok && x.wouldUpdate).length,
      blockedCount: comparisons.filter(x => x.ok && x.safetyBlocked).length,
      errorCount: comparisons.filter(x => !x.ok).length,
      comparisons
    });
  } catch (error) {
    return res.status(500).json({ ok: false, writesPerformed: false, error: error.message });
  }
}
