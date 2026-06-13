const botToken = process.env.BOT_TOKEN;
const webhookUrl = process.env.WEBHOOK_URL;
const webhookSecret = process.env.WEBHOOK_SECRET;

if (!botToken) {
  throw new Error("BOT_TOKEN is required");
}

if (!webhookUrl) {
  throw new Error("WEBHOOK_URL is required, for example https://bot.example.com/telegram/webhook");
}

const response = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url: webhookUrl,
    secret_token: webhookSecret || undefined,
    drop_pending_updates: true,
    allowed_updates: ["message", "edited_message"],
  }),
});

const payload = await response.json();

if (!response.ok || !payload.ok) {
  console.error(payload);
  throw new Error("Telegram setWebhook failed");
}

console.log(`Telegram webhook configured: ${webhookUrl}`);
