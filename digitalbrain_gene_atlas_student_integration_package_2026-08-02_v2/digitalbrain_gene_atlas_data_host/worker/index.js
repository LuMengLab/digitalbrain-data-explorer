export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    const sourceUrl = new URL(request.url);
    if (!sourceUrl.pathname.startsWith("/api/data/")) {
      return new Response("Not found", {
        status: 404,
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }
    sourceUrl.pathname = sourceUrl.pathname.replace(/^\/api\/data\//, "/data/");
    const response = await env.ASSETS.fetch(new Request(sourceUrl, request));
    const headers = new Headers(response.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Cross-Origin-Resource-Policy", "cross-origin");
    if (response.ok) {
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
