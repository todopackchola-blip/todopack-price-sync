const BSALE = "https://api.bsale.io";

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

async function shopify(query, variables) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token =
    process.env.SHOPIFY_ADMIN_ACCESS_TOKEN ||
    process.env.SHOPIFY_ACCESS_TOKEN;

  if (!domain || !token) {
    throw new Error("Faltan credenciales de Shopify");
  }

  const r = await fetch(`https://${domain}/admin/api/2026-01/graphql.json`, {
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
      return res.status(200).json({
        ok: true,
        bsaleToken: !!process.env.BSALE_ACCESS_TOKEN,
        bsalePriceList: !!process.env.BSALE_PRICE_LIST_ID,
        shopify: !!(
          process.env.SHOPIFY_STORE_DOMAIN &&
          (process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN)
        ),
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
