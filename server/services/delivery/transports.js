import { providerConfig, providerSecrets } from "../notifications/providers.js";

// Provider transport abstraction. Each transport receives the decoded request
// and provider configuration and returns a normalized outcome. New providers
// are added by calling `registerTransport` (or by supplying a `custom`
// transport) without changing the delivery engine, queue or worker.

const TRANSPORTS = new Map();

function outcome(ok, { response = {}, delivered = false, provider = "", error = "", errorCode = "", permanent, retryable } = {}) {
  return { ok, response, delivered, provider, error, error_code: errorCode, permanent, retryable };
}

function requireConfig(value, code, message) {
  return value ? null : outcome(false, { error: message, errorCode: code, permanent: true });
}

function genericStore(label) {
  return () => outcome(true, { response: { channel: label, stored: true }, delivered: false, provider: "store" });
}

export function registerTransport(type, handler) {
  if (!type || typeof handler !== "function") return false;
  TRANSPORTS.set(String(type), handler);
  return true;
}

export function hasTransport(type) {
  return TRANSPORTS.has(String(type));
}

export function transportTypes() {
  return [...TRANSPORTS.keys()];
}

// Chooses a transport. A real provider type wins; otherwise the channel decides
// (so an unconfigured channel still produces a well-defined failure).
export function resolveTransport(provider = {}, channel = "") {
  const type = provider.type || "";
  if (type && type !== "store" && TRANSPORTS.has(type)) return { type, handler: TRANSPORTS.get(type) };
  const channelHandler = TRANSPORTS.get(channel);
  if (channelHandler) return { type: channel, handler: channelHandler };
  return { type: "store", handler: TRANSPORTS.get("store") };
}

function providerPayload(provider, request) {
  const config = provider?.row ? providerConfig(provider.row) : {};
  const secrets = provider?.row ? providerSecrets(provider.row) : {};
  return { config, secrets, to: request.recipient_address || "", subject: request.subject || "", body: request.body || "", contentRef: request.content_ref || "" };
}

// --- Built-in transports ---------------------------------------------------

registerTransport("store", ({ request }) => outcome(true, { response: { channel: request.channel, stored: true }, delivered: request.channel === "in_app", provider: "store" }));

registerTransport("in_app", ({ request }) => outcome(true, { response: { channel: "in_app", stored: true }, delivered: true, provider: "store" }));

registerTransport("email", ({ provider, request }) => {
  const { config, secrets, to } = providerPayload(provider, request);
  if (!to && !request.content_ref) {
    return outcome(false, { error: "recipient address is required", errorCode: "invalid_recipient", permanent: true });
  }
  return outcome(true, {
    response: {
      channel: "email",
      provider: provider?.code || "store",
      to,
      from: config.from_email || "no-reply@helix.example.com",
      reply_to: config.reply_to || "",
      has_credentials: Boolean(secrets.password || secrets.api_key || secrets.client_secret),
      queued: true,
    },
    delivered: false,
    provider: provider?.code || "store",
  });
});

registerTransport("smtp", ({ provider, request }) => {
  const { config, to } = providerPayload(provider, request);
  const missing = requireConfig(config.host, "provider_not_configured", "SMTP host is not configured");
  if (missing) return missing;
  return outcome(true, {
    response: { channel: "email", transport: "smtp", to, host: config.host, port: config.port || 587, secure: Boolean(config.secure), queued: true },
    delivered: false,
    provider: provider?.code || "smtp",
  });
});

function apiTransport(label, requiredKey, requiredLabel) {
  return ({ provider, request }) => {
    const { config, secrets, to } = providerPayload(provider, request);
    const missing = requireConfig(secrets[requiredKey] || config[requiredKey], "provider_not_configured", `${requiredLabel} is not configured`);
    if (missing) return missing;
    return outcome(true, { response: { channel: request.channel, transport: label, to, accepted: true }, delivered: false, provider: provider?.code || label });
  };
}

registerTransport("sendgrid", apiTransport("sendgrid", "api_key", "SendGrid api_key"));
registerTransport("mailgun", apiTransport("mailgun", "api_key", "Mailgun api_key"));
registerTransport("postmark", apiTransport("postmark", "api_key", "Postmark api_key"));
registerTransport("ses", apiTransport("ses", "api_key", "AWS credentials"));
registerTransport("twilio", apiTransport("twilio", "api_key", "Twilio credentials"));
registerTransport("fcm", apiTransport("fcm", "api_key", "FCM credentials"));

registerTransport("graph", ({ provider, request }) => {
  const { config, secrets, to } = providerPayload(provider, request);
  const missing = requireConfig(config.tenant_id, "provider_not_configured", "Graph tenant_id is not configured")
    || requireConfig(secrets.client_secret, "provider_not_configured", "Graph client_secret is not configured");
  if (missing) return missing;
  return outcome(true, { response: { channel: request.channel, transport: "graph", to, accepted: true }, delivered: false, provider: provider?.code || "graph" });
});

function webhookTransport(label) {
  return ({ provider, request }) => {
    const { config, to } = providerPayload(provider, request);
    const missing = requireConfig(config.webhook_url, "provider_not_configured", "Webhook URL is not configured");
    if (missing) return missing;
    return outcome(true, { response: { channel: request.channel, transport: label, url: config.webhook_url, to, accepted: true }, delivered: false, provider: provider?.code || label });
  };
}

registerTransport("webhook", webhookTransport("webhook"));
registerTransport("teams", webhookTransport("teams"));
registerTransport("slack", webhookTransport("slack"));

registerTransport("sms", genericStore("sms"));
registerTransport("push", genericStore("push"));

registerTransport("custom", (context) => {
  const custom = customTransports.get(String(context.provider?.code));
  if (!custom) return outcome(false, { error: "custom transport is not registered", errorCode: "provider_not_configured", permanent: true });
  return custom(context);
});

// Per-provider custom handlers, registered by code, used by `type = custom`.
const customTransports = new Map();

export function registerCustomTransport(providerCode, handler) {
  if (!providerCode || typeof handler !== "function") return false;
  customTransports.set(String(providerCode), handler);
  return true;
}

export { outcome };
