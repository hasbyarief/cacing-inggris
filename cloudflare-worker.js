/**
 * Cloudflare Worker — Cacing Inggris leaderboard API
 *
 * Required Worker variables:
 *   GITHUB_OWNER = hasbyarief
 *   GITHUB_REPO = cacing-inggris
 *   GITHUB_BRANCH = main
 *   ALLOWED_ORIGIN = https://hasbyarief.github.io
 *
 * Required Worker secret:
 *   GITHUB_TOKEN = fine-grained GitHub token with Contents: Read and write
 *
 * Routes:
 *   GET  /health
 *   POST /submit   JSON: { "player": "Nama", "score": 1200, "stage": 2 }
 */
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function responseJson(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...JSON_HEADERS,
      "access-control-allow-origin": origin || "null",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "Content-Type",
      "vary": "Origin",
      "cache-control": "no-store"
    }
  });
}

function decodeBase64Utf8(value) {
  const binary = atob(value.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeBase64Utf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export default {
  async fetch(request, env) {
    const requestOrigin = request.headers.get("Origin") || "";
    const allowedOrigin = env.ALLOWED_ORIGIN || "";
    const corsOrigin = requestOrigin === allowedOrigin ? allowedOrigin : "null";

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": corsOrigin,
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "Content-Type",
          "access-control-max-age": "86400",
          "vary": "Origin"
        }
      });
    }

    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return responseJson({ ok: true, service: "cacing-inggris-leaderboard" }, 200, corsOrigin);
    }

    if (url.pathname !== "/submit" || request.method !== "POST") {
      return responseJson({ ok: false, message: "Endpoint tidak ditemukan." }, 404, corsOrigin);
    }

    if (!allowedOrigin || requestOrigin !== allowedOrigin) {
      return responseJson({ ok: false, message: "Origin tidak diizinkan." }, 403, corsOrigin);
    }

    if (!env.GITHUB_TOKEN || !env.GITHUB_OWNER || !env.GITHUB_REPO) {
      return responseJson({ ok: false, message: "Konfigurasi server belum lengkap." }, 500, corsOrigin);
    }

    let input;
    try {
      input = await request.json();
    } catch {
      return responseJson({ ok: false, message: "Data pengiriman tidak valid." }, 400, corsOrigin);
    }

    const player = String(input.player || "").replace(/[<>\r\n]/g, "").trim().slice(0, 24);
    const score = Number(input.score);
    const stage = Number(input.stage);

    if (!player || !Number.isSafeInteger(score) || score < 0 ||
        !Number.isInteger(stage) || stage < 1 || stage > 10) {
      return responseJson({ ok: false, message: "Nama, skor, atau stage tidak valid." }, 400, corsOrigin);
    }

    const owner = env.GITHUB_OWNER;
    const repo = env.GITHUB_REPO;
    const branch = env.GITHUB_BRANCH || "main";
    const path = "leaderboard.json";
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

    // Fine-grained PATs contain no whitespace; remove accidental copy/paste whitespace.
    const githubToken = String(env.GITHUB_TOKEN || "").replace(/\s+/g, "");
    const headers = {
      "authorization": `Bearer ${githubToken}`,
      "accept": "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "cacing-inggris-leaderboard-worker"
    };

    // Retry on a concurrent update so two players submitting together are less likely to overwrite each other.
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const readResponse = await fetch(`${apiUrl}?ref=${encodeURIComponent(branch)}`, { headers });
        let data = { updatedAt: null, scores: [] };
        let sha;

        if (readResponse.ok) {
          const file = await readResponse.json();
          sha = file.sha;
          data = JSON.parse(decodeBase64Utf8(file.content || ""));
        } else if (readResponse.status !== 404) {
          const detail = await readResponse.text();
          return responseJson({ ok: false, message: "Tidak dapat membaca leaderboard GitHub.", detail: detail.slice(0, 300) }, 502, corsOrigin);
        }

        if (!Array.isArray(data.scores)) data.scores = [];
        const record = {
          player,
          score,
          stage,
          submittedAt: new Date().toISOString()
        };
        data.scores.push(record);
        data.scores.sort((a, b) => b.score - a.score || b.stage - a.stage);
        data.scores = data.scores.slice(0, 100);
        data.updatedAt = new Date().toISOString();

        const payload = {
          message: "Update leaderboard Cacing Inggris",
          content: encodeBase64Utf8(JSON.stringify(data, null, 2) + "\n"),
          branch
        };
        if (sha) payload.sha = sha;

        const writeResponse = await fetch(apiUrl, {
          method: "PUT",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(payload)
        });

        if (writeResponse.ok) {
          return responseJson({
            ok: true,
            message: "Skor berhasil dikirim ke papan skor online.",
            position: data.scores.findIndex((item) => item === record) + 1
          }, 200, corsOrigin);
        }

        if (writeResponse.status !== 409 && writeResponse.status !== 422) {
          const detail = await writeResponse.text();
          return responseJson({ ok: false, message: "GitHub gagal menyimpan skor.", detail: detail.slice(0, 300) }, 502, corsOrigin);
        }
      } catch (error) {
        return responseJson({ ok: false, message: "Terjadi kesalahan saat menyimpan skor.", detail: String(error).slice(0, 200) }, 502, corsOrigin);
      }
    }

    return responseJson({ ok: false, message: "Papan skor sedang menerima banyak kiriman. Coba lagi." }, 503, corsOrigin);
  }
};
