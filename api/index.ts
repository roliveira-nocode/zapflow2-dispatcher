// Vercel serverless entry point.
//
// Vercel treats files under /api as serverless functions. This one simply
// re-exports the Express app defined in src/server.ts as the default handler,
// so all routes (GET /health, POST /api/dispatch) are served by the same app
// used locally. See vercel.json for the rewrite that routes every request here.
import app from "../src/server";

export default app;
