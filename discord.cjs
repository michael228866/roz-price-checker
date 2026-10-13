const shopUrl = "https://event.gnjoy.com.tw/RoZ/RoZ_ShopSearch";

function validWebhook(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" &&
      ["discord.com", "discordapp.com"].includes(parsed.hostname) &&
      /^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(parsed.pathname);
  } catch { return false; }
}

async function sendDiscord(url, alert, fetchImpl = fetch) {
  if (!validWebhook(url)) throw new Error("Discord Webhook 網址無效");
  const body = {
    content: `🚨 ROZ 疑似低價\n商品：${alert.itemName}\n商店：${alert.shop}\n價格：${alert.price.toLocaleString()} Z\n參考價：${alert.referencePrice.toLocaleString()} Z\n類型：${alert.type}\n可信度：${alert.confidence}\n${shopUrl}`,
    allowed_mentions: { parse: [] }
  };
  const response = await fetchImpl(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) {
    const error = new Error(`Discord 通知失敗：HTTP ${response.status}`);
    error.status = response.status;
    if (response.status === 429) {
      const seconds = Number(response.headers?.get?.("retry-after"));
      error.retryAfterMs = Number.isFinite(seconds) && seconds > 0
        ? Math.min(Math.ceil(seconds * 1000), 3600000) : 60000;
    }
    throw error;
  }
}

module.exports = { validWebhook, sendDiscord };
