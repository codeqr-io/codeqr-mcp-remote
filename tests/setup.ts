/**
 * The OAuth store picks Redis over its in-memory maps whenever these are set,
 * and caches that choice on first use. Clearing them here keeps the suite from
 * silently reading and writing a real Upstash database when the developer
 * running it happens to have credentials exported.
 */
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
