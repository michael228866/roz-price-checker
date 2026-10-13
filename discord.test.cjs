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
