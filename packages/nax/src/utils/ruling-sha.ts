/** Durable abbreviated commit grammar shared by sidecars and PR echoes. */
export const RULING_SHA_SOURCE = "[0-9a-fA-F]{7,40}";
export const RULING_SHA_PATTERN = new RegExp(`^${RULING_SHA_SOURCE}$`);
