/*
 * /api/public-list is the same data hub as /api/list. Cloudflare Pages maps one
 * route per file, so this file re-exports the shared handler under the second
 * path that the stream display polls.
 */
export { onRequest } from './list.js';
