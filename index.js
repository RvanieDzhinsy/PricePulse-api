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
  const url = `https://card.wb.ru/cards/v2/detail?appType=1&curr=rub&dest=-1257786&nm=${nm}`;
  const res  = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`WB API вернул ${res.status}`);

  const json    = await res.json();
  const product = json?.data?.products?.[0];
  if (!product)  throw new Error("Товар не найден на Wildberries");

  const brand   = product.brand || "";
  const name    = product.name  || "";
  const fullName = brand ? `${brand} ${name}` : name;
  const price   = product.salePriceU ? Math.round(product.salePriceU / 100) : null;

  // WB CDN картинка
  const vol  = Math.floor(nm / 100000);
  const part = Math.floor(nm / 1000);
  const pad  = String(vol).padStart(2, "0");
  const imageUrl = `https://basket-${pad}.wbbasket.ru/vol${vol}/part${part}/${nm}/images/c246x328/1.webp`;

  return { productName: fullName, priceSource: price, imageUrl };
}

// ═══════════════════════════════════════════════════════════════
//  OZON: их API закрыт, парсим публичную страницу товара
//  (работает без ключа, но менее надёжно)
// ═══════════════════════════════════════════════════════════════
async function fetchOzon(sku) {
  // Пробуем получить метаданные через мобильный API Ozon
  const url = `https://www.ozon.ru/api/composer-api.bff/page/json/v2?url=/product/${sku}/`;
  const res  = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15",
      "Accept":     "application/json",
    },
  });

  if (res.ok) {
    try {
      const json = await res.json();
      // Ищем название в структуре страницы
      const widgets = json?.widgetStates || {};
      for (const key of Object.keys(widgets)) {
        if (key.startsWith("webProductHeading")) {
          const data = JSON.parse(widgets[key]);
          const name  = data?.title || data?.name;
          const price = data?.price?.price ? parseInt(data.price.price.replace(/\D/g,"")) : null;
          if (name) return { productName: name, priceSource: price, imageUrl: null };
        }
      }
    } catch {}
  }

  // Фолбэк: возвращаем артикул как поисковый запрос
  return {
    productName: `Ozon артикул ${sku}`,
    priceSource: null,
    imageUrl:    null,
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
    const res = await fetch(searchUrl, {
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
