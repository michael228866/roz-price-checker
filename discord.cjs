const shopUrl = "https://event.gnjoy.com.tw/RoZ/RoZ_ShopSearch";
const { UNKNOWN_LOCATION, navigationCommand } = require("./shop_location.cjs");

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
  const location = alert.location ?? alert;
  const navigation = navigationCommand(location);
  const locationText = navigation
    ? `${location.mapName} ${location.x}/${location.y}` : UNKNOWN_LOCATION;
  const body = {
    content: `🚨 ROZ ${alert.confidence === "HIGH" && alert.sampleCount >= 5 ? "高信心低價" : "一般低價"}\n商品：${alert.itemName}\n商店：${alert.shop}\n價格：${alert.price.toLocaleString()} Z\n參考價：${alert.referencePrice.toLocaleString()} Z\n樣本數：${alert.sampleCount ?? 0}\n類型：${alert.type}\n可信度：${alert.confidence}\n商店位置：${locationText}${navigation ? `\n導航指令：\n\`\`\`text\n${navigation}\n\`\`\`` : ""}\n${shopUrl}`,
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
