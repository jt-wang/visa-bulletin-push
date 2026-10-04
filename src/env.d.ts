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
  /** Static assets binding ("assets.binding" in wrangler config): the card reads its fonts through it. */
  ASSETS?: Fetcher;
}

interface Env {
  /** Browser Run binding ("browser" in wrangler config): renders the share card. Optional. */
  BROWSER?: import("./card").CardBrowser;
}

interface Env {
  /** Optional deployment identity, set only in the operator's private config. */
  PUBLIC_URL?: string;
  /** Public repository URL; adds a GitHub button. */
  SOURCE_URL?: string;
  AUTHOR_NAME?: string;
  AUTHOR_X?: string;
  AUTHOR_SITE?: string;
  AUTHOR_BIO_EN?: string;
  AUTHOR_BIO_ZH?: string;
}
