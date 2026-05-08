const express = require("express");
const cors    = require("cors");
const fetch   = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Твой clid Яндекс Маркета ──────────────────────────────────────────
// Получить: https://partner.market.yandex.ru → Настройки → Партнёрская программа
const MARKET_CLID   = process.env.MARKET_CLID   || "YOUR_CLID_HERE";
const DISTR_TYPE    = "7";

app.use(cors());
app.use(express.json());


async function fetchWithRetry(url, options = {}, retries = 3) {

  for (let attempt = 1; attempt <= retries; attempt++) {

    try {

      const res = await fetch(url, options);

      if ([403, 429, 500, 502, 503].includes(res.status)) {

        console.log(`Попытка ${attempt}: статус ${res.status}`);

        if (attempt === retries) {
          return res;
        }

        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      return res;

    } catch (e) {

      console.log("FETCH ERROR:", e.message);

      if (attempt === retries) {
        throw e;
      }

      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//  GET /search?source=wb&article=225308444
//  GET /search?source=ozon&article=123456789
// ═══════════════════════════════════════════════════════════════
app.get("/search", async (req, res) => {
  const { source, article } = req.query;

  if (!source || !article) {
    return res.status(400).json({ error: "Укажите source (wb|ozon) и article" });
  }
  if (!/^\d{4,15}$/.test(article)) {
    return res.status(400).json({ error: "Некорректный артикул" });
  }

  try {
    let productName, priceSource, imageUrl;

    // ── 1. Получаем данные с источника ──────────────────────────
    if (source === "wb") {
      ({ productName, priceSource, imageUrl } = await fetchWB(article));
    } else if (source === "ozon") {
      ({ productName, priceSource, imageUrl } = await fetchOzon(article));
    } else {
      return res.status(400).json({ error: "source должен быть wb или ozon" });
    }

    // ── 2. Ищем товар на Яндекс Маркете ─────────────────────────
    const { marketName, marketPrice, marketUrl, marketImage } =
      await searchYandexMarket(productName);

    // ── 3. Добавляем реферальную ссылку ─────────────────────────
    const refLink = buildRefLink(marketUrl, productName);

    res.json({
      source,
      article,
      product: {
        name:       productName,
        priceSource,
        imageUrl,
      },
      market: {
        name:       marketName,
        price:      marketPrice,
        imageUrl:   marketImage,
        refLink,
        clidSet:    MARKET_CLID !== "YOUR_CLID_HERE",
      },
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Ошибка поиска" });
  }
});

// ── Health check для Render ──────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "ok", service: "PricePulse API" }));

// ═══════════════════════════════════════════════════════════════
//  WB: открытый API, работает без ключа
// ═══════════════════════════════════════════════════════════════
async function fetchWB(nm) {
  const url = `https://search.wb.ru/exactmatch/ru/common/v4/search?query=${nm}&resultset=catalog&limit=1`;

  const res = await fetchWithRetry(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json",
      "Referer": "https://www.wildberries.ru/",
      "Origin": "https://www.wildberries.ru"
    }
  });

  if (!res.ok) {
    throw new Error(`WB API вернул ${res.status}`);
  }

  const json = await res.json();

  const product = json?.data?.products?.[0];

  if (!product) {
    throw new Error("Товар не найден на WB");
  }

  const fullName =
    `${product.brand || ""} ${product.name || ""}`.trim();

  const price =
    product.salePriceU
      ? Math.round(product.salePriceU / 100)
      : null;

  const imageUrl =
    product.image
      ? `https://images.wbstatic.net/c246x328/${product.image}`
      : null;

  return {
    productName: fullName,
    priceSource: price,
    imageUrl
  };
}

// ═══════════════════════════════════════════════════════════════
//  OZON: используем их внутренний API v1 с нужными куками
//  Ozon блокирует редиректы — запрашиваем напрямую с redirect:manual
// ═══════════════════════════════════════════════════════════════
async function fetchOzon(sku) {

  const searchUrl =
    `https://www.ozon.ru/search/?text=${sku}`;

  const res = await fetchWithRetry(searchUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
      "Accept-Language": "ru-RU,ru;q=0.9",
    }
  });

  const html = await res.text();

  // Ищем title страницы
  const titleMatch =
    html.match(/<title>(.*?)<\/title>/i);

  if (!titleMatch) {
    throw new Error("Ozon не вернул название товара");
  }

  let title = titleMatch[1];

  title = title
    .replace(" — купить в интернет-магазине OZON", "")
    .replace(" – OZON", "")
    .trim();

  if (!title || /^\d+$/.test(title)) {
    throw new Error("Товар Ozon не найден");
  }

  return {
    productName: title,
    priceSource: null,
    imageUrl: null
  };
}
// ═══════════════════════════════════════════════════════════════
//  ЯНДЕКС МАРКЕТ: поиск по названию через публичный API
//  Приоритет — товары с реферальной программой (cashback=true)
// ═══════════════════════════════════════════════════════════════
async function searchYandexMarket(query) {
  if (!query || query.length < 3) {
    throw new Error("Слишком короткое название для поиска");
  }

  // Очищаем запрос — убираем лишнее
  const cleanQuery = query
    .replace(/\d{8,}/g, "")   // убираем длинные числа (артикулы)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);

  // Публичный API поиска Маркета (без ключа, но ограниченный)
  const searchUrl = `https://market.yandex.ru/api/search?text=${encodeURIComponent(cleanQuery)}&numdoc=5&pp=18&clid=${MARKET_CLID}`;

  try {
    const res = await fetchWithRetry(searchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept":     "application/json, text/plain, */*",
        "Referer":    "https://market.yandex.ru/",
      },
    });

    if (res.ok) {
      const json    = await res.json();
      const results = json?.results || json?.searchResult?.results || [];
      const item    = results[0];
      if (item) {
        return {
          marketName:  item.titles?.raw || item.name || cleanQuery,
          marketPrice: item.prices?.min?.value ? parseInt(item.prices.min.value) : null,
          marketUrl:   `https://market.yandex.ru${item.urls?.direct || "/search?text=" + encodeURIComponent(cleanQuery)}`,
          marketImage: item.pictures?.[0]?.original?.url || null,
        };
      }
    }
  } catch {}

  // Фолбэк — ссылка на поиск (всегда работает)
  return {
    marketName:  cleanQuery,
    marketPrice: null,
    marketUrl:   `https://market.yandex.ru/search?text=${encodeURIComponent(cleanQuery)}`,
    marketImage: null,
  };
}

// ═══════════════════════════════════════════════════════════════
//  Формируем реферальную ссылку
// ═══════════════════════════════════════════════════════════════
function buildRefLink(marketUrl, fallbackQuery) {
  try {
    const url = new URL(marketUrl);
    url.searchParams.set("clid", MARKET_CLID);
    url.searchParams.set("distr_type", DISTR_TYPE);
    return url.toString();
  } catch {
    return `https://market.yandex.ru/search?text=${encodeURIComponent(fallbackQuery)}&clid=${MARKET_CLID}&distr_type=${DISTR_TYPE}`;
  }
}

app.listen(PORT, () => console.log(`PricePulse API запущен на порту ${PORT}`));
