const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL || "https://script.google.com/macros/s/AKfycbw6IdTXV95MJUMjTp3ZyDDIHASz9zOIlQ6fgkrxWFru1h5TZKYsHmSgRbc0KV090w9SCg/exec";

// Global Bot State
let sock = null;
let currentQR = null;
let isConnected = false;
let botUser = null;
let backupTimeout = null;
let reconnectAttempts = 0;
let isStarting = false;

// In-Memory Live Log Buffer for Web Dashboard & Debugging
const logBuffer = [];
function logEvent(emoji, message) {
  const time = new Date().toLocaleTimeString('en-US', { timeZone: 'Asia/Dhaka', hour12: true });
  const entry = `[${time}] ${emoji} ${message}`;
  console.log(entry);
  logBuffer.unshift(entry);
  if (logBuffer.length > 100) logBuffer.pop();
}

const authDir = path.join(__dirname, 'auth_info_baileys');

// Normalize Bangladesh phone number to WhatsApp JID
function formatJid(phone) {
  let num = String(phone).split('@')[0].split(':')[0].replace(/[^\d]/g, '');
  if (num.startsWith('01') && num.length === 11) {
    num = '88' + num;
  } else if (num.startsWith('1') && num.length === 10) {
    num = '880' + num;
  }
  return num + '@s.whatsapp.net';
}

// Extract pure phone number from JID (handles multi-device :0, :1, and LID)
function extractPhone(jid) {
  if (!jid) return '';
  const base = jid.split('@')[0].split(':')[0];
  let num = base.replace(/[^\d]/g, '');
  if (num.startsWith('880') && num.length === 14) {
    num = num.slice(0, 13);
  } else if (num.startsWith('01') && num.length === 12) {
    num = num.slice(0, 11);
  }
  return num;
}

// Unpack all WhatsApp message types (plain text, ephemeral, view-once, buttons, captions)
function extractMessageText(msg) {
  if (!msg || !msg.message) return '';
  const m = msg.message;
  const inner = m.ephemeralMessage?.message ||
                m.viewOnceMessage?.message ||
                m.viewOnceMessageV2?.message ||
                m.documentWithCaptionMessage?.message ||
                m;
  return inner.conversation ||
         inner.extendedTextMessage?.text ||
         inner.imageMessage?.caption ||
         inner.videoMessage?.caption ||
         inner.buttonsResponseMessage?.selectedButtonId ||
         inner.listResponseMessage?.singleSelectReply?.selectedRowId ||
         inner.templateButtonReplyMessage?.selectedId ||
         '';
}

// ===== CLOUD SESSION PERSISTENCE (Free Render Disk Wipe Protection) =====
// Synchronizes auth credentials with Google Apps Script so restarts never lose the WhatsApp login
async function syncAuthFromCloud() {
  try {
    const credsFile = path.join(authDir, 'creds.json');
    if (fs.existsSync(credsFile)) {
      console.log('📂 Local session found on disk.');
      return;
    }

    console.log('☁️ Checking for existing session in Google Sheets...');
    const res = await fetch(SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'GET_WA_SESSION' })
    });
    const data = await res.json();
    if (data && data.status === 'success' && data.files && Object.keys(data.files).length > 0) {
      if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
      for (const [filename, content] of Object.entries(data.files)) {
        fs.writeFileSync(path.join(authDir, filename), content, 'utf8');
      }
      console.log(`✅ Restored ${Object.keys(data.files).length} session files from Google Sheets!`);
    } else {
      console.log('ℹ️ No prior cloud session found. QR code will be generated for scanning.');
    }
  } catch (err) {
    console.warn('⚠️ Could not restore session from cloud:', err.message);
  }
}

function scheduleCloudBackup(delayMs = 3000) {
  if (backupTimeout) clearTimeout(backupTimeout);
  backupTimeout = setTimeout(async () => {
    try {
      if (!fs.existsSync(authDir)) return;
      const fileNames = fs.readdirSync(authDir);
      if (fileNames.length === 0) return;

      const files = {};
      for (const f of fileNames) {
        const fullPath = path.join(authDir, f);
        if (fs.statSync(fullPath).isFile()) {
          files[f] = fs.readFileSync(fullPath, 'utf8');
        }
      }

      await fetch(SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'SAVE_WA_SESSION',
          files: files
        })
      });
      console.log(`☁️ Synced ${fileNames.length} session files to Google Sheets.`);
    } catch (err) {
      console.warn('⚠️ Cloud session backup warning:', err.message);
    }
  }, delayMs);
}

async function clearCloudAuth() {
  try {
    await fetch(SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'CLEAR_WA_SESSION' })
    });
    console.log('🗑️ Cleared cloud session from Google Sheets.');
  } catch (err) {
    console.warn('⚠️ Clear cloud session warning:', err.message);
  }
}

// ===== Initialize WhatsApp Baileys Engine =====
async function startWhatsAppBot() {
  if (isStarting) return;
  isStarting = true;

  try {
    // 1. Clean up old socket cleanly before starting new connection
    if (sock) {
      try {
        sock.ev.removeAllListeners();
        if (sock.ws) sock.ws.close();
      } catch (e) {}
      sock = null;
    }

    if (!fs.existsSync(authDir)) {
      fs.mkdirSync(authDir, { recursive: true });
    }

    // 2. Restore session from Google Sheets if disk is empty
    await syncAuthFromCloud();

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: ['Ideal Home Mess', 'Chrome', '120.0.0'],
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 0,
      keepAliveIntervalMs: 25000,
      syncFullHistory: false
    });

    sock.ev.on('creds.update', async () => {
      await saveCreds();
      scheduleCloudBackup();
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQR = await QRCode.toDataURL(qr);
        isConnected = false;
        console.log('⚡ New QR code generated. Visit Web Dashboard to scan.');
      }

      if (connection === 'open') {
        reconnectAttempts = 0;
        isConnected = true;
        currentQR = null;
        botUser = sock.user;
        console.log('✅ WhatsApp connected successfully as:', botUser?.id || botUser?.name);
        scheduleCloudBackup(1000);
      }

      if (connection === 'close') {
        isConnected = false;
        const statusCode = (lastDisconnect?.error)?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        console.log('⚠️ Connection closed due to:', lastDisconnect?.error?.message || lastDisconnect?.error, 'Status Code:', statusCode);

        // If explicitly logged out OR if connection fails 4 times in a row (corrupted/stale session):
        reconnectAttempts++;
        if (isLoggedOut || reconnectAttempts >= 4) {
          console.log(`❌ ${isLoggedOut ? 'Logged out from device' : 'Reconnection failed 4 times'}. Clearing stale session to generate fresh QR...`);
          reconnectAttempts = 0;
          await clearCloudAuth();
          try {
            fs.rmSync(authDir, { recursive: true, force: true });
          } catch (e) {}
          setTimeout(startWhatsAppBot, 2000);
        } else {
          const delay = Math.min(reconnectAttempts * 3000, 12000);
          console.log(`⏳ Reconnecting in ${delay / 1000}s (Attempt ${reconnectAttempts}/4)...`);
          setTimeout(startWhatsAppBot, delay);
        }
      }
    });

    // Handle Incoming WhatsApp Messages from Boarders
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (!msg.key) continue;
        const rawJid = msg.key.remoteJid || '';
        if (rawJid.includes('@g.us') || rawJid === 'status@broadcast') continue; // Ignore groups and status

        const text = extractMessageText(msg);
        if (!text || text.trim() === '') continue;

        const botPhone = botUser?.id ? extractPhone(botUser.id) : (sock?.user?.id ? extractPhone(sock.user.id) : '');
        const isSelfChat = msg.key.fromMe && (
          (botPhone && rawJid.includes(botPhone)) ||
          rawJid === (sock?.user?.id ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : '')
        );

        if (msg.key.fromMe && !isSelfChat) continue; // Ignore regular outgoing messages to other people

        // If self-chat, avoid replying to bot's own responses to prevent loops
        if (isSelfChat) {
          if (text.startsWith('📊') || text.startsWith('🤖') || text.startsWith('✅') || 
              text.startsWith('⚠️') || text.startsWith('❌') || text.startsWith('🛒') || 
              text.startsWith('📢') || text.startsWith('👤') || text.startsWith('🏠') || 
              text.startsWith('🎉') || text.startsWith('💡') || text.startsWith('ℹ️') ||
              text.startsWith('👋')) {
            continue;
          }
        }

        // Handle WhatsApp LID privacy IDs if remoteJid is @lid
        const actualJid = (rawJid && rawJid.includes('@lid'))
          ? (msg.key.remoteJidAlt || msg.key.participant || msg.key.participantPn || rawJid)
          : rawJid;
        const senderPhone = extractPhone(actualJid) || (isSelfChat ? botPhone : '');

        logEvent('📩', `Incoming from ${senderPhone || rawJid}: "${text.slice(0, 60)}"`);

        // Forward to Google Apps Script Webhook
        try {
          const fetchRes = await fetch(SCRIPT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'WHATSAPP_BOT',
              sender: senderPhone,
              message: text,
              sendReply: false
            })
          });

          const data = await fetchRes.json();
          if (data && data.reply) {
            logEvent('📤', `Sending reply to ${senderPhone || rawJid}: "${data.reply.slice(0, 45)}..."`);
            const replyJid = (rawJid && rawJid.includes('@s.whatsapp.net')) 
              ? rawJid 
              : (senderPhone ? formatJid(senderPhone) : rawJid);
            await sock.sendMessage(replyJid, { text: data.reply });
            logEvent('✅', `Delivered reply to ${senderPhone || rawJid}`);
          } else {
            logEvent('⚠️', `GAS Webhook did not return a reply for ${senderPhone}`);
          }
        } catch (err) {
          logEvent('❌', `Error forwarding to Google Apps Script: ${err.message}`);
        }
      }
    });
  } catch (err) {
    console.error('❌ Error starting WhatsApp Bot:', err.message);
    setTimeout(startWhatsAppBot, 5000);
  } finally {
    isStarting = false;
  }
}

// ===== API ROUTES =====

// 1. Web Dashboard (QR Code, Status, and Reset Button)
app.get('/', (req, res) => {
  const html = `
  <!DOCTYPE html>
  <html lang="bn">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Ideal Home WhatsApp Bot</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  </head>
  <body class="bg-slate-100 min-h-screen flex items-center justify-center p-4">
    <div class="bg-white rounded-3xl p-6 sm:p-8 max-w-md w-full shadow-2xl border border-slate-200 text-center">
      <div class="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center text-green-600 mx-auto mb-4 text-3xl shadow-inner">
        <i class="fab fa-whatsapp"></i>
      </div>
      <h1 class="text-xl font-extrabold text-slate-800">আইডিয়াল হোম মেস</h1>
      <p class="text-xs text-slate-500 mb-6">প্রাইভেট সেলফ-হোস্টেড WhatsApp বট ইঞ্জিন (Render)</p>

      <div id="statusBox" class="mb-6">
        ${
          isConnected
            ? `<div class="p-5 bg-green-50 border border-green-200 rounded-2xl">
                <div class="inline-flex items-center gap-2 px-3 py-1 bg-green-500 text-white rounded-full text-xs font-bold mb-2">
                  <span class="w-2 h-2 rounded-full bg-white animate-pulse"></span>
                  সংযুক্ত রয়েছে (Connected)
                </div>
                <p class="text-xs text-green-800 font-semibold">বট সফলভাবে লাইভ আছে! বর্ডারদের স্বয়ংক্রিয় মেসেজ সচল রয়েছে।</p>
                <p class="text-xs text-slate-500 font-mono mt-2 font-bold">${botUser?.id ? botUser.id.split(':')[0] : ''}</p>
              </div>`
            : currentQR
            ? `<div class="p-4 bg-amber-50 border border-amber-200 rounded-2xl flex flex-col items-center">
                <div class="inline-flex items-center gap-2 px-3 py-1 bg-amber-500 text-white rounded-full text-xs font-bold mb-3">
                  <span class="w-2 h-2 rounded-full bg-white animate-pulse"></span>
                  QR কোড স্ক্যান করুন
                </div>
                <div class="bg-white p-2 rounded-2xl shadow-md border mb-3">
                  <img src="${currentQR}" alt="WhatsApp QR" class="w-56 h-56 object-contain" />
                </div>
                <p class="text-[11px] text-amber-800 font-medium">WhatsApp > Linked Devices > Link a Device দিয়ে স্ক্যান করুন।</p>
              </div>`
            : `<div class="p-6 bg-slate-50 border border-slate-200 rounded-2xl">
                <i class="fas fa-spinner fa-spin text-2xl text-slate-400 mb-2"></i>
                <p class="text-xs text-slate-500">বট ইঞ্জিন চালু হচ্ছে, অপেক্ষা করুন...</p>
              </div>`
        }
      </div>

      <div class="bg-slate-50 p-3.5 rounded-2xl border text-left text-xs text-slate-600 space-y-1.5 mb-5">
        <p class="font-bold text-slate-700 flex items-center gap-1.5"><i class="fas fa-shield-alt text-green-600"></i> নিরাপত্তা ও সুরক্ষা:</p>
        <p>• প্রতিটি মেসেজের মাঝে ৫-৬ সেকেন্ড নিরাপদ বিরতি থাকে।</p>
        <p>• অ্যাকাউন্ট ব্যান হওয়ার কোনো ঝুঁকি নেই।</p>
        <p>• শুধুমাত্র গুগল শিটে নিবন্ধিত বর্ডারদের মেসেজ পাঠানো হয়।</p>
      </div>

      <!-- Live Logs Box -->
      <div class="bg-slate-900 text-slate-200 p-3.5 rounded-2xl border border-slate-800 text-left mb-5">
        <div class="flex items-center justify-between mb-2">
          <span class="text-[11px] font-bold text-slate-300 flex items-center gap-1.5">
            <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            লাইভ অ্যাক্টিভিটি লগ (Live Activity):
          </span>
          <a href="/logs" target="_blank" class="text-[10px] text-emerald-400 hover:underline font-mono">লগ API <i class="fas fa-external-link-alt"></i></a>
        </div>
        <div id="logConsole" class="h-32 overflow-y-auto font-mono text-[10px] space-y-1 bg-slate-950 p-2.5 rounded-xl text-slate-300">
          ${
            logBuffer.length > 0 
              ? logBuffer.slice(0, 20).map(l => `<div class="truncate">${l}</div>`).join('') 
              : '<div class="text-slate-500 italic">এখনও কোনো বার্তা আসেনি। বর্ডারদের মেসেজের জন্য বট লাইভ ও প্রস্তুত।</div>'
          }
        </div>
      </div>

      <div class="flex gap-2">
        <button onclick="location.reload()" class="flex-1 bg-slate-800 hover:bg-slate-900 text-white py-2.5 rounded-xl font-bold text-xs shadow active:scale-95 transition">
          <i class="fas fa-sync-alt mr-1"></i> রিফ্রেশ করুন
        </button>
        <a href="/reset" onclick="return confirm('আপনি কি নিশ্চিত যে সেশন রিসেট করে নতুন QR কোড তৈরি করতে চান?')" class="flex-1 bg-rose-600 hover:bg-rose-700 text-white py-2.5 rounded-xl font-bold text-xs shadow active:scale-95 transition flex items-center justify-center gap-1">
          <i class="fas fa-trash-alt mr-1"></i> সেশন রিসেট (নতুন QR)
        </a>
      </div>
    </div>
  </body>
  </html>
  `;
  res.send(html);
});

// 2. Reset Session & Force Fresh QR Code
app.get('/reset', async (req, res) => {
  try {
    if (sock) {
      try {
        sock.ev.removeAllListeners();
        if (sock.ws) sock.ws.close();
      } catch (e) {}
      sock = null;
    }
    isConnected = false;
    currentQR = null;
    botUser = null;
    reconnectAttempts = 0;
    await clearCloudAuth();
    try {
      fs.rmSync(authDir, { recursive: true, force: true });
    } catch (e) {}
    setTimeout(startWhatsAppBot, 1000);

    res.send(`
      <!DOCTYPE html>
      <html lang="bn">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Resetting Session</title>
        <script src="https://cdn.tailwindcss.com"></script>
      </head>
      <body class="bg-slate-100 min-h-screen flex items-center justify-center p-4">
        <div class="bg-white rounded-3xl p-8 max-w-sm w-full text-center shadow-xl">
          <div class="w-12 h-12 bg-green-100 text-green-600 rounded-full flex items-center justify-center text-xl mx-auto mb-3">✓</div>
          <h2 class="text-base font-bold text-slate-800">সেশন রিসেট সফল হয়েছে!</h2>
          <p class="text-xs text-slate-500 mt-1 mb-4">নতুন QR কোড তৈরি হচ্ছে, অপেক্ষা করুন...</p>
          <div class="animate-spin w-6 h-6 border-2 border-green-600 border-t-transparent rounded-full mx-auto"></div>
        </div>
        <script>setTimeout(() => { window.location.href = '/'; }, 3000);</script>
      </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Reset failed: ' + err.message);
  }
});

// 3. Health & Status Check Endpoint
app.get('/status', (req, res) => {
  res.json({
    connected: isConnected,
    has_qr: !!currentQR,
    qr: currentQR,
    user: botUser ? { id: botUser.id, name: botUser.name } : null
  });
});

// 4. Live Logs Endpoint
app.get('/logs', (req, res) => {
  res.json({ count: logBuffer.length, logs: logBuffer });
});

// 5. Keep-Alive Ping Endpoint (for Google Apps Script / UptimeRobot)
app.get('/ping', (req, res) => {
  res.send('pong ' + new Date().toISOString());
});

// 6. Send Single Message API (Called by Google Apps Script)
app.post('/send', async (req, res) => {
  const { phone, message } = req.body;

  if (!isConnected || !sock) {
    logEvent('⚠️', `Send failed: Bot is not connected yet.`);
    return res.status(503).json({ status: 'error', message: 'WhatsApp bot is not connected yet.' });
  }

  if (!phone || !message) {
    return res.status(400).json({ status: 'error', message: 'phone and message are required.' });
  }

  try {
    const jid = formatJid(phone);
    await sock.sendMessage(jid, { text: message });
    logEvent('📤', `Single message delivered to ${phone}`);
    res.json({ status: 'success', message: 'Message sent successfully.' });
  } catch (err) {
    logEvent('❌', `Failed to send to ${phone}: ${err.message}`);
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// 7. Broadcast Endpoint (Batch sending with safe 5-6 second delay to prevent WhatsApp ban)
app.post('/broadcast', async (req, res) => {
  const { messages } = req.body;

  if (!isConnected || !sock) {
    logEvent('⚠️', `Broadcast rejected: Bot not connected.`);
    return res.status(503).json({ status: 'error', message: 'WhatsApp bot is not connected.' });
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ status: 'error', message: 'messages array is required.' });
  }

  res.json({ status: 'processing', message: `Queued ${messages.length} messages. Sending safely with 5-6s delay.` });

  (async () => {
    logEvent('📢', `Starting safe bulk broadcast of ${messages.length} messages...`);
    for (let i = 0; i < messages.length; i++) {
      const item = messages[i];
      if (!item.phone || !item.message) continue;
      try {
        const jid = formatJid(item.phone);
        await sock.sendMessage(jid, { text: item.message });
        logEvent('✅', `[${i + 1}/${messages.length}] Broadcast sent to ${item.phone}`);

        // 5 to 6.5 seconds human-like delay between messages to prevent WhatsApp anti-spam ban
        if (i < messages.length - 1) {
          const delayMs = 5000 + Math.floor(Math.random() * 1500); // 5000ms - 6500ms (5 to 6.5s)
          await new Promise((r) => setTimeout(r, delayMs));
        }
      } catch (e) {
        logEvent('❌', `Error broadcasting to ${item.phone}: ${e.message}`);
      }
    }
    logEvent('🎉', `Safe broadcast completed for all ${messages.length} messages.`);
  })();
});

// Start Express Server and WhatsApp Bot
app.listen(PORT, () => {
  console.log(`🚀 Ideal Home WhatsApp Server running on port ${PORT}`);
  startWhatsAppBot();
});
