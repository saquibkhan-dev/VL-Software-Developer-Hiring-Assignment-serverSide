import express from "express";
import dotenv from "dotenv";
import helmet from "helmet";
import morgan from "morgan";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import path from "path";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(helmet());
app.use(express.json({ limit: "100kb" }));
app.use(morgan("tiny"));

const distPath = path.resolve(process.cwd(), "client", "dist");
app.use(express.static(distPath));

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn(
    "Missing SUPABASE_URL or SUPABASE_ANON_KEY. Add them to your environment to enable database access."
  );
}

const buildSupabaseClient = (authHeader) =>
  createClient(supabaseUrl, supabaseAnonKey, {
    global: authHeader ? { headers: { Authorization: authHeader } } : undefined
  });

const MAX_QUERY_LENGTH = 500;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 30;
const rateLimitStore = new Map();

const getClientIp = (req) =>
  req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;

const isRateLimited = (ip) => {
  const now = Date.now();
  const entry = rateLimitStore.get(ip);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitStore.set(ip, { windowStart: now, count: 1 });
    return false;
  }

  entry.count += 1;
  if (entry.count > RATE_LIMIT_MAX_REQUESTS) {
    return true;
  }

  return false;
};

app.post("/ask-jiji", async (req, res) => {
  const requestId = crypto.randomUUID();
  res.setHeader("X-Request-Id", requestId);

  const clientIp = getClientIp(req);
  if (clientIp && isRateLimited(clientIp)) {
    return res.status(429).json({ error: "Too many requests. Please retry later." });
  }

  const { query } = req.body || {};

  if (!query || typeof query !== "string") {
    return res.status(400).json({
      error: "Query must be a non-empty string."
    });
  }

  const trimmedQuery = query.trim();

  if (trimmedQuery.length < 3 || trimmedQuery.length > MAX_QUERY_LENGTH) {
    return res.status(400).json({
      error: `Query must be between 3 and ${MAX_QUERY_LENGTH} characters.`
    });
  }

  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(500).json({
      error: "Server misconfiguration. Missing Supabase environment variables."
    });
  }

  const authHeader = req.headers.authorization;
  const supabase = buildSupabaseClient(authHeader);

  const {
    data: { user },
    error: authError
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return res.status(401).json({
      error: "Unauthorized. Provide a valid Supabase JWT in the Authorization header."
    });
  }

  const profilePayload = {
    id: user.id,
    full_name: user.user_metadata?.full_name || null
  };

  const [{ error: profileError }, { data: resources, error: resourceError }] =
    await Promise.all([
      supabase.from("profiles").upsert(profilePayload, { onConflict: "id" }),
      supabase
        .from("resources")
        .select("id, title, description, type, storage_path")
        .or(`title.ilike.%${trimmedQuery}%,description.ilike.%${trimmedQuery}%`)
        .limit(5)
    ]);

  if (profileError) {
    return res.status(500).json({
      error: "Failed to sync profile.",
      details: profileError.message
    });
  }

  if (resourceError) {
    return res.status(500).json({
      error: "Failed to fetch resources.",
      details: resourceError.message
    });
  }

  const { error: insertError } = await supabase.from("queries").insert({
    profile_id: user.id,
    query_text: trimmedQuery
  });

  if (insertError) {
    return res.status(500).json({
      error: "Failed to save query.",
      details: insertError.message
    });
  }

  const responseText = `Here's a quick overview for: "${trimmedQuery}". Review the resources below for deeper learning.`;

  const resourcesWithLinks = (resources || []).map((resource) => {
    const { data } = supabase.storage
      .from("learning-resources")
      .getPublicUrl(resource.storage_path);

    return {
      id: resource.id,
      title: resource.title,
      description: resource.description,
      type: resource.type,
      url: data.publicUrl
    };
  });

  return res.json({
    requestId,
    answer: responseText,
    resources: resourcesWithLinks
  });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
