const express = require('express');
const { v4: uuidv4 } = require('uuid');
const {
  createSession,
  getSession,
  checkAccess,
  touch,
  saveOutbox,
} = require('./sessionManager');

const router = express.Router();

router.post('/link', async (req, res) => {
  const userId = uuidv4();
  try {
    await createSession(userId);
    res.json({ userId, message: 'Sesion creada.' });
  } catch (err) {
    if (err.message === 'LIMIT_REACHED') {
      return res.status(503).json({ error: 'La aplicacion esta en modo beta y ya alcanzo el limite de usuarios registrados. Intenta mas tarde.' });
    }
    console.error(err);
    res.status(500).json({ error: 'No se pudo iniciar la sesion' });
  }
});

router.get('/status/:userId', (req, res) => {
  const session = getSession(req.params.userId);
  if (!session) return res.status(404).json({ error: 'Sesion no encontrada' });
  res.json({
    status: session.status,
    qr: session.status === 'waiting_qr' ? session.qr : null,
    accessCode: session.status === 'connected' ? session.accessCode : null,
  });
});

// J2ME no soporta emojis ni chars fuera de Latin-1 — limpiar nombres
function sanitizeForJ2ME(name) {
  return name ? name.replace(/[^\x20-\xFF]/g, '').trim() : name;
}

function auth(req, res, next) {
  const { userId } = req.params;
  const code = req.query.code || req.headers['x-access-code'];
  if (!checkAccess(userId, code)) {
    return res.status(401).json({ error: 'Codigo de acceso invalido' });
  }
  touch(userId);
  next();
}

// GET /contacts/:userId?code=XXX&page=0 — lista de contactos de Baileys, 12 por pagina
router.get('/contacts/:userId', auth, async (req, res) => {
  const session = getSession(req.params.userId);
  if (!session) return res.status(404).json({ error: 'Sesion no encontrada' });
  const page = parseInt(req.query.page || '0', 10);
  const pageSize = 12;
  const db = require('./db');

  const contacts = session.contacts || {};
  const totalRaw = Object.keys(contacts).length;
  console.log('[contacts] session.contacts total keys:', totalRaw);

  // Construir array desde Baileys
  const all = [];
  for (const jid in contacts) {
    const c = contacts[jid];
    const name = c.name || c.notify || null;
    if (!name) continue;
    if (!jid.endsWith('@s.whatsapp.net')) continue;
    const phone = jid.replace('@s.whatsapp.net', '');
    all.push({ id: jid, name: sanitizeForJ2ME(name), phone: phone });
  }
  console.log('[contacts] filtrados con nombre y @s.whatsapp.net:', all.length);

  if (all.length > 0) {
    // Guardar/actualizar en BD como respaldo (upsert)
    try {
      for (const contact of all) {
        await db.query(
          `INSERT INTO contacts (userId, contactId, name, phone)
           VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE name=VALUES(name), phone=VALUES(phone)`,
          [req.params.userId, contact.id, contact.name, contact.phone]
        );
      }
      console.log('[contacts] BD actualizada con', all.length, 'contactos');
    } catch (dbErr) {
      console.error('[contacts] Error guardando en BD:', dbErr.message);
    }
  } else {
    // Baileys no tiene contactos — usar respaldo de BD
    console.log('[contacts] Baileys sin contactos, usando respaldo BD');
    try {
      const dbContacts = await db.query(
        `SELECT contactId AS id, name, phone FROM contacts WHERE userId=? ORDER BY name ASC`,
        [req.params.userId]
      );
      const total = dbContacts.length;
      const offset = page * pageSize;
      const slice = dbContacts.slice(offset, offset + pageSize);
      const hasMore = offset + pageSize < total;
      return res.json({ contacts: slice, hasMore, page, total });
    } catch (dbErr) {
      console.error('[contacts] Error leyendo BD:', dbErr.message);
      return res.json({ contacts: [], hasMore: false, page, total: 0 });
    }
  }

  all.sort(function(a, b) {
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    return 0;
  });
  const total = all.length;
  const offset = page * pageSize;
  const slice = all.slice(offset, offset + pageSize);
  const hasMore = offset + pageSize < total;
  res.json({ contacts: slice, hasMore: hasMore, page: page, total: total });
});

router.get('/chats/:userId', auth, async (req, res) => {
  const session = getSession(req.params.userId);
  const page = parseInt(req.query.page || '0', 10);
  const pageSize = 10;
  const offset = page * pageSize;
  try {
    const chats = await require('./db').query(
      `SELECT chatId AS id, name, lastMessage, lastTimestamp, unreadCount
       FROM chats WHERE userId=?
       AND (name != 'No conocido' OR (lastMessage IS NOT NULL AND lastMessage != ''))
       ORDER BY lastTimestamp DESC LIMIT ? OFFSET ?`,
      [req.params.userId, pageSize, offset]
    );
    const countRows = await require('./db').query(
      `SELECT COUNT(*) AS total FROM chats WHERE userId=?
       AND (name != 'No conocido' OR (lastMessage IS NOT NULL AND lastMessage != ''))`,
      [req.params.userId]
    );
    const total = countRows[0].total;
    const hasMore = offset + pageSize < total;
    console.log(`[chats] page=${page} devolviendo ${chats.length}/${total}, hasMore=${hasMore}`);
    console.log(`[chats] unreadCounts:`, chats.map(c => ({ id: c.id, unread: c.unreadCount })));
    const respBody = JSON.stringify({ chats, hasMore, page, total });
    console.log(`[chats] bytes respuesta: ${Buffer.byteLength(respBody)}`);
    res.json({ chats, hasMore, page, total });
  } catch (err) {
    console.error('[chats] DB error:', err.message);
    res.status(500).json({ error: 'Error DB' });
  }
});

router.post('/markAsRead/:userId/:chatId', auth, async (req, res) => {
  const session = getSession(req.params.userId);
  let chatId = req.params.chatId;
  if (!chatId.includes('@')) {
    chatId = chatId.replace(/\D/g, '') + '@s.whatsapp.net';
  } else if (chatId.endsWith('@lid') && session.lidCache[chatId]) {
    chatId = session.lidCache[chatId] + '@s.whatsapp.net';
  }
  const db = require('./db');
  try {
    await db.query(
      'UPDATE chats SET unreadCount=0 WHERE userId=? AND chatId=?',
      [req.params.userId, chatId]
    );
  } catch (_) {}
  // Marcar como leído en WhatsApp solo para chats personales
  if (session?.sock && chatId.endsWith('@s.whatsapp.net')) {
    try {
      const unread = await db.query(
        'SELECT messageId FROM messages WHERE userId=? AND chatId=? AND fromMe=0 AND ack < 4',
        [req.params.userId, chatId]
      );
      if (unread.length > 0) {
        const keys = unread.map(m => ({ remoteJid: chatId, id: m.messageId }));
        await session.sock.readMessages(keys).catch(() => {});
      }
    } catch (_) {}
  }
  res.json({ ok: true });
});

router.get('/messages/:userId/:chatId', auth, async (req, res) => {
  const session = getSession(req.params.userId);
  const rawChatId = req.params.chatId;
  let normChatId = rawChatId;
  if (!normChatId.includes('@')) {
    normChatId = normChatId.replace(/\D/g, '') + '@s.whatsapp.net';
  } else if (normChatId.endsWith('@lid') && session.lidCache[normChatId]) {
    normChatId = session.lidCache[normChatId] + '@s.whatsapp.net';
  }
  const page = parseInt(req.query.page || '0', 10);
  const pageSize = 10;
  try {
    const db = require('./db');
    // Total de mensajes para este chat
    const countRows = await db.query(
      'SELECT COUNT(*) AS total FROM messages WHERE userId=? AND chatId=?',
      [req.params.userId, normChatId]
    );
    const total = countRows[0].total;
    // Paginación hacia atrás: page=0 → últimos 10, page=1 → 10 anteriores
    const offset = Math.max(0, total - pageSize * (page + 1));
    const limit = Math.min(pageSize, total - pageSize * page);
    const messages = await db.query(
      `SELECT messageId AS id, fromMe, text, type, timestamp, pushName, ack, quoted
       FROM messages WHERE userId=? AND chatId=?
       ORDER BY timestamp ASC LIMIT ? OFFSET ?`,
      [req.params.userId, normChatId, limit, offset]
    );
    // Convertir fromMe de tinyint a boolean
    const mapped = messages.map(m => ({ ...m, fromMe: !!m.fromMe, pushName: sanitizeForJ2ME(m.pushName) }));
    const hasMore = offset > 0;
    console.log('[messages] chatId:', normChatId, 'total:', total, 'page:', page, 'devolviendo:', mapped.length);
    res.json({ messages: mapped, hasMore });
  } catch (err) {
    console.error('[messages] DB error:', err.message);
    res.status(500).json({ error: 'Error DB' });
  }
});

router.post('/send', async (req, res) => {
  const { userId, code, chatId, message } = req.body || {};

  if (!userId || !chatId || !message) {
    return res.status(400).json({ error: 'Faltan campos: userId, chatId, message' });
  }
  if (!checkAccess(userId, code)) {
    console.log('[send] 401 - checkAccess falló, userId:', userId);
    return res.status(401).json({ error: 'Codigo de acceso invalido' });
  }
  const session = getSession(userId);

  // Normalizar chatId: si viene como +51xxx o 51xxx, convertir a JID de WhatsApp
  let jid = chatId;
  if (!jid.includes('@')) {
    const digits = jid.replace(/\D/g, '');
    jid = digits + '@s.whatsapp.net';
  }
  // Normalizar @lid a @s.whatsapp.net
  if (jid.endsWith('@lid') && session && session.lidCache && session.lidCache[jid]) {
    jid = session.lidCache[jid] + '@s.whatsapp.net';
  }

  // Crear entrada de chat en DB si no existe
  const db = require('./db');
  try {
    await db.query(
      `INSERT IGNORE INTO chats (userId, chatId, name, lastMessage, lastTimestamp, unreadCount)
       VALUES (?, ?, 'No conocido', '', ?, 0)`,
      [userId, jid, Date.now()]
    );
  } catch (_) {}

  if (!session || session.status !== 'connected') {
    saveOutbox(userId, jid, message);
    console.log(`[send] Encolado para ${jid}`);
    return res.json({ queued: true, message: 'Mensaje encolado, se enviara cuando la sesion reconecte' });
  }

  try {
    // Resolver JID canónico para evitar crash #1785
    try {
      const [wa] = await session.sock.onWhatsApp(jid);
      if (wa?.exists && wa?.jid) jid = wa.jid;
    } catch (_) {}
    console.log('[send] Enviando a jid:', jid);
    const sent = await session.sock.sendMessage(jid, { text: message });
    console.log('[send] OK, id:', sent?.key?.id);

    const msgEntry = {
      id: sent?.key?.id || 'pending_' + Date.now(),
      fromMe: true,
      text: message,
      type: 'text',
      timestamp: Math.floor(Date.now() / 1000),
    };

    // Guardar mensaje en DB
    await db.query(
      `INSERT IGNORE INTO messages (userId, chatId, messageId, fromMe, text, type, timestamp)
       VALUES (?, ?, ?, 1, ?, 'text', ?)`,
      [userId, jid, msgEntry.id, message, msgEntry.timestamp]
    );
    // Actualizar chat con último mensaje
    await db.query(
      `UPDATE chats SET lastMessage=?, lastTimestamp=? WHERE userId=? AND chatId=?`,
      [message, msgEntry.timestamp * 1000, userId, jid]
    );

    console.log('[send] guardado en DB para', jid);
    touch(userId);
    res.json({ ok: true, id: sent?.key?.id || null });
  } catch (err) {
    console.error(err);
    saveOutbox(userId, jid, message);
    console.log(`[send] Encolado tras error para ${jid}`);
    res.json({ queued: true, message: 'Mensaje encolado tras error de envio' });
  }
});

router.get('/myphoto/:userId', auth, async (req, res) => {
  const userId = req.params.userId;
  const accessCode = req.query.code || req.headers['x-access-code'];
  
  console.log(`[myphoto] INICIO REQUEST`);
  console.log(`[myphoto] userId: ${userId}`);
  console.log(`[myphoto] accessCode: ${accessCode ? '***' : 'NULL'}`);
  
  const session = getSession(userId);
  console.log(`[myphoto] Session found: ${!!session}`);
  
  if (!session) {
    console.log(`[myphoto] ERROR: No hay sesion`);
    return res.json({ photo: null });
  }
  
  console.log(`[myphoto] Session.sock active: ${!!session.sock}`);
  console.log(`[myphoto] Session.sock.user: ${JSON.stringify(session.sock?.user)}`);
  
  try {
    // Obtener URL fresca cada vez para reflejar cambios de foto
    const myJid = session.sock?.user?.id;
    console.log(`[myphoto] myJid (session.sock.user.id): ${myJid}`);
    
    if (!myJid) {
      console.log(`[myphoto] ERROR: No se pudo obtener myJid`);
      return res.json({ photo: null });
    }
    
    let photoUrl = null;
    try {
      console.log(`[myphoto] Llamando session.sock.profilePictureUrl(${myJid})`);
      photoUrl = await session.sock.profilePictureUrl(myJid, 'image');
      console.log(`[myphoto] profilePictureUrl OK: ${photoUrl?.substring(0, 80)}...`);
    } catch (profileErr) {
      console.log(`[myphoto] profilePictureUrl ERROR: ${profileErr.message}`);
      console.log(`[myphoto] Stack: ${profileErr.stack}`);
    }
    
    if (!photoUrl) {
      console.log(`[myphoto] RESPUESTA: photo=null (sin URL)`);
      return res.json({ photo: null });
    }

    console.log(`[myphoto] Descargando imagen desde URL...`);
    const https = require('https');
    const http = require('http');
    const client = photoUrl.startsWith('https') ? https : http;
    
    client.get(photoUrl, (imgRes) => {
      console.log(`[myphoto] HTTP Response status: ${imgRes.statusCode}`);
      const chunks = [];
      imgRes.on('data', c => {
        chunks.push(c);
        console.log(`[myphoto] Chunk recibido: ${c.length} bytes, total acumulado: ${chunks.reduce((a,b)=>a+b.length,0)} bytes`);
      });
      imgRes.on('end', async () => {
        let buf = Buffer.concat(chunks);
        console.log(`[myphoto] Descarga completada: ${buf.length} bytes totales`);
        
        try {
          console.log(`[myphoto] Procesando imagen con sharp (resize 28x28, circular, fondo verde)`);
          const sharp = require('sharp');
          const size = 28;
          const r = size / 2;
          const raw = await sharp(buf)
            .resize(size, size, { fit: 'cover' })
            .raw()
            .ensureAlpha()
            .toBuffer();
          console.log(`[myphoto] Raw buffer creado: ${raw.length} bytes`);
          
          for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
              const dx = x - r, dy = y - r;
              if (dx * dx + dy * dy > r * r) {
                const i = (y * size + x) * 4;
                raw[i] = 7; raw[i+1] = 94; raw[i+2] = 84; raw[i+3] = 255;
              }
            }
          }
          console.log(`[myphoto] Mascara circular aplicada (fondo verde)`);
          
          buf = await sharp(raw, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
          console.log(`[myphoto] PNG convertido: ${buf.length} bytes`);
          
          const base64 = buf.toString('base64');
          console.log(`[myphoto] Base64 generado: ${base64.length} chars`);
          console.log(`[myphoto] RESPUESTA: photo=data:image/png;base64,${base64.substring(0, 50)}...`);
          
          res.json({ photo: 'data:image/png;base64,' + base64 });
        } catch (sharpErr) {
          console.log(`[myphoto] ERROR sharp: ${sharpErr.message}`);
          console.log(`[myphoto] Stack: ${sharpErr.stack}`);
          console.log(`[myphoto] RESPUESTA: photo=null (sharp error)`);
          res.json({ photo: null });
        }
      });
    }).on('error', (httpErr) => {
      console.log(`[myphoto] ERROR HTTP download: ${httpErr.message}`);
      console.log(`[myphoto] Stack: ${httpErr.stack}`);
      console.log(`[myphoto] RESPUESTA: photo=null (http error)`);
      res.json({ photo: null });
    });
  } catch (catchErr) {
    console.log(`[myphoto] ERROR GENERAL: ${catchErr.message}`);
    console.log(`[myphoto] Stack: ${catchErr.stack}`);
    console.log(`[myphoto] RESPUESTA: photo=null (general error)`);
    res.json({ photo: null });
  }
});

// POST /logout/:userId?code=XXX — cierra sesion, borra datos del servidor y BD
router.post('/logout/:userId', auth, async (req, res) => {
  const userId = req.params.userId;
  const session = getSession(userId);
  const fs = require('fs');
  const path = require('path');
  const SESSIONS_DIR = process.env.SESSIONS_DIR || '/app/sessions';

  try {
    if (session) {
      try { session.sock.end(undefined); } catch (_) {}
      const { sessions } = require('./sessionManager');
      sessions.delete(userId);
    }
    // Borrar archivos de sesion
    const userDir = path.join(SESSIONS_DIR, userId);
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (_) {}
    // Borrar de BD
    const db = require('./db');
    await db.query('DELETE FROM sessions WHERE userId=?', [userId]);
    await db.query('DELETE FROM chats WHERE userId=?', [userId]);
    await db.query('DELETE FROM messages WHERE userId=?', [userId]);
    console.log(`[logout] Sesion ${userId} eliminada completamente`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[logout] Error:', err.message);
    res.status(500).json({ error: 'Error cerrando sesion' });
  }
});

// GET /mediadoc/:userId/:messageId?code=XXX — sirve documento para descarga via navegador
router.get('/mediadoc/:userId/:messageId', auth, async (req, res) => {
  const fspath = require('path');
  const fs = require('fs');
  const mediaDir = fspath.join(process.env.SESSIONS_DIR || './sessions', req.params.userId, 'media');
  const msgId = req.params.messageId;
  // Buscar archivo que empiece con msgId + '_'
  try {
    const files = fs.readdirSync(mediaDir);
    const match = files.find(f => f.startsWith(msgId + '_'));
    if (!match) return res.status(404).json({ error: 'Documento no disponible' });
    const filePath = fspath.join(mediaDir, match);
    const fileName = match.substring(msgId.length + 1); // nombre original
    res.setHeader('Content-Disposition', 'attachment; filename="' + fileName + '"');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(fs.readFileSync(filePath));
  } catch (err) {
    res.status(500).json({ error: 'Error sirviendo documento' });
  }
});

// GET /mediaoriginal/:userId/:messageId?code=XXX — sirve imagen original sin redimensionar
router.get('/mediaoriginal/:userId/:messageId', auth, async (req, res) => {
  const fspath = require('path');
  const fs = require('fs');
  const mediaDir = fspath.join(process.env.SESSIONS_DIR || './sessions', req.params.userId, 'media');
  const msgId = req.params.messageId;
  const jpgPath = fspath.join(mediaDir, msgId + '.jpg');
  if (!fs.existsSync(jpgPath)) return res.status(404).json({ error: 'Imagen no disponible' });
  const buffer = fs.readFileSync(jpgPath);
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Content-Disposition', 'attachment; filename="' + msgId + '.jpg"');
  res.send(buffer);
});

// POST /sendimage/:userId?code=XXX&chatId=XXX — recibe imagen JPEG y la envia por WhatsApp
router.post('/sendimage/:userId', async (req, res) => {
  const userId = req.params.userId;
  const code = req.query.code || req.headers['x-access-code'];
  const chatId = req.query.chatId;
  if (!chatId) return res.status(400).json({ error: 'Falta chatId' });
  if (!checkAccess(userId, code)) return res.status(401).json({ error: 'Codigo de acceso invalido' });
  const session = getSession(userId);
  if (!session || session.status !== 'connected') return res.status(503).json({ error: 'Sesion no conectada' });
  const fspath = require('path');
  const fs = require('fs');
  const db = require('./db');
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', async () => {
    try {
      const imgBuffer = Buffer.concat(chunks);
      if (imgBuffer.length === 0) return res.status(400).json({ error: 'Imagen vacia' });
      let jid = chatId;
      if (!jid.includes('@')) jid = jid.replace(/\D/g, '') + '@s.whatsapp.net';
      if (jid.endsWith('@lid') && session.lidCache?.[jid]) jid = session.lidCache[jid] + '@s.whatsapp.net';
      try { const [wa] = await session.sock.onWhatsApp(jid); if (wa?.exists && wa?.jid) jid = wa.jid; } catch (_) {}
      const sent = await session.sock.sendMessage(jid, { image: imgBuffer, mimetype: 'image/jpeg' });
      const msgId = sent?.key?.id || ('img_' + Date.now());
      const ts = Math.floor(Date.now() / 1000);
      try {
        const mediaDir = fspath.join(process.env.SESSIONS_DIR || './sessions', userId, 'media');
        fs.mkdirSync(mediaDir, { recursive: true });
        fs.writeFileSync(fspath.join(mediaDir, msgId + '.jpg'), imgBuffer);
      } catch (_) {}
      await db.query(`INSERT IGNORE INTO messages (userId, chatId, messageId, fromMe, text, type, timestamp) VALUES (?, ?, ?, 1, '[imagen]', 'image', ?)`, [userId, jid, msgId, ts]);
      await db.query(`UPDATE chats SET lastMessage='[imagen]', lastTimestamp=? WHERE userId=? AND chatId=?`, [ts * 1000, userId, jid]);
      touch(userId);
      res.json({ ok: true, id: msgId });
    } catch (err) {
      console.error('[sendimage] Error:', err.message);
      res.status(500).json({ error: 'Error enviando imagen: ' + err.message });
    }
  });
});

// POST /senddoc/:userId?code=XXX&chatId=XXX&fileName=XXX — recibe archivo y lo envia como documento
router.post('/senddoc/:userId', async (req, res) => {
  const userId = req.params.userId;
  const code = req.query.code || req.headers['x-access-code'];
  const chatId = req.query.chatId;
  const fileName = req.query.fileName || 'archivo';
  if (!chatId) return res.status(400).json({ error: 'Falta chatId' });
  if (!checkAccess(userId, code)) return res.status(401).json({ error: 'Codigo de acceso invalido' });
  const session = getSession(userId);
  if (!session || session.status !== 'connected') return res.status(503).json({ error: 'Sesion no conectada' });
  const fspath = require('path');
  const fs = require('fs');
  const db = require('./db');
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', async () => {
    try {
      const docBuffer = Buffer.concat(chunks);
      if (docBuffer.length === 0) return res.status(400).json({ error: 'Archivo vacio' });
      let jid = chatId;
      if (!jid.includes('@')) jid = jid.replace(/\D/g, '') + '@s.whatsapp.net';
      if (jid.endsWith('@lid') && session.lidCache?.[jid]) jid = session.lidCache[jid] + '@s.whatsapp.net';
      try { const [wa] = await session.sock.onWhatsApp(jid); if (wa?.exists && wa?.jid) jid = wa.jid; } catch (_) {}
      const sent = await session.sock.sendMessage(jid, {
        document: docBuffer,
        fileName: fileName,
        mimetype: 'application/octet-stream',
      });
      const msgId = sent?.key?.id || ('doc_' + Date.now());
      const ts = Math.floor(Date.now() / 1000);
      const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      try {
        const mediaDir = fspath.join(process.env.SESSIONS_DIR || './sessions', userId, 'media');
        fs.mkdirSync(mediaDir, { recursive: true });
        fs.writeFileSync(fspath.join(mediaDir, msgId + '_' + safeFileName), docBuffer);
      } catch (_) {}
      await db.query(`INSERT IGNORE INTO messages (userId, chatId, messageId, fromMe, text, type, timestamp) VALUES (?, ?, ?, 1, ?, 'document', ?)`, [userId, jid, msgId, '[doc:' + fileName + ']', ts]);
      await db.query(`UPDATE chats SET lastMessage=?, lastTimestamp=? WHERE userId=? AND chatId=?`, ['[doc:' + fileName + ']', ts * 1000, userId, jid]);
      touch(userId);
      res.json({ ok: true, id: msgId });
    } catch (err) {
      console.error('[senddoc] Error:', err.message);
      res.status(500).json({ error: 'Error enviando documento: ' + err.message });
    }
  });
});

// POST /sendaudio/:userId?code=XXX&chatId=XXX — recibe audio AMR crudo y lo envia por WhatsApp
router.post('/sendaudio/:userId', async (req, res) => {
  const userId = req.params.userId;
  const code = req.query.code || req.headers['x-access-code'];
  const chatId = req.query.chatId;

  if (!chatId) return res.status(400).json({ error: 'Falta chatId' });
  if (!checkAccess(userId, code)) return res.status(401).json({ error: 'Codigo de acceso invalido' });

  const session = getSession(userId);
  if (!session || session.status !== 'connected') {
    return res.status(503).json({ error: 'Sesion no conectada' });
  }

  const fspath = require('path');
  const fs = require('fs');
  const db = require('./db');

  // Leer body como buffer (audio/amr raw)
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', async () => {
    try {
      const audioBuffer = Buffer.concat(chunks);
      if (audioBuffer.length === 0) return res.status(400).json({ error: 'Audio vacio' });
      if (audioBuffer.length > 300 * 1024) return res.status(400).json({ error: 'Audio muy grande (max 300KB)' });

      // Normalizar chatId
      let jid = chatId;
      if (!jid.includes('@')) {
        jid = jid.replace(/\D/g, '') + '@s.whatsapp.net';
      }
      if (jid.endsWith('@lid') && session.lidCache && session.lidCache[jid]) {
        jid = session.lidCache[jid] + '@s.whatsapp.net';
      }

      // Resolver JID canonico
      try {
        const [wa] = await session.sock.onWhatsApp(jid);
        if (wa?.exists && wa?.jid) jid = wa.jid;
      } catch (_) {}

      // Convertir AMR a OGG/Opus con ffmpeg (requerido por WhatsApp para reproduccion correcta)
      const os = require('os');
      const crypto = require('crypto');
      const tmpId = crypto.randomBytes(8).toString('hex');
      const tmpAmr = fspath.join(os.tmpdir(), tmpId + '.amr');
      const tmpOgg = fspath.join(os.tmpdir(), tmpId + '.ogg');
      fs.writeFileSync(tmpAmr, audioBuffer);

      let oggBuffer = null;
      let durationSec = 0;
      try {
        const { execSync } = require('child_process');
        const ffmpegBin = process.env.FFMPEG_PATH || 'ffmpeg';
        execSync(`"${ffmpegBin}" -y -i "${tmpAmr}" -avoid_negative_ts make_zero -ac 1 -c:a libopus "${tmpOgg}"`, { timeout: 20000 });
        oggBuffer = fs.readFileSync(tmpOgg);
        // Calcular duracion aproximada del audio original
        const durationOut = execSync(`"${ffmpegBin}" -i "${tmpAmr}" 2>&1 || true`).toString();
        const durMatch = durationOut.match(/Duration:\s*(\d+):(\d+):(\d+)/);
        if (durMatch) {
          durationSec = parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseInt(durMatch[3]);
        }
      } catch (convErr) {
        console.error('[sendaudio] ffmpeg conversion error:', convErr.message);
        // Fallback: intentar enviar AMR directo si ffmpeg falla
        oggBuffer = audioBuffer;
      } finally {
        try { fs.unlinkSync(tmpAmr); } catch (_) {}
        try { fs.unlinkSync(tmpOgg); } catch (_) {}
      }

      // Enviar audio como PTT (nota de voz) con OGG/Opus
      const sent = await session.sock.sendMessage(jid, {
        audio: oggBuffer,
        mimetype: 'audio/ogg; codecs=opus',
        ptt: true,
        seconds: durationSec || 1,
      });
      console.log('[sendaudio] OK, id:', sent?.key?.id, 'jid:', jid, 'duration:', durationSec);

      const msgId = sent?.key?.id || ('voice_' + Date.now());
      const ts = Math.floor(Date.now() / 1000);

      // Guardar OGG en disco para /media
      try {
        const mediaDir = fspath.join(process.env.SESSIONS_DIR || './sessions', userId, 'media');
        fs.mkdirSync(mediaDir, { recursive: true });
        fs.writeFileSync(fspath.join(mediaDir, msgId + '.ogg'), oggBuffer);
      } catch (_) {}

      // Guardar en DB
      await db.query(
        `INSERT IGNORE INTO messages (userId, chatId, messageId, fromMe, text, type, timestamp)
         VALUES (?, ?, ?, 1, '[audio]', 'audio', ?)`,
        [userId, jid, msgId, ts]
      );
      await db.query(
        `UPDATE chats SET lastMessage='[audio]', lastTimestamp=? WHERE userId=? AND chatId=?`,
        [ts * 1000, userId, jid]
      );

      touch(userId);
      res.json({ ok: true, id: msgId });
    } catch (err) {
      console.error('[sendaudio] Error:', err.message);
      res.status(500).json({ error: 'Error enviando audio: ' + err.message });
    }
  });
});

module.exports = router;

// GET /contactphoto/:userId/:chatId?code=XXX — foto de perfil de un contacto, recortada circular
router.get('/contactphoto/:userId/:chatId', auth, async (req, res) => {
  const userId = req.params.userId;
  const chatIdParam = req.params.chatId;
  const accessCode = req.query.code || req.headers['x-access-code'];
  const full = req.query.full === '1'; // si full=1, devolver foto sin recortar
  
  console.log(`[contactphoto] INICIO REQUEST`);
  console.log(`[contactphoto] userId: ${userId}`);
  console.log(`[contactphoto] chatId (raw): ${chatIdParam}`);
  console.log(`[contactphoto] accessCode: ${accessCode ? '***' : 'NULL'}`);
  console.log(`[contactphoto] full: ${full}`);
  
  const session = getSession(userId);
  console.log(`[contactphoto] Session found: ${!!session}`);
  console.log(`[contactphoto] Session.sock active: ${!!session?.sock}`);
  
  if (!session?.sock) {
    console.log(`[contactphoto] ERROR: No hay sesion o socket inactivo`);
    return res.json({ photo: null, error: 'No socket' });
  }
  
  let jid = chatIdParam;
  console.log(`[contactphoto] JID normalizacion - inicio: ${jid}`);
  
  if (!jid.includes('@')) {
    jid = jid.replace(/\D/g, '') + '@s.whatsapp.net';
    console.log(`[contactphoto] JID normalizacion - sin @, nuevo: ${jid}`);
  }
  
  if (jid.endsWith('@lid') && session.lidCache?.[jid]) {
    const originalJid = jid;
    jid = session.lidCache[jid] + '@s.whatsapp.net';
    console.log(`[contactphoto] JID normalizacion - @lid a @s.whatsapp.net: ${originalJid} -> ${jid}`);
  } else if (jid.endsWith('@lid')) {
    console.log(`[contactphoto] JID termina con @lid pero NO esta en lidCache`);
  }
  
  console.log(`[contactphoto] JID final para profilePictureUrl: ${jid}`);
  
  try {
    // Timeout de 8s para evitar bug #2498 de Baileys
    let photoUrl = null;
    try {
      console.log(`[contactphoto] Llamando session.sock.profilePictureUrl(${jid})`);
      const picType = full ? 'image' : 'preview';
      photoUrl = await Promise.race([
        session.sock.profilePictureUrl(jid, picType),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000))
      ]);
      console.log(`[contactphoto] profilePictureUrl OK: ${photoUrl?.substring(0, 80)}...`);
    } catch (e) {
      console.log(`[contactphoto] profilePictureUrl ERROR: ${e.message}`);
      console.log(`[contactphoto] Error stack: ${e.stack}`);
    }
    
    if (!photoUrl) {
      console.log(`[contactphoto] RESPUESTA: photo=null (sin URL)`);
      return res.json({ photo: null });
    }

    console.log(`[contactphoto] Descargando imagen desde URL...`);
    const https = require('https');
    const http = require('http');
    const client = photoUrl.startsWith('https') ? https : http;
    
    client.get(photoUrl, (imgRes) => {
      console.log(`[contactphoto] HTTP Response status: ${imgRes.statusCode}`);
      const chunks = [];
      imgRes.on('data', c => {
        chunks.push(c);
        console.log(`[contactphoto] Chunk recibido: ${c.length} bytes, total acumulado: ${chunks.reduce((a,b)=>a+b.length,0)} bytes`);
      });
      imgRes.on('end', async () => {
        let buf = Buffer.concat(chunks);
        console.log(`[contactphoto] Descarga completada: ${buf.length} bytes totales`);
        try {
          const sharp = require('sharp');
          if (full) {
            // Foto completa: redimensionar a 240x320 (pantalla Nokia) con cover para llenar
            console.log(`[contactphoto] Procesando imagen FULL (240x320 cover)`);
            buf = await sharp(buf)
              .resize(240, 320, { fit: 'cover', position: 'centre' })
              .jpeg({ quality: 80 })
              .toBuffer();
            console.log(`[contactphoto] JPEG full: ${buf.length} bytes`);
            const base64full = buf.toString('base64');
            console.log(`[contactphoto] RESPUESTA full: photo=data:image/jpeg;base64,...`);
            return res.json({ photo: 'data:image/jpeg;base64,' + base64full });
          }
          console.log(`[contactphoto] Procesando imagen con sharp (resize 30x30, circular, fondo gris)`);
          const size = 30;
          const r = size / 2;
          const raw = await sharp(buf)
            .resize(size, size, { fit: 'cover' })
            .raw()
            .ensureAlpha()
            .toBuffer();
          console.log(`[contactphoto] Raw buffer creado: ${raw.length} bytes`);
          
          // Color fondo verde del header para avatar contacto (0x075E54)
          for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
              const dx = x - r, dy = y - r;
              if (dx * dx + dy * dy > r * r) {
                const i = (y * size + x) * 4;
                raw[i] = 0x07; raw[i+1] = 0x5E; raw[i+2] = 0x54; raw[i+3] = 255;
              }
            }
          }
          console.log(`[contactphoto] Mascara circular aplicada`);
          
          buf = await sharp(raw, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
          console.log(`[contactphoto] PNG convertido: ${buf.length} bytes`);
          
          const base64 = buf.toString('base64');
          console.log(`[contactphoto] Base64 generado: ${base64.length} chars`);
          console.log(`[contactphoto] RESPUESTA: photo=data:image/png;base64,${base64.substring(0, 50)}...`);
          
          res.json({ photo: 'data:image/png;base64,' + base64 });
        } catch (sharpErr) {
          console.log(`[contactphoto] ERROR sharp: ${sharpErr.message}`);
          console.log(`[contactphoto] Stack: ${sharpErr.stack}`);
          console.log(`[contactphoto] RESPUESTA: photo=null (sharp error)`);
          res.json({ photo: null });
        }
      });
    }).on('error', (httpErr) => {
      console.log(`[contactphoto] ERROR HTTP download: ${httpErr.message}`);
      console.log(`[contactphoto] Stack: ${httpErr.stack}`);
      console.log(`[contactphoto] RESPUESTA: photo=null (http error)`);
      res.json({ photo: null });
    });
  } catch (catchErr) {
    console.log(`[contactphoto] ERROR GENERAL: ${catchErr.message}`);
    console.log(`[contactphoto] Stack: ${catchErr.stack}`);
    console.log(`[contactphoto] RESPUESTA: photo=null (general error)`);
    res.json({ photo: null });
  }
});

// GET /presence/:userId/:chatId?code=XXX
// Devuelve si el otro esta escribiendo, en linea, y su ultima conexion
router.get('/presence/:userId/:chatId', auth, async (req, res) => {
  const session = getSession(req.params.userId);
  let chatId = req.params.chatId;
  if (!chatId.includes('@')) {
    chatId = chatId.replace(/\D/g, '') + '@s.whatsapp.net';
  } else if (chatId.endsWith('@lid') && session.lidCache[chatId]) {
    chatId = session.lidCache[chatId] + '@s.whatsapp.net';
  }
  try { await session.sock.presenceSubscribe(chatId); } catch (_) {}
  const data = session.presence?.get(chatId);
  const fresh = data && (Date.now() - data.timestamp < 15000);
  const isTyping = fresh && (data.typing || data.recording);
  const isOnline = fresh && data.online;
  let lastSeenFormatted = null;
  if (!isTyping && !isOnline && data?.lastSeen) {
    const diffMin = Math.floor((Date.now() / 1000 - data.lastSeen) / 60);
    if (diffMin < 1) lastSeenFormatted = 'hace instantes';
    else if (diffMin < 60) lastSeenFormatted = 'hace ' + diffMin + ' min';
    else if (diffMin < 1440) lastSeenFormatted = 'hace ' + Math.floor(diffMin / 60) + ' h';
    else lastSeenFormatted = 'hace ' + Math.floor(diffMin / 1440) + ' d';
  }
  res.json({ typing: !!isTyping, online: !!isOnline, lastSeen: lastSeenFormatted });
});

// GET /media/:userId/:messageId?code=XXX&chatId=XXX
// Imagenes: escala a 240x320 y devuelve base64
// Audios: sirve bytes directos con limite 300KB
router.get('/media/:userId/:messageId', auth, async (req, res) => {
  const session = getSession(req.params.userId);
  const { chatId } = req.query;
  console.log('[media] Request - userId:', req.params.userId, 'messageId:', req.params.messageId, 'chatId:', chatId);

  if (!chatId) return res.status(400).json({ error: 'Falta chatId' });

  const fspath = require('path');
  const fs = require('fs');
  const mediaDir = fspath.join(process.env.SESSIONS_DIR || './sessions', req.params.userId, 'media');
  const msgId = req.params.messageId;

  try {
    // --- AUDIO: buscar en disco ---
    const amrPath = fspath.join(mediaDir, msgId + '.amr');
    const oggPath = fspath.join(mediaDir, msgId + '.ogg');
    const mp3Path = fspath.join(mediaDir, msgId + '.mp3');

    if (fs.existsSync(amrPath)) {
      console.log('[media] Sirviendo AMR desde disco');
      return res.json({ data: 'data:audio/amr;base64,' + fs.readFileSync(amrPath).toString('base64'), type: 'audio' });
    }
    if (fs.existsSync(mp3Path)) {
      console.log('[media] Sirviendo MP3 desde disco');
      const buf = fs.readFileSync(mp3Path);
      if (buf.length > 300 * 1024) return res.json({ error: 'Audio muy grande', tooLarge: true });
      return res.json({ data: 'data:audio/mpeg;base64,' + buf.toString('base64'), type: 'audio' });
    }
    if (fs.existsSync(oggPath)) {
      console.log('[media] Sirviendo OGG desde disco, intentando conversion...');
      const buf = fs.readFileSync(oggPath);
      if (buf.length > 300 * 1024) return res.json({ error: 'Audio muy grande', tooLarge: true });
      try {
        const { execSync } = require('child_process');
        const ffmpegBin = process.env.FFMPEG_PATH || 'ffmpeg';
        execSync(`"${ffmpegBin}" -y -i "${oggPath}" -af "volume=2.5" -ar 22050 -ac 1 -b:a 32k "${mp3Path}"`, { timeout: 15000 });
        const mp3Buf = fs.readFileSync(mp3Path);
        if (mp3Buf.length > 300 * 1024) return res.json({ error: 'Audio muy grande', tooLarge: true });
        return res.json({ data: 'data:audio/mpeg;base64,' + mp3Buf.toString('base64'), type: 'audio' });
      } catch (_) {
        return res.json({ data: 'data:audio/ogg;base64,' + buf.toString('base64'), type: 'audio' });
      }
    }

    // --- IMAGEN: buscar en disco ---
    const jpgPath = fspath.join(mediaDir, msgId + '.jpg');
    if (fs.existsSync(jpgPath)) {
      console.log('[media] Sirviendo imagen desde disco');
      let buffer = fs.readFileSync(jpgPath);
      try {
        const sharp = require('sharp');
        buffer = await sharp(buffer)
          .resize(240, 320, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 70 })
          .toBuffer();
      } catch (_) {}
      return res.json({ data: 'data:image/jpeg;base64,' + buffer.toString('base64'), type: 'image' });
    }

    console.log('[media] Archivo no encontrado en disco para:', msgId);
    return res.status(404).json({ error: 'Media no disponible' });

  } catch (err) {
    console.error('[media] Error:', err);
    res.status(500).json({ error: 'No se pudo descargar el media' });
  }
});


