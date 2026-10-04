// Optional secret, not listed in wrangler.jsonc `secrets.required`, so `wrangler types` does not emit it.
interface Env {
  /** Salt for hashing client IPs (registration rate limit). Optional but recommended. */
  IP_HASH_SALT?: string;
}

interface Env {
  /** Optional private alert channel for the scheduled poll (Telegram Bot API). */
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

interface Env {
  /** Optional deployment identity, set only in the operator's private config. */
  PUBLIC_URL?: string;
  AUTHOR_NAME?: string;
  AUTHOR_X?: string;
  AUTHOR_SITE?: string;
  AUTHOR_BIO_EN?: string;
  AUTHOR_BIO_ZH?: string;
}
