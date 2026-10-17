// scripts/fetch-telegram.mjs
//
// Holt neue Bilder aus einem Telegram-Channel (per Bot), verkleinert sie und
// trägt sie in website/feed.json ein. Läuft in GitHub Actions (siehe telegram-feed.yml).
//
// Benötigt: Node 20+, das Paket "sharp" (wird im Workflow installiert)
// Umgebungsvariablen:
//   TELEGRAM_BOT_TOKEN   (Pflicht)  Token von @BotFather
//   TELEGRAM_CHANNEL_ID  (optional) nur Posts aus diesem Channel übernehmen, z. B. -1001234567890

import fs from "node:fs/promises";
import sharp from "sharp";

// ---------- Einstellungen ----------
const OUT_DIR = "website/images";
const THUMB_DIR = "website/images/thumbs";
const FEED_FILE = "website/feed.json";
const STATE_FILE = "telegram-state.json"; // liegt bewusst außerhalb von website/

const FULL_SIZE = 2000; // längste Seite der großen Version in px
const FULL_QUALITY = 82; // JPEG-Qualität groß
const THUMB_SIZE = 800; // längste Seite der Vorschau in px
const THUMB_QUALITY = 78; // JPEG-Qualität Vorschau
// -----------------------------------

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ONLY_CHANNEL = (process.env.TELEGRAM_CHANNEL_ID || "").trim();

if (!TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN fehlt (GitHub-Secret anlegen).");
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;
const FILE_API = `https://api.telegram.org/file/bot${TOKEN}`;

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

async function api(method, params = {}) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.ok) {
    const err = new Error(`Telegram ${method}: ${data.description}`);
    err.telegram = data;
    throw err;
  }
  return data.result;
}

// Dauerhafte Fehler (z. B. "file is too big"): Bild überspringen.
// Vorübergehende Fehler (Netzwerk, 5xx, 429): Lauf abbrechen, nächster Cron-Lauf versucht es erneut.
function isPermanent(err) {
  const code = err.telegram?.error_code;
  return code >= 400 && code < 500 && code !== 429;
}

// Findet das Bild in einem Channel-Post: entweder als Foto (komprimiert)
// oder als Datei (Original, "als Datei senden").
function pickImage(msg) {
  if (msg.photo?.length) {
    const largest = msg.photo.reduce((a, b) =>
      a.width * a.height >= b.width * b.height ? a : b
    );
    return largest.file_id;
  }
  if (msg.document?.mime_type?.startsWith("image/")) {
    return msg.document.file_id;
  }
  return null;
}

async function download(fileId) {
  const file = await api("getFile", { file_id: fileId });
  const res = await fetch(`${FILE_API}/${file.file_path}`);
  if (!res.ok) throw new Error(`Download fehlgeschlagen (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

async function makeVersions(buffer) {
  // rotate() wendet die EXIF-Ausrichtung an; Metadaten (z. B. GPS) werden nicht übernommen.
  const base = sharp(buffer).rotate().flatten({ background: "#ffffff" });

  const full = await base
    .clone()
    .resize({ width: FULL_SIZE, height: FULL_SIZE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: FULL_QUALITY, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  const thumb = await base
    .clone()
    .resize({ width: THUMB_SIZE, height: THUMB_SIZE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: THUMB_QUALITY, mozjpeg: true })
    .toBuffer();

  return {
    fullBuffer: full.data,
    thumbBuffer: thumb,
    width: full.info.width,
    height: full.info.height,
  };
}

async function main() {
  await fs.mkdir(THUMB_DIR, { recursive: true });

  const state = await readJson(STATE_FILE, { lastUpdateId: 0 });
  const feed = await readJson(FEED_FILE, { updated: null, items: [] });
  const known = new Set(feed.items.map((item) => item.id));

  // Nur bis lastUpdateId bestätigen wir bei Telegram – neuere Updates bleiben dort erhalten,
  // bis der Stand committet ist. Bricht ein Lauf ab, geht also nichts verloren.
  const updates = await api("getUpdates", {
    offset: state.lastUpdateId + 1,
    limit: 100,
    timeout: 0,
    allowed_updates: ["channel_post"],
  });

  console.log(`${updates.length} neue(s) Update(s) von Telegram.`);
  let added = 0;

  for (const update of updates) {
    const msg = update.channel_post;
    if (!msg) continue;

    const chatId = String(msg.chat.id);
    console.log(`Post ${msg.message_id} aus Channel ${chatId} (${msg.chat.title ?? "ohne Titel"})`);

    if (ONLY_CHANNEL && chatId !== ONLY_CHANNEL) {
      console.log("  -> anderer Channel, übersprungen");
      continue;
    }

    const fileId = pickImage(msg);
    if (!fileId) {
      console.log("  -> kein Bild, übersprungen");
      continue;
    }

    const id = `${chatId}_${msg.message_id}`;
    if (known.has(id)) continue;

    let buffer;
    try {
      buffer = await download(fileId);
    } catch (err) {
      if (isPermanent(err)) {
        console.warn(`  -> Bild nicht abrufbar (${err.message}), übersprungen`);
        continue;
      }
      throw err;
    }

    let versions;
    try {
      versions = await makeVersions(buffer);
    } catch (err) {
      console.warn(`  -> Bild nicht lesbar (${err.message}), übersprungen`);
      continue;
    }

    const iso = new Date(msg.date * 1000).toISOString();
    const stamp = iso.replace(/[-:]/g, "").slice(0, 15); // z. B. 20261016T123045
    const name = `${stamp}-${msg.message_id}.jpg`;

    await fs.writeFile(`${OUT_DIR}/${name}`, versions.fullBuffer);
    await fs.writeFile(`${THUMB_DIR}/${name}`, versions.thumbBuffer);

    feed.items.push({
      id,
      date: iso,
      src: `/images/${name}`,
      thumb: `/images/thumbs/${name}`,
      width: versions.width,
      height: versions.height,
    });
    known.add(id);
    added += 1;
    console.log(`  -> gespeichert als ${name}`);
  }

  if (added > 0) {
    feed.items.sort((a, b) => b.date.localeCompare(a.date)); // neueste zuerst
    feed.updated = new Date().toISOString();
  }
  await fs.writeFile(FEED_FILE, JSON.stringify(feed, null, 2) + "\n");

  if (updates.length > 0) {
    state.lastUpdateId = Math.max(...updates.map((u) => u.update_id));
  }
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n");

  console.log(`Fertig: ${added} Bild(er) hinzugefügt.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
