#!/usr/bin/env node
// Bot Enviador Google Messages v1.0
// Envía SMS a través de tu Android vinculado con Google Messages Web
"use strict";

const TelegramBot = require("node-telegram-bot-api");
const puppeteer   = require("puppeteer");
const fs          = require("fs");
const path        = require("path");

// ── CONFIG ──────────────────────────────────────────────────────────────────
const TOKEN            = process.env.TELEGRAM_TOKEN || "8710402523:AAHzR-ZQ8XR_qSJSOzJ6VPFIZYD1HnLoJtA";
const ALLOWED_USERNAME = process.env.ALLOWED_USER   || "K11000K";
const SESSION_DIR      = "./session_data";   // datos de sesión persistentes
const LISTS_DIR        = "./listas";         // listas de números .txt

// ── ANTI-BAN ────────────────────────────────────────────────────────────────
const DELAY_MIN   = 4000;   // ms mínimo entre mensajes
const DELAY_MAX   = 9000;   // ms máximo entre mensajes
const BATCH_SIZE  = 15;     // mensajes por lote antes de pausa larga
const BATCH_PAUSE = 90000;  // pausa entre lotes (ms)
const NAV_TIMEOUT = 30000;  // timeout de navegación (ms)
const QR_TIMEOUT  = 120000; // tiempo máximo para escanear QR (ms)

// ── ESTADO GLOBAL ────────────────────────────────────────────────────────────
// Arrancamos SIN polling automático para controlarlo manualmente
const bot = new TelegramBot(TOKEN, { polling: false });

// En 409 salimos limpiamente — Railway reiniciará el contenedor
// y para entonces el despliegue anterior ya habrá muerto
bot.on("polling_error", async err => {
  if (err.message && err.message.includes("409")) {
    console.warn("⚠️  409 Conflict: saliendo para que Railway reinicie limpio...");
    await bot.stopPolling().catch(() => {});
    process.exit(0);
  } else {
    console.error("polling_error:", err.message);
  }
});

// Función de arranque con delay para sobrevivir rolling deploys
async function startBot() {
  // Eliminar webhook + descartar mensajes acumulados (limpia sesión anterior)
  try { await bot.deleteWebhook({ drop_pending_updates: true }); } catch (_) {}
  // Dar 6 segundos para que Railway mate el contenedor viejo
  await new Promise(r => setTimeout(r, 6000));
  await bot.startPolling({ polling: true });
}
let browser     = null;
let page        = null;
let connected   = false;
let connecting  = false;

// Cola de envío
const queue = {
  items: [],    // [{ phone, message }]
  on: false,
  stop: false,
  sent: 0,
  failed: 0,
  total: 0,
  chat: null,
  start: null,
  currentMsg: ""
};

// Espera de texto de mensaje
const waitMsg   = new Map(); // chatId → { phone?, listFile? }
const waitList  = new Map(); // chatId → pendiente de archivo

// Live message
let liveMsgId   = null;
let liveMsgChat = null;

// Dirs
for (const d of [SESSION_DIR, LISTS_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ── HELPERS ──────────────────────────────────────────────────────────────────
const isAllowed  = m => m?.from?.username === ALLOWED_USERNAME || m?.username === ALLOWED_USERNAME;
const sleep      = ms => new Promise(r => setTimeout(r, ms));
const rand       = (a, b) => a + Math.floor(Math.random() * (b - a));
const fmtTime    = ms => {
  if (!ms || ms < 0) return "—";
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s % 60}s`;
};

// ── LIVE SEND ────────────────────────────────────────────────────────────────
async function live(chat, txt, ex = {}) {
  const rm = ex?.reply_markup;
  if (liveMsgId && liveMsgChat === chat) {
    const ok = await bot.editMessageText(txt, {
      chat_id: chat, message_id: liveMsgId,
      parse_mode: "Markdown", reply_markup: rm || undefined
    }).catch(() => null);
    if (ok) return ok;
  }
  const m = await bot.sendMessage(chat, txt, { parse_mode: "Markdown", ...ex }).catch(() => null);
  if (m) { liveMsgId = m.message_id; liveMsgChat = chat; }
  return m;
}

// ── TECLADOS ─────────────────────────────────────────────────────────────────
const kb = {
  main: () => {
    const rows = [];
    if (!connected) {
      rows.push([{ text: "📱 Conectar Android", callback_data: "connect" }]);
    } else {
      rows.push([{ text: "📱 Android vinculado ✅", callback_data: "conn_info" }]);
    }
    rows.push([{ text: "✉️ Enviar a un número",   callback_data: "send_single" }]);
    rows.push([{ text: "📋 Enviar a una lista",    callback_data: "send_list"   }]);
    rows.push([{ text: "📊 Estado de envío",       callback_data: "queue_status"}]);
    rows.push([{ text: "🗂️ Mis listas",            callback_data: "my_lists"   }]);
    if (connected) rows.push([{ text: "🔌 Desconectar", callback_data: "disconnect" }]);
    return { reply_markup: { inline_keyboard: rows } };
  },
  cancel:  () => ({ inline_keyboard: [[{ text: "❌ Cancelar", callback_data: "cancel_connect" }]] }),
  running: () => ({ reply_markup: { inline_keyboard: [[
    { text: "📊 Estado",   callback_data: "queue_status" },
    { text: "⛔ Detener", callback_data: "stop_send"     }
  ]] }}),
  done: () => ({ reply_markup: { inline_keyboard: [
    [{ text: "✉️ Nuevo envío", callback_data: "send_single" }],
    [{ text: "📋 Enviar lista", callback_data: "send_list"   }],
    [{ text: "🏠 Menú",         callback_data: "main"         }],
  ]}}),
};

// ── CONEXIÓN GOOGLE MESSAGES ──────────────────────────────────────────────────
async function connectGM(chat) {
  if (connecting) { await live(chat, "⏳ *Conexión en curso, espera...*"); return; }
  if (connected)  { await live(chat, "✅ *Ya está conectado*", kb.main()); return; }

  connecting = true;
  await live(chat, "🔄 *Iniciando Google Messages Web...*\n_Puede tardar hasta 20 segundos_");

  try {
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
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/124.0.0.0 Safari/537.36"
    );
    await page.setViewport({ width: 1280, height: 800 });

    await page.goto("https://messages.google.com/web/authentication", {
      waitUntil: "networkidle2", timeout: NAV_TIMEOUT
    });

    // ¿Sesión ya activa?
    const url = page.url();
    if (url.includes("/conversations")) {
      connected  = true;
      connecting = false;
      await live(chat, "✅ *Sesión restaurada automáticamente*\n🟢 Google Messages listo", kb.main());
      return;
    }

    await live(chat, "📷 *Generando código QR...*\n_Espera un momento_");

    // Esperar canvas del QR
    await page.waitForSelector("canvas", { timeout: 20000 }).catch(() => {});

    const qrDataUrl = await page.evaluate(() => {
      const canvas = document.querySelector("canvas");
      return canvas ? canvas.toDataURL("image/png") : null;
    });

    if (!qrDataUrl) {
      // Intentar con img
      const imgSrc = await page.evaluate(() => {
        const img = document.querySelector("img[src^='data:image']");
        return img ? img.src : null;
      });
      if (!imgSrc) throw new Error("No se encontró el código QR en la página");
    }

    const src = qrDataUrl || await page.evaluate(() => {
      const img = document.querySelector("img[src^='data:image']");
      return img ? img.src : null;
    });

    const base64 = src.replace(/^data:image\/\w+;base64,/, "");
    const qrBuf  = Buffer.from(base64, "base64");

    liveMsgId = null; liveMsgChat = null;
    const qrMsg = await bot.sendPhoto(chat, qrBuf, {
      caption:
        "📱 *Escanea este código QR con tu Android*\n\n" +
        "1️⃣ Abre *Google Messages* en tu teléfono\n" +
        "2️⃣ Toca ⋮ → *Dispositivos vinculados*\n" +
        "3️⃣ Toca *Vincular nuevo dispositivo*\n" +
        "4️⃣ Escanea el código\n\n" +
        "⏳ _Tienes 2 minutos para escanear_",
      parse_mode:   "Markdown",
      reply_markup: kb.cancel()
    }).catch(() => null);

    // Esperar que el usuario escanee y la URL cambie a /conversations
    await page.waitForFunction(
      () => window.location.href.includes("/conversations"),
      { timeout: QR_TIMEOUT }
    );

    connected  = true;
    connecting = false;

    if (qrMsg) bot.deleteMessage(chat, qrMsg.message_id).catch(() => {});
    liveMsgId = null; liveMsgChat = null;
    await live(chat,
      "✅ *¡Android vinculado correctamente!*\n" +
      "🟢 Google Messages listo para enviar SMS\n\n" +
      "Usa *Enviar a un número* o *Enviar a una lista*.",
      kb.main()
    );

  } catch (e) {
    connecting = false;
    if (browser) {
      try { await browser.close(); } catch (_) {}
      browser = null; page = null;
    }
    await live(chat,
      `❌ *Error al conectar*\n\`${e.message.slice(0, 150)}\`\n\nPulsa 📱 *Conectar Android* para reintentar.`,
      kb.main()
    );
  }
}

// ── DESCONECTAR ───────────────────────────────────────────────────────────────
async function disconnectGM(chat) {
  if (queue.on) { await live(chat, "⚠️ *Detén el envío primero*", kb.running()); return; }
  connected  = false;
  connecting = false;
  if (browser) {
    try { await browser.close(); } catch (_) {}
    browser = null; page = null;
  }
  // Borrar sesión guardada para desvincularse completamente
  try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); fs.mkdirSync(SESSION_DIR); } catch (_) {}
  await live(chat, "🔴 *Dispositivo desvinculado*\nPulsa 📱 *Conectar Android* para volver a vincular.", kb.main());
}

// ── ENVIAR UN SMS ─────────────────────────────────────────────────────────────
async function sendOneSMS(phone, message) {
  if (!connected || !page) throw new Error("No hay dispositivo conectado");

  // Normalizar número (sin espacios, con + si no lo tiene)
  const num = phone.trim().replace(/\s+/g, "");

  // Abrir nueva conversación directamente por URL
  await page.goto(
    `https://messages.google.com/web/conversations/new`,
    { waitUntil: "networkidle2", timeout: NAV_TIMEOUT }
  );

  // Buscar campo de número
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

  // Esperar campo de mensaje
  const textSel = [
    'div[contenteditable="true"][aria-label]',
    'textarea.message-input',
    'div[contenteditable="true"]',
  ].join(", ");

  await page.waitForSelector(textSel, { timeout: 12000 });
  await page.click(textSel);
  // Escribir mensaje parte a parte para evitar bloqueos
  for (const chunk of message.match(/.{1,50}/g) || [message]) {
    await page.type(textSel, chunk, { delay: 30 });
  }

  await sleep(600);

  // Enviar con Enter (o botón de envío)
  const sendBtn = await page.$('button[aria-label="Enviar mensaje"], button[aria-label="Send message"]');
  if (sendBtn) {
    await sendBtn.click();
  } else {
    await page.keyboard.press("Enter");
  }

  await sleep(1000);
  return true;
}

// ── PROCESAR COLA ─────────────────────────────────────────────────────────────
async function runQueue() {
  queue.on   = true;
  queue.stop = false;
  queue.sent = queue.failed = 0;
  queue.start = Date.now();

  await live(queue.chat,
    `📤 *Envío iniciado*\n` +
    `📊 Total: *${queue.total}* mensajes\n` +
    `⚡ Delay: ${DELAY_MIN/1000}–${DELAY_MAX/1000}s entre mensajes`,
    kb.running()
  );

  const total = queue.items.length;

  for (let i = 0; i < queue.items.length; ) {
    if (queue.stop) break;

    const item = queue.items[i];
    try {
      await sendOneSMS(item.phone, item.message);
      queue.sent++;
      i++;
    } catch (e) {
      queue.failed++;
      i++;
      // Reconectar si la página está caída
      if (!connected) {
        await live(queue.chat, "⚠️ *Conexión perdida, reintentando...*", kb.running());
        await sleep(5000);
        if (!connected) break;
      }
    }

    const elapsed = Date.now() - queue.start;
    const done    = queue.sent + queue.failed;
    const pct     = total > 0 ? ((done / total) * 100).toFixed(1) : "0";
    const bar     = "█".repeat(Math.round(done / total * 10)) + "░".repeat(10 - Math.round(done / total * 10));

    await live(queue.chat,
      `📤 *Enviando mensajes...*\n` +
      `[${bar}] ${done}/${total}\n` +
      `✅ Enviados: ${queue.sent.toLocaleString()}\n` +
      `❌ Fallidos: ${queue.failed.toLocaleString()}\n` +
      `📋 Pendientes: ${total - done}\n` +
      `📈 Progreso: ${pct}%\n` +
      `⏱️ Tiempo: ${fmtTime(elapsed)}`,
      kb.running()
    );

    if (i < queue.items.length && !queue.stop) {
      // Pausa larga cada BATCH_SIZE mensajes
      if (queue.sent > 0 && queue.sent % BATCH_SIZE === 0) {
        await live(queue.chat,
          `🛡️ *Pausa anti-ban* (lote ${Math.floor(queue.sent / BATCH_SIZE)})\n` +
          `💤 Reanudando en ${fmtTime(BATCH_PAUSE)}...\n` +
          `✅ Enviados hasta ahora: ${queue.sent}`,
          kb.running()
        );
        // Espera interrumpible
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

  queue.on = false;
  const elapsed = Date.now() - queue.start;
  queue.items   = [];

  await live(queue.chat,
    (queue.stop ? "⛔ *Envío detenido*\n" : "✅ *Envío completado*\n") +
    `✉️ Enviados: ${queue.sent.toLocaleString()}\n` +
    `❌ Fallidos: ${queue.failed.toLocaleString()}\n` +
    `⏱️ Duración: ${fmtTime(elapsed)}`,
    kb.done()
  );
}

// ── ESTADO ────────────────────────────────────────────────────────────────────
async function sendStatus(chat) {
  if (!queue.on) {
    await live(chat, "ℹ️ *No hay envíos en progreso*", kb.main());
    return;
  }
  const elapsed = Date.now() - queue.start;
  const done    = queue.sent + queue.failed;
  const pct     = queue.total > 0 ? ((done / queue.total) * 100).toFixed(1) : "0";
  const bar     = "█".repeat(Math.round(done / queue.total * 10)) + "░".repeat(10 - Math.round(done / queue.total * 10));
  await live(chat,
    `📊 *Estado de envío*\n` +
    `[${bar}] ${done}/${queue.total}\n` +
    `✅ Enviados: ${queue.sent.toLocaleString()}\n` +
    `❌ Fallidos: ${queue.failed.toLocaleString()}\n` +
    `📋 Pendientes: ${queue.total - done}\n` +
    `📈 Progreso: ${pct}%\n` +
    `⏱️ Tiempo: ${fmtTime(elapsed)}`,
    kb.running()
  );
}

// ── MIS LISTAS ────────────────────────────────────────────────────────────────
async function sendMyLists(chat) {
  const files = fs.readdirSync(LISTS_DIR).filter(f => f.endsWith(".txt"));
  if (!files.length) { await live(chat, "📂 *No hay listas guardadas*", kb.main()); return; }

  let txt = "📂 *Listas disponibles*\n";
  for (const f of files) {
    let count = 0;
    try { count = fs.readFileSync(path.join(LISTS_DIR, f), "utf-8").split("\n").filter(l => l.trim()).length; } catch (_) {}
    txt += `📄 *${f.replace(".txt", "")}* — ${count.toLocaleString()} números\n`;
  }

  const buttons = files.map(f => [{
    text: `📤 Usar: ${f.replace(".txt", "")}`,
    callback_data: `use_list_${f.replace(".txt", "").slice(0, 35)}`
  }]);
  buttons.push([{ text: "🏠 Menú", callback_data: "main" }]);
  await live(chat, txt, { reply_markup: { inline_keyboard: buttons } });
}

// ── CARGAR NÚMEROS DE ARCHIVO ─────────────────────────────────────────────────
function loadPhones(filePath) {
  const content = fs.readFileSync(filePath, "utf-8");
  const phones  = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Soporta: "+34600123456", "34600123456", "600123456", "600123456 | Nombre"
    const match = trimmed.match(/^[\+]?(\d[\d\s\-]{6,})/);
    if (match) phones.push(match[1].replace(/[\s\-]/g, ""));
  }
  return phones;
}

// ── CALLBACKS ────────────────────────────────────────────────────────────────
bot.on("callback_query", async q => {
  const chat = q.message.chat.id;
  const d    = q.data;
  bot.answerCallbackQuery(q.id).catch(() => {});

  if (!isAllowed(q)) { await live(chat, "🚫 *Acceso denegado*"); return; }

  if (d === "main") {
    liveMsgId = null; liveMsgChat = null;
    await live(chat,
      `🤖 *Google Messages Sender v1.0*\n` +
      `📱 ${connected ? "🟢 Android vinculado" : "🔴 Sin dispositivo"}\n` +
      `📤 ${queue.on ? `Enviando... ${queue.sent}/${queue.total}` : "En reposo"}`,
      kb.main()
    );
    return;
  }

  if (d === "connect") {
    if (queue.on) { await live(chat, "⚠️ *Detén el envío primero*", kb.running()); return; }
    connectGM(chat).catch(e => { connecting = false; live(chat, `❌ \`${e.message}\``, kb.main()); });
    return;
  }

  if (d === "cancel_connect") {
    connecting = false;
    if (browser) { try { await browser.close(); } catch (_) {} browser = null; page = null; }
    await live(chat, "❌ *Conexión cancelada*", kb.main());
    return;
  }

  if (d === "conn_info") {
    await live(chat,
      `✅ *Android conectado*\n` +
      `🌐 Google Messages Web activo\n` +
      `📤 Listo para enviar SMS`,
      kb.main()
    );
    return;
  }

  if (d === "disconnect") {
    await disconnectGM(chat);
    return;
  }

  if (d === "send_single") {
    if (!connected) { await live(chat, "❌ *Sin dispositivo conectado*\nPulsa 📱 *Conectar Android* primero.", kb.main()); return; }
    if (queue.on)   { await live(chat, "⚠️ *Envío en curso*", kb.running()); return; }
    waitMsg.set(chat, { step: "phone" });
    await live(chat, "📱 *Escribe el número de teléfono destinatario*\n_Ejemplo: +34600123456 o 600123456_\n\nEscribe /cancelar para cancelar.");
    return;
  }

  if (d === "send_list") {
    if (!connected) { await live(chat, "❌ *Sin dispositivo conectado*\nPulsa 📱 *Conectar Android* primero.", kb.main()); return; }
    if (queue.on)   { await live(chat, "⚠️ *Envío en curso*", kb.running()); return; }
    await sendMyLists(chat);
    return;
  }

  if (d.startsWith("use_list_")) {
    const name     = d.slice(9);
    const filePath = path.join(LISTS_DIR, `${name}.txt`);
    if (!fs.existsSync(filePath)) { await live(chat, "❌ *Lista no encontrada*", kb.main()); return; }
    waitMsg.set(chat, { step: "message", listFile: filePath });
    const count = loadPhones(filePath).length;
    await live(chat,
      `📋 *Lista seleccionada:* ${name}\n` +
      `📊 ${count.toLocaleString()} números\n\n` +
      `✉️ *Escribe el mensaje que quieres enviar:*\n` +
      `_Puedes usar emojis y saltos de línea_\n\n` +
      `Escribe /cancelar para cancelar.`
    );
    return;
  }

  if (d === "queue_status") { await sendStatus(chat); return; }

  if (d === "stop_send") {
    if (!queue.on) { await live(chat, "ℹ️ *No hay envíos en curso*", kb.main()); return; }
    queue.stop = true;
    await live(chat, "⛔ *Deteniendo envío...*");
    return;
  }

  if (d === "my_lists") {
    await sendMyLists(chat);
    return;
  }
});

// ── MENSAJES DE TEXTO ─────────────────────────────────────────────────────────
bot.on("message", async m => {
  const chat = m.chat.id;
  if (!isAllowed(m)) { await live(chat, "🚫 *Acceso denegado*"); return; }

  // Comandos
  if (m.text === "/cancelar") {
    waitMsg.delete(chat);
    waitList.delete(chat);
    liveMsgId = null; liveMsgChat = null;
    await live(chat,
      `🤖 *Google Messages Sender v1.0*\n` +
      `📱 ${connected ? "🟢 Android vinculado" : "🔴 Sin dispositivo"}`,
      kb.main()
    );
    return;
  }

  if (m.text === "/estado")   { await sendStatus(chat); return; }
  if (m.text === "/parar")    { if (queue.on) { queue.stop = true; live(chat, "⛔ *Deteniendo...*"); } return; }
  if (m.text === "/listas")   { await sendMyLists(chat); return; }
  if (m.text === "/conectar") {
    if (queue.on) { await live(chat, "⚠️ *Detén el envío primero*", kb.running()); return; }
    connectGM(chat).catch(e => { connecting = false; live(chat, `❌ \`${e.message}\``, kb.main()); });
    return;
  }

  // Flujo de envío a número único
  if (waitMsg.has(chat)) {
    const state = waitMsg.get(chat);

    if (state.step === "phone") {
      const phone = (m.text || "").trim();
      if (!phone.match(/[\d]{6,}/)) {
        await live(chat, "❌ *Número no válido*\nEscribe el número de teléfono (mínimo 6 dígitos):");
        return;
      }
      state.phone = phone;
      state.step  = "message";
      waitMsg.set(chat, state);
      await live(chat,
        `✅ *Número:* \`${phone}\`\n\n` +
        `✉️ *Ahora escribe el mensaje a enviar:*\n\n` +
        `Escribe /cancelar para cancelar.`
      );
      return;
    }

    if (state.step === "message") {
      const message = (m.text || "").trim();
      if (!message) { await live(chat, "❌ *El mensaje no puede estar vacío*"); return; }
      waitMsg.delete(chat);

      if (state.listFile) {
        // Envío a lista
        const phones = loadPhones(state.listFile);
        if (!phones.length) { await live(chat, "❌ *La lista no tiene números válidos*", kb.main()); return; }

        queue.items   = phones.map(p => ({ phone: p, message }));
        queue.total   = phones.length;
        queue.chat    = chat;
        queue.currentMsg = message;

        runQueue().catch(e => {
          queue.on = false;
          live(chat, `💥 *Error crítico:* \`${e.message.slice(0, 200)}\``, kb.done());
        });

      } else if (state.phone) {
        // Envío a número único
        queue.items   = [{ phone: state.phone, message }];
        queue.total   = 1;
        queue.chat    = chat;
        queue.currentMsg = message;

        runQueue().catch(e => {
          queue.on = false;
          live(chat, `💥 *Error crítico:* \`${e.message.slice(0, 200)}\``, kb.done());
        });
      }
      return;
    }
  }

  // Archivo .txt con lista de números
  if (m.document) {
    const doc = m.document;
    if (!doc.file_name?.endsWith(".txt")) {
      await live(chat, "⚠️ *Solo se aceptan archivos .txt*\nUno por línea con los números de teléfono.");
      return;
    }

    try {
      const fileInfo = await bot.getFile(doc.file_id);
      const fileUrl  = `https://api.telegram.org/file/bot${TOKEN}/${fileInfo.file_path}`;
      const res      = await fetch(fileUrl);
      const content  = await res.text();

      const safeName = (doc.file_name || "lista").replace(/[^a-zA-Z0-9_\-]/g, "_").replace(/\.txt$/, "");
      const dest     = path.join(LISTS_DIR, `${safeName}.txt`);
      fs.writeFileSync(dest, content, "utf-8");

      const phones = loadPhones(dest);
      await live(chat,
        `✅ *Lista guardada:* ${safeName}\n` +
        `📊 ${phones.toLocaleString ? phones.length.toLocaleString() : phones.length} números encontrados\n\n` +
        `Ahora ve a 📋 *Enviar a una lista* para usarla.`,
        kb.main()
      );
    } catch (e) {
      await live(chat, `❌ *Error al procesar archivo:* \`${e.message}\``, kb.main());
    }
    return;
  }
});

// ── COMANDOS BASE ─────────────────────────────────────────────────────────────
bot.onText(/\/start/, async m => {
  if (!isAllowed(m)) { await live(m.chat.id, "🚫 *Acceso denegado*"); return; }
  liveMsgId = null; liveMsgChat = null;
  await live(m.chat.id,
    `🤖 *Google Messages Sender v1.0*\n\n` +
    `Envía SMS desde tu Android a través de Google Messages.\n\n` +
    `📱 ${connected ? "🟢 Android vinculado" : "🔴 Sin dispositivo vinculado"}\n\n` +
    `_Conecta tu Android y empieza a enviar._`,
    kb.main()
  );
});

// ── SHUTDOWN ──────────────────────────────────────────────────────────────────
async function shutdown(sig) {
  console.log(`[${sig}] Cerrando...`);
  if (queue.on) queue.stop = true;
  if (browser) { try { await browser.close(); } catch (_) {} }
  try { bot.stopPolling(); } catch (_) {}
  process.exit(0);
}
process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException",  e => console.error("[FATAL]", e.message));
process.on("unhandledRejection", r => console.error("[FATAL]", r));

// ── MAIN ──────────────────────────────────────────────────────────────────────
console.log("═══ Google Messages Sender Bot v1.0 ═══");
console.log(`✅ Bot listo. Usuario permitido: @${ALLOWED_USERNAME}`);
console.log("Esperando 6s antes de conectar (evita conflicto de instancias)...");
startBot().then(() => console.log("Esperando /start en Telegram..."));
