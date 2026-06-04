#!/usr/bin/env node
// Bot Enviador Google Messages v2.0
// Flujo: /start → pide .txt → pide mensaje → envía con progreso en vivo
"use strict";

const TelegramBot = require("node-telegram-bot-api");
const puppeteer   = require("puppeteer");
const fs          = require("fs");
const path        = require("path");
const https       = require("https");

// ── CONFIG ──────────────────────────────────────────────────────────────────
const TOKEN            = process.env.TELEGRAM_TOKEN || "8710402523:AAHzR-ZQ8XR_qSJSOzJ6VPFIZYD1HnLoJtA";
const ALLOWED_USERNAME = process.env.ALLOWED_USER   || "";  // vacío = sin restricción
const SESSION_DIR      = "./session_data";

// ── ANTI-BAN ────────────────────────────────────────────────────────────────
const DELAY_MIN   = 4000;
const DELAY_MAX   = 9000;
const BATCH_SIZE  = 15;
const BATCH_PAUSE = 90000;
const NAV_TIMEOUT = 30000;
const QR_TIMEOUT  = 120000;

// ── BOT ───────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(TOKEN, { polling: false });

bot.on("polling_error", async err => {
  if (err.message && err.message.includes("409")) {
    console.warn("⚠️ 409 Conflict — reiniciando limpio...");
    await bot.stopPolling().catch(() => {});
    process.exit(0);
  } else {
    console.error("polling_error:", err.message);
  }
});

async function startBot() {
  try { await bot.deleteWebhook({ drop_pending_updates: true }); } catch (_) {}
  await new Promise(r => setTimeout(r, 6000));
  await bot.startPolling();
  console.log("✅ Polling activo. Esperando /start...");
}

// ── ESTADO DE CONEXIÓN ────────────────────────────────────────────────────────
let browser    = null;
let page       = null;
let connected  = false;
let connecting = false;

// ── ESTADO POR CHAT ───────────────────────────────────────────────────────────
// Cada chatId tiene su propio estado de flujo
// state: "idle" | "wait_file" | "wait_message" | "sending"
const chatState = new Map();  // chatId → { state, phones, liveMsgId }

// Cola de envío (solo un envío a la vez globalmente)
const queue = {
  running: false,
  stop:    false,
  sent:    0,
  failed:  0,
  total:   0,
  items:   [],
  chat:    null,
  liveMsgId: null,
  startTime: null,
};

// ── HELPERS ───────────────────────────────────────────────────────────────────
const isAllowed = m => {
  if (!ALLOWED_USERNAME) return true;
  const user = (m?.from?.username || m?.username || "").toLowerCase();
  return user === ALLOWED_USERNAME.toLowerCase();
};
const sleep   = ms => new Promise(r => setTimeout(r, ms));
const rand    = (a, b) => a + Math.floor(Math.random() * (b - a));
const fmtTime = ms => {
  if (!ms || ms < 0) return "—";
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
};
const progressBar = (done, total) => {
  const filled = total > 0 ? Math.round((done / total) * 10) : 0;
  return "█".repeat(filled) + "░".repeat(10 - filled);
};

// ── EDITAR / ENVIAR MENSAJE EN VIVO ──────────────────────────────────────────
async function editOrSend(chatId, msgId, text, extra = {}) {
  if (msgId) {
    const ok = await bot.editMessageText(text, {
      chat_id: chatId, message_id: msgId,
      parse_mode: "Markdown", ...extra
    }).catch(() => null);
    if (ok) return msgId;
  }
  const m = await bot.sendMessage(chatId, text, { parse_mode: "Markdown", ...extra }).catch(() => null);
  return m ? m.message_id : null;
}

// ── PARSEAR TELÉFONOS DE .TXT ─────────────────────────────────────────────────
function parsePhones(content) {
  const phones = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/[\+]?(\d[\d\s\-]{5,})/);
    if (match) phones.push(match[1].replace(/[\s\-]/g, ""));
  }
  return [...new Set(phones)]; // sin duplicados
}

// ── DESCARGAR ARCHIVO DE TELEGRAM ─────────────────────────────────────────────
async function downloadFile(fileId) {
  const fileInfo = await bot.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${TOKEN}/${fileInfo.file_path}`;
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve(data));
      res.on("error", reject);
    }).on("error", reject);
  });
}

// ── CONEXIÓN GOOGLE MESSAGES ──────────────────────────────────────────────────
async function ensureConnected(chatId) {
  if (connected) return true;
  if (connecting) {
    await bot.sendMessage(chatId, "⏳ *Conexión en curso, espera...*", { parse_mode: "Markdown" });
    return false;
  }
  return await connectGM(chatId);
}

async function connectGM(chatId) {
  if (connecting) return false;
  connecting = true;

  const waitMsg = await bot.sendMessage(chatId,
    "🔄 *Iniciando Google Messages Web...*\n_Puede tardar hasta 20 segundos_",
    { parse_mode: "Markdown" }
  ).catch(() => null);

  try {
    if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox", "--disable-setuid-sandbox",
        "--disable-dev-shm-usage", "--disable-gpu",
        "--window-size=1280,800"
      ],
      userDataDir: path.resolve(SESSION_DIR),
    });

    const pages = await browser.pages();
    page = pages[0] || await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );
    await page.setViewport({ width: 1280, height: 800 });

    await page.goto("https://messages.google.com/web/authentication", {
      waitUntil: "networkidle2", timeout: NAV_TIMEOUT
    });

    // ¿Sesión ya activa?
    if (page.url().includes("/conversations")) {
      connected  = true;
      connecting = false;
      if (waitMsg) bot.deleteMessage(chatId, waitMsg.message_id).catch(() => {});
      await bot.sendMessage(chatId, "✅ *Sesión restaurada automáticamente*", { parse_mode: "Markdown" });
      return true;
    }

    // Esperar QR
    if (waitMsg) {
      await bot.editMessageText("📷 *Generando código QR...*", {
        chat_id: chatId, message_id: waitMsg.message_id, parse_mode: "Markdown"
      }).catch(() => {});
    }

    await page.waitForSelector("canvas", { timeout: 20000 }).catch(() => {});
    const qrDataUrl = await page.evaluate(() => {
      const canvas = document.querySelector("canvas");
      if (canvas) return canvas.toDataURL("image/png");
      const img = document.querySelector("img[src^='data:image']");
      return img ? img.src : null;
    });

    if (!qrDataUrl) throw new Error("No se encontró el código QR en la página");

    const base64 = qrDataUrl.replace(/^data:image\/\w+;base64,/, "");
    const qrBuf  = Buffer.from(base64, "base64");

    if (waitMsg) bot.deleteMessage(chatId, waitMsg.message_id).catch(() => {});

    const qrMsg = await bot.sendPhoto(chatId, qrBuf, {
      caption:
        "📱 *Escanea este QR con tu Android*\n\n" +
        "1️⃣ Abre *Google Messages* en tu teléfono\n" +
        "2️⃣ Toca ⋮ → *Dispositivos vinculados*\n" +
        "3️⃣ Toca *Vincular nuevo dispositivo*\n" +
        "4️⃣ Escanea el código\n\n" +
        "⏳ _Tienes 2 minutos. Después del QR el envío empezará automáticamente._",
      parse_mode: "Markdown",
    }).catch(() => null);

    await page.waitForFunction(
      () => window.location.href.includes("/conversations"),
      { timeout: QR_TIMEOUT }
    );

    connected  = true;
    connecting = false;
    if (qrMsg) bot.deleteMessage(chatId, qrMsg.message_id).catch(() => {});
    await bot.sendMessage(chatId, "✅ *¡Android vinculado! Iniciando envío...*", { parse_mode: "Markdown" });
    return true;

  } catch (e) {
    connecting = false;
    if (browser) { try { await browser.close(); } catch (_) {} browser = null; page = null; }
    await bot.sendMessage(chatId,
      `❌ *Error al conectar:* \`${e.message.slice(0, 150)}\`\n\nUsa /start para reintentar.`,
      { parse_mode: "Markdown" }
    );
    return false;
  }
}

// ── ENVIAR UN SMS ─────────────────────────────────────────────────────────────
async function sendOneSMS(phone, message) {
  if (!connected || !page) throw new Error("No hay dispositivo conectado");
  const num = phone.trim().replace(/\s+/g, "");

  await page.goto("https://messages.google.com/web/conversations/new", {
    waitUntil: "networkidle2", timeout: NAV_TIMEOUT
  });

  const inputSel = [
    'input[type="tel"]',
    'mw-contact-chips-input input',
    'input[placeholder]',
  ].join(", ");

  await page.waitForSelector(inputSel, { timeout: 12000 });
  await page.click(inputSel);
  await page.type(inputSel, num, { delay: 80 });
  await sleep(1200);
  await page.keyboard.press("Enter");
  await sleep(1500);

  const textSel = [
    'div[contenteditable="true"][aria-label]',
    'textarea.message-input',
    'div[contenteditable="true"]',
  ].join(", ");

  await page.waitForSelector(textSel, { timeout: 12000 });
  await page.click(textSel);
  for (const chunk of message.match(/.{1,50}/g) || [message]) {
    await page.type(textSel, chunk, { delay: 30 });
  }
  await sleep(600);

  const sendBtn = await page.$('button[aria-label="Enviar mensaje"], button[aria-label="Send message"]');
  if (sendBtn) await sendBtn.click();
  else         await page.keyboard.press("Enter");

  await sleep(1000);
  return true;
}

// ── TECLADO DETENER ───────────────────────────────────────────────────────────
const stopKeyboard = () => ({
  reply_markup: {
    inline_keyboard: [[{ text: "⛔ Detener envío", callback_data: "stop_send" }]]
  }
});
const doneKeyboard = () => ({
  reply_markup: {
    inline_keyboard: [[{ text: "🔄 Nuevo envío", callback_data: "new_send" }]]
  }
});

// ── COLA DE ENVÍO ─────────────────────────────────────────────────────────────
async function runQueue() {
  queue.running   = true;
  queue.stop      = false;
  queue.sent      = 0;
  queue.failed    = 0;
  queue.startTime = Date.now();
  const chatId    = queue.chat;
  const total     = queue.items.length;

  // Mensaje inicial en vivo
  const buildText = (extra = "") => {
    const done    = queue.sent + queue.failed;
    const pct     = total > 0 ? ((done / total) * 100).toFixed(1) : "0.0";
    const bar     = progressBar(done, total);
    const elapsed = Date.now() - queue.startTime;
    return (
      `📤 *Enviando mensajes...*\n\n` +
      `\`[${bar}]\` ${pct}%\n\n` +
      `✅ Enviados:   *${queue.sent}*\n` +
      `❌ Fallidos:   *${queue.failed}*\n` +
      `📋 Pendientes: *${total - done}*\n` +
      `📊 Total:      *${total}*\n` +
      `⏱️ Tiempo:     *${fmtTime(elapsed)}*` +
      (extra ? `\n\n${extra}` : "")
    );
  };

  // Enviar mensaje de progreso inicial
  const initMsg = await bot.sendMessage(chatId, buildText(), {
    parse_mode: "Markdown",
    ...stopKeyboard()
  }).catch(() => null);
  queue.liveMsgId = initMsg ? initMsg.message_id : null;

  for (let i = 0; i < queue.items.length; ) {
    if (queue.stop) break;

    const item = queue.items[i];
    try {
      await sendOneSMS(item.phone, item.message);
      queue.sent++;
    } catch (e) {
      queue.failed++;
      if (!connected) {
        queue.liveMsgId = await editOrSend(chatId, queue.liveMsgId,
          buildText("⚠️ _Conexión perdida, reintentando..._"), stopKeyboard()
        );
        await sleep(5000);
        if (!connected) break;
      }
    }
    i++;

    // Actualizar mensaje de progreso
    queue.liveMsgId = await editOrSend(chatId, queue.liveMsgId,
      buildText(), stopKeyboard()
    );

    if (i < queue.items.length && !queue.stop) {
      // Pausa larga anti-ban cada BATCH_SIZE
      if (queue.sent > 0 && queue.sent % BATCH_SIZE === 0) {
        queue.liveMsgId = await editOrSend(chatId, queue.liveMsgId,
          buildText(`🛡️ _Pausa anti-ban ${fmtTime(BATCH_PAUSE)}..._`), stopKeyboard()
        );
        const steps = Math.ceil(BATCH_PAUSE / 3000);
        for (let s = 0; s < steps; s++) {
          if (queue.stop) break;
          await sleep(3000);
        }
      } else {
        await sleep(rand(DELAY_MIN, DELAY_MAX));
      }
    }
  }

  queue.running = false;
  const elapsed = Date.now() - queue.startTime;
  const done    = queue.sent + queue.failed;
  const pct     = total > 0 ? ((done / total) * 100).toFixed(1) : "0.0";
  const bar     = progressBar(done, total);
  const finalTxt = (
    (queue.stop ? "⛔ *Envío detenido*" : "✅ *Envío completado*") + `\n\n` +
    `\`[${bar}]\` ${pct}%\n\n` +
    `✅ Enviados:   *${queue.sent}*\n` +
    `❌ Fallidos:   *${queue.failed}*\n` +
    `📊 Total:      *${total}*\n` +
    `⏱️ Duración:   *${fmtTime(elapsed)}*`
  );

  await editOrSend(chatId, queue.liveMsgId, finalTxt, doneKeyboard());
  queue.liveMsgId = null;
  queue.items     = [];

  // Resetear estado del chat
  const st = chatState.get(chatId) || {};
  st.state = "idle";
  chatState.set(chatId, st);
}

// ── INICIAR PROCESO DE ENVÍO ──────────────────────────────────────────────────
async function startSending(chatId) {
  const st = chatState.get(chatId);
  if (!st || !st.phones || !st.message) return;

  // Conectar si no está conectado
  const ok = await ensureConnected(chatId);
  if (!ok) {
    // el usuario necesita escanear QR; después de conectar, proceder
    // Guardaremos un flag para reanudar tras la conexión
    st.pendingSend = true;
    chatState.set(chatId, st);
    return;
  }

  if (queue.running) {
    await bot.sendMessage(chatId,
      "⚠️ *Ya hay un envío en curso.*\nEspera a que termine o pulsa Detener.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  queue.items = st.phones.map(p => ({ phone: p, message: st.message }));
  queue.total = st.phones.length;
  queue.chat  = chatId;
  st.state    = "sending";
  chatState.set(chatId, st);

  runQueue().catch(async e => {
    queue.running = false;
    await bot.sendMessage(chatId,
      `💥 *Error crítico:* \`${e.message.slice(0, 200)}\`\n\nUsa /start para reintentar.`,
      { parse_mode: "Markdown" }
    );
    const s = chatState.get(chatId) || {};
    s.state = "idle";
    chatState.set(chatId, s);
  });
}

// ── MENSAJES ──────────────────────────────────────────────────────────────────
bot.on("message", async m => {
  if (!m) return;
  const chatId = m.chat.id;

  // Control de acceso
  if (!isAllowed(m)) {
    await bot.sendMessage(chatId, "🚫 *Acceso denegado*", { parse_mode: "Markdown" });
    return;
  }

  // /start
  if (m.text === "/start") {
    const st = chatState.get(chatId) || {};
    if (queue.running && queue.chat === chatId) {
      await bot.sendMessage(chatId, "⚠️ *Hay un envío en curso.*\nUsa el botón ⛔ Detener para pararlo.", { parse_mode: "Markdown" });
      return;
    }
    st.state = "wait_file";
    st.phones = null;
    st.message = null;
    chatState.set(chatId, st);
    await bot.sendMessage(chatId,
      "👋 *¡Hola! Bot Enviador Google Messages v2.0*\n\n" +
      "📎 *Paso 1/2:* Envíame el archivo *.txt* con los números de teléfono\n" +
      "_Un número por línea. Ejemplo:_\n" +
      "```\n+34600123456\n+34611223344\n600987654\n```",
      { parse_mode: "Markdown" }
    );
    return;
  }

  // /parar
  if (m.text === "/parar" || m.text === "/stop") {
    if (queue.running) {
      queue.stop = true;
      await bot.sendMessage(chatId, "⛔ *Deteniendo envío...*", { parse_mode: "Markdown" });
    } else {
      await bot.sendMessage(chatId, "ℹ️ No hay ningún envío en curso.", { parse_mode: "Markdown" });
    }
    return;
  }

  const st = chatState.get(chatId) || { state: "idle" };

  // ── Esperando archivo .txt ────────────────────────────────────────────────
  if (st.state === "wait_file") {
    if (!m.document) {
      await bot.sendMessage(chatId,
        "📎 Por favor, envíame el archivo *.txt* con los números.\n_Un número por línea._\n\nEscribe /start para reiniciar.",
        { parse_mode: "Markdown" }
      );
      return;
    }

    const doc = m.document;
    if (!doc.file_name?.toLowerCase().endsWith(".txt")) {
      await bot.sendMessage(chatId,
        "❌ *Solo se aceptan archivos .txt*\nEnvíame el archivo correcto.",
        { parse_mode: "Markdown" }
      );
      return;
    }

    try {
      const content = await downloadFile(doc.file_id);
      const phones  = parsePhones(content);

      if (!phones.length) {
        await bot.sendMessage(chatId,
          "❌ *No se encontraron números válidos en el archivo.*\n" +
          "Asegúrate de que hay un número por línea y vuelve a enviarlo.",
          { parse_mode: "Markdown" }
        );
        return;
      }

      st.phones = phones;
      st.state  = "wait_message";
      chatState.set(chatId, st);

      await bot.sendMessage(chatId,
        `✅ *Archivo recibido*\n📊 *${phones.length.toLocaleString()} números* encontrados\n\n` +
        `✉️ *Paso 2/2:* Escribe el mensaje que quieres enviar a todos:`,
        { parse_mode: "Markdown" }
      );
    } catch (e) {
      await bot.sendMessage(chatId,
        `❌ *Error al leer el archivo:* \`${e.message}\`\n\nUsa /start para reintentar.`,
        { parse_mode: "Markdown" }
      );
    }
    return;
  }

  // ── Esperando mensaje de texto ────────────────────────────────────────────
  if (st.state === "wait_message") {
    if (!m.text || !m.text.trim()) {
      await bot.sendMessage(chatId,
        "❌ *El mensaje no puede estar vacío.* Escribe el texto que quieres enviar:",
        { parse_mode: "Markdown" }
      );
      return;
    }

    st.message = m.text.trim();
    st.state   = "sending";
    chatState.set(chatId, st);

    await bot.sendMessage(chatId,
      `✅ *Mensaje guardado*\n\n` +
      `📱 Números: *${st.phones.length.toLocaleString()}*\n` +
      `✉️ Mensaje: _${st.message.slice(0, 60)}${st.message.length > 60 ? "..." : ""}_\n\n` +
      `🚀 Iniciando envío...`,
      { parse_mode: "Markdown" }
    );

    await startSending(chatId);
    return;
  }

  // ── Estado idle / otros ───────────────────────────────────────────────────
  if (st.state === "sending" || queue.running) {
    await bot.sendMessage(chatId,
      "📤 *Envío en curso.* Usa el botón ⛔ Detener para pararlo.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  // Por defecto → redirigir a /start
  await bot.sendMessage(chatId,
    "👋 Escribe /start para comenzar.",
    { parse_mode: "Markdown" }
  );
});

// ── CALLBACKS ─────────────────────────────────────────────────────────────────
bot.on("callback_query", async q => {
  const chatId = q.message.chat.id;
  const data   = q.data;
  bot.answerCallbackQuery(q.id).catch(() => {});

  if (!isAllowed(q)) {
    await bot.sendMessage(chatId, "🚫 *Acceso denegado*", { parse_mode: "Markdown" });
    return;
  }

  if (data === "stop_send") {
    if (queue.running) {
      queue.stop = true;
      // Editar el botón para mostrar "Deteniendo..."
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [[{ text: "⏳ Deteniendo...", callback_data: "noop" }]] },
        { chat_id: chatId, message_id: q.message.message_id }
      ).catch(() => {});
    }
    return;
  }

  if (data === "new_send") {
    const st = chatState.get(chatId) || {};
    st.state   = "wait_file";
    st.phones  = null;
    st.message = null;
    chatState.set(chatId, st);
    await bot.sendMessage(chatId,
      "📎 *Nuevo envío*\n\nEnvíame el archivo *.txt* con los números de teléfono:",
      { parse_mode: "Markdown" }
    );
    return;
  }
});

// ── SHUTDOWN ──────────────────────────────────────────────────────────────────
async function shutdown(sig) {
  console.log(`[${sig}] Cerrando...`);
  if (queue.running) queue.stop = true;
  if (browser) { try { await browser.close(); } catch (_) {} }
  try { bot.stopPolling(); } catch (_) {}
  process.exit(0);
}
process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException",  e => console.error("[FATAL]", e.message));
process.on("unhandledRejection", r => console.error("[FATAL]", r));

// ── MAIN ──────────────────────────────────────────────────────────────────────
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
console.log("═══ Google Messages Sender Bot v2.0 ═══");
console.log("Esperando 6s para evitar conflicto de instancias...");
startBot();
