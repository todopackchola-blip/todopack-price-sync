const BSALE = "https://api.bsale.io";
const SHOPIFY_API_VERSION = "2026-01";

let cachedShopifyToken = null;
let cachedShopifyTokenExpiresAt = 0;
let cachedShopifyScope = null;

async function bsaleGet(path) {
  const token = process.env.BSALE_ACCESS_TOKEN;
  if (!token) throw new Error("Falta BSALE_ACCESS_TOKEN");

  const r = await fetch(BSALE + path, {
    headers: {
      access_token: token,
      Accept: "application/json"
    }
  });

  const data = await r.json();

  if (!r.ok) {
    throw new Error(`Bsale ${r.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

async function bsalePrice(sku) {
  const list = process.env.BSALE_PRICE_LIST_ID;
  if (!list) throw new Error("Falta BSALE_PRICE_LIST_ID");

  const q = new URLSearchParams({
    code: sku,
    priceListId: list,
    limit: "50",
    expand: "[variantsInfo,variant.salePrice]"
  });

  const data = await bsaleGet(`/v2/products/list/market_info.json?${q}`);

  for (const p of data.data || []) {
    const variants = Array.isArray(p.variants) ? p.variants : [];

    for (const v of variants) {
      if (String(v.code) === String(sku)) {
        const raw = Number(v.finalPrice ?? v.price);

        if (!Number.isFinite(raw)) {
          throw new Error(`Precio invalido para ${sku}`);
        }

        return {
          sku,
          productName: p.name || "",
          bsalePriceRaw: raw,
          shopifyPrice: Math.ceil(raw),
          variantId: v.id
        };
      }
    }
  }

  throw new Error(`SKU ${sku} no encontrado en Bsale`);
}

function shopifyDomain() {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  if (!domain) throw new Error("Falta SHOPIFY_STORE_DOMAIN");
  return domain;
}

async function getShopifyAccessToken() {
  const staticToken =
    process.env.SHOPIFY_ADMIN_ACCESS_TOKEN ||
    process.env.SHOPIFY_ACCESS_TOKEN;

  if (staticToken) {
    cachedShopifyScope = null;
    return staticToken;
  }

  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  const domain = shopifyDomain();

  if (!clientId || !clientSecret) {
    throw new Error("Faltan SHOPIFY_CLIENT_ID o SHOPIFY_CLIENT_SECRET");
  }

  const now = Date.now();
  if (cachedShopifyToken && now < cachedShopifyTokenExpiresAt) {
    return cachedShopifyToken;
  }

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

  if (!r.ok || !data.access_token) {
    throw new Error(`Shopify auth ${r.status}: ${JSON.stringify(data)}`);
  }

  cachedShopifyToken = data.access_token;
  cachedShopifyScope = data.scope || "";
  const expiresIn = Number(data.expires_in || 86399);
  cachedShopifyTokenExpiresAt = now + Math.max(60, expiresIn - 300) * 1000;

  return cachedShopifyToken;
}

async function shopify(query, variables = {}) {
  const domain = shopifyDomain();
  const token = await getShopifyAccessToken();

  const r = await fetch(`https://${domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token
    },
    body: JSON.stringify({ query, variables })
  });

  const data = await r.json();

  if (!r.ok || data.errors) {
    throw new Error(`Shopify: ${JSON.stringify(data)}`);
  }

  return data;
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, "https://example.com");
    const routeFromQuery =
      typeof req.query?.route === "string"
        ? req.query.route
        : url.searchParams.get("route");

    const routeFromPath = url.pathname.startsWith("/api/")
      ? url.pathname.slice(5)
      : "";

    const route = routeFromQuery || routeFromPath;

    if (!route) {
      return res.status(200).json({
        ok: true,
        service: "todopack-price-sync",
        dryRun: process.env.DRY_RUN !== "false"
      });
    }

    if (route === "health") {
      const hasStaticShopifyToken = !!(
        process.env.SHOPIFY_ADMIN_ACCESS_TOKEN ||
        process.env.SHOPIFY_ACCESS_TOKEN
      );

      const hasShopifyClientCredentials = !!(
        process.env.SHOPIFY_CLIENT_ID &&
        process.env.SHOPIFY_CLIENT_SECRET
      );

      return res.status(200).json({
        ok: true,
        bsaleToken: !!process.env.BSALE_ACCESS_TOKEN,
        bsalePriceList: !!process.env.BSALE_PRICE_LIST_ID,
        shopifyDomain: !!process.env.SHOPIFY_STORE_DOMAIN,
        shopifyAuth: hasStaticShopifyToken || hasShopifyClientCredentials,
        dryRun: process.env.DRY_RUN !== "false"
      });
    }

    if (route === "price-lists") {
      const data = await bsaleGet("/v1/price_lists.json?limit=50");
      const lists = (data.items || data.data || []).map(item => ({
        id: item.id,
        name: item.name
      }));

      return res.status(200).json({
        ok: true,
        lists
      });
    }

    if (route === "test-bsale") {
      const skus = (process.env.TEST_SKUS || "")
        .split(",")
        .map(x => x.trim())
        .filter(Boolean);

      if (!skus.length) {
        return res.status(400).json({
          ok: false,
          error: "Falta TEST_SKUS"
        });
      }

      const results = [];

      for (const sku of skus) {
        try {
          results.push({ ok: true, ...(await bsalePrice(sku)) });
        } catch (e) {
          results.push({ ok: false, sku, error: e.message });
        }
      }

      return res.status(200).json({ ok: true, results });
    }

    if (route === "shopify-scopes") {
      cachedShopifyToken = null;
      cachedShopifyTokenExpiresAt = 0;
      cachedShopifyScope = null;

      await getShopifyAccessToken();

      return res.status(200).json({
        ok: true,
        scope: cachedShopifyScope
      });
    }

    if (route === "test-shopify") {
      const data = await shopify(`
        query TodoPackShopifyReadOnlyTest {
          shop {
            name
            primaryDomain {
              host
              url
            }
          }
          products(first: 3) {
            nodes {
              id
              title
              variants(first: 5) {
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

      return res.status(200).json({
        ok: true,
        shop: data.data?.shop || null,
        products: data.data?.products?.nodes || []
      });
    }

    return res.status(404).json({
      ok: false,
      error: "Ruta no encontrada"
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e.message
    });
  }
}
