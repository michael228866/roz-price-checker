const test = require("node:test");
const assert = require("node:assert/strict");
const { validWebhook, sendDiscord } = require("./discord.cjs");

test("accepts only Discord webhook endpoints and suppresses mentions", async () => {
  const url = "https://discord.com/api/webhooks/123/Abc_123";
  assert.equal(validWebhook(url), true);
  assert.equal(validWebhook("https://example.com/api/webhooks/123/Abc_123"), false);
  let sent;
  await sendDiscord(url, { itemName: "@everyone", shop: "A", price: 100, referencePrice: 1000,
    type: "POSSIBLE_MISSING_ZERO", confidence: "MEDIUM" }, async (_url, options) => {
    sent = JSON.parse(options.body);
    return { ok: true };
  });
  assert.deepEqual(sent.allowed_mentions.parse, []);
});

test("HTTP 429 preserves the retry delay for the outbox", async () => {
  await assert.rejects(sendDiscord("https://discord.com/api/webhooks/123/Abc_123",
    { itemName: "Item", shop: "A", price: 100, referencePrice: 1000,
      type: "LOW", confidence: "MEDIUM" }, async () => ({
      ok: false, status: 429, headers: { get: () => "2.5" }
    })), (error) => error.status === 429 && error.retryAfterMs === 2500);
});

test("Discord shows verified coordinates in a separate navigation code block", async () => {
  const url = "https://discord.com/api/webhooks/123/Abc_123";
  const alert = { itemName: "Sword", shop: "Same Name", price: 100,
    referencePrice: 1000, type: "LOW", confidence: "MEDIUM",
    location: { mapName: "prontera", x: 162, y: 92 } };
  let content;
  const mock = async (_url, options) => {
    content = JSON.parse(options.body).content;
    return { ok: true };
  };
  await sendDiscord(url, alert, mock);
  assert.match(content, /商店位置：prontera 162\/92/);
  assert.match(content, /導航指令：\n```text\n\/navi prontera 162\/92\n```/);
  await sendDiscord(url, { ...alert, location: null }, mock);
  assert.match(content, /尚未取得商店位置/);
  assert.doesNotMatch(content, /\/navi/);
});

test("notification distinguishes high-confidence and ordinary bargains", async () => {
  let content;
  const send = async (_url, options) => {
    content = JSON.parse(options.body).content;
    return { ok: true };
  };
  const alert = { itemName: "Sword", shop: "Shop", price: 100,
    referencePrice: 1000, type: "POSSIBLE_MISSING_ZERO", confidence: "HIGH",
    sampleCount: 5 };
  await sendDiscord("https://discord.com/api/webhooks/123/Abc_123", alert, send);
  assert.match(content, /高信心低價/);
  await sendDiscord("https://discord.com/api/webhooks/123/Abc_123",
    { ...alert, confidence: "MEDIUM", sampleCount: 3 }, send);
  assert.match(content, /一般低價/);
});
