# Diseño: mysql-migration

## Visión General

Se migra la capa de persistencia de WPJava desde Maps en RAM + archivos JSON a MySQL. El cambio es quirúrgico: se introduce un nuevo módulo `db.js` (DB_Layer) y se modifican únicamente `sessionManager.js` y `routes.js` para usar ese módulo en lugar de los Maps. Toda la lógica de Baileys, la lógica de reconexión, el `lidCache` en disco y el outbox en disco se mantienen sin tocar.

El cliente JAR Nokia recibirá soporte de paginación mediante los nuevos parámetros `page` en los endpoints `/chats` y `/messages`, que ya existen en la API pero ahora trabajarán con datos reales de la DB.

## Arquitectura

```
┌─────────────────────────────────────────────────────┐
│                   Nokia J2ME Client                  │
│              (polling HTTP cada 10s)                 │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP REST
┌──────────────────────▼──────────────────────────────┐
│                   routes.js                          │
│  GET /chats  GET /messages  POST /send  POST /mark  │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│               sessionManager.js                      │
│  sock (RAM)  lidCache (disco)  contacts (RAM)       │
│  presence (RAM)  status/qr/accessCode (RAM)         │
│  ── eventos Baileys ──────────────────────────────  │
│  messages.upsert → db.saveMessage + db.upsertChat   │
│  messaging-history.set → db.upsertChat (bulk)       │
└──────┬───────────────────────────────────────────────┘
       │
┌──────▼──────────────────────────────────────────────┐
│                    db.js (DB_Layer)                  │
│  saveMessage  upsertChat  getChats  getMessages     │
│  markChatAsRead  initDB                             │
└──────┬──────────────────────────────────────────────┘
       │ mysql2 pool
┌──────▼──────────────────────────────────────────────┐
│                      MySQL                           │
│         tablas: chats, messages                      │
└─────────────────────────────────────────────────────┘
```

El servidor Express, el outbox en disco y el `lidCache` en disco no cambian de ubicación ni comportamiento.

## Componentes e Interfaces

### db.js — DB_Layer

Módulo nuevo. Crea y exporta un pool `mysql2/promise`. Expone:

```js
// Inicializar pool y crear tablas si no existen
async function initDB()

// Insertar o ignorar mensaje duplicado
async function saveMessage(userId, chatId, msgEntry)
// msgEntry: { id, fromMe, text, type, timestamp, pushName, ack, duration }

// Insertar o actualizar chat
async function upsertChat(userId, chatId, chatData)
// chatData: { name, lastMessage, lastTimestamp, unreadCount }

// Lista de chats paginada (10 por página), filtrada y ordenada
async function getChats(userId, page)
// Retorna: { chats: [...], hasMore: boolean }

// Lista de mensajes paginada con lógica de ancla en no leídos
async function getMessages(userId, chatId, page)
// Retorna: { messages: [...], hasMore: boolean }

// Poner unreadCount = 0
async function markChatAsRead(userId, chatId)
```

### sessionManager.js — cambios

- Eliminar: `entry.chats`, `entry.messages`, `saveChatsCache`, `loadChatsCache`, `saveInbox`, `loadInbox`.
- En `messages.upsert`: reemplazar escritura en Maps por llamadas a `db.saveMessage` + `db.upsertChat`.
- En `messaging-history.set`: reemplazar escritura en Maps por llamadas a `db.upsertChat` (bulk, sin sobreescribir si ya existe un chat con datos más recientes).
- Todo lo demás (eventos, lógica LID, reconexión, outbox) se mantiene igual.

### routes.js — cambios

- `GET /chats/:userId`: reemplazar lectura de `session.chats` por `db.getChats(userId, page)`.
- `GET /messages/:userId/:chatId`: reemplazar lectura de `session.messages` por `db.getMessages(userId, chatId, page)`.
- `POST /markAsRead/:userId/:chatId`: reemplazar mutación del Map por `db.markChatAsRead(userId, chatId)`.
- `POST /send`: después del envío exitoso, llamar `db.saveMessage` + `db.upsertChat`.
- Endpoints `/myphoto`, `/presence`, `/media` no se modifican.

## Modelos de Datos

### Tabla `chats`

```sql
CREATE TABLE IF NOT EXISTS chats (
  user_id        VARCHAR(36)  NOT NULL,
  chat_id        VARCHAR(100) NOT NULL,
  name           VARCHAR(255) NOT NULL DEFAULT 'No conocido',
  last_message   TEXT,
  last_timestamp BIGINT       NOT NULL DEFAULT 0,
  unread_count   INT          NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, chat_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

- `user_id`: UUID del usuario WPJava (mismo que el directorio de sesión).
- `chat_id`: JID normalizado de WhatsApp (siempre `@s.whatsapp.net` o `@g.us`, nunca `@lid`).
- `last_timestamp`: milisegundos epoch (igual que el campo actual en RAM).

### Tabla `messages`

```sql
CREATE TABLE IF NOT EXISTS messages (
  user_id    VARCHAR(36)  NOT NULL,
  chat_id    VARCHAR(100) NOT NULL,
  message_id VARCHAR(100) NOT NULL,
  from_me    TINYINT(1)   NOT NULL DEFAULT 0,
  text       TEXT,
  type       VARCHAR(20)  NOT NULL DEFAULT 'text',
  timestamp  BIGINT       NOT NULL,
  push_name  VARCHAR(100),
  ack        TINYINT(1),
  duration   INT,
  PRIMARY KEY (user_id, chat_id, message_id),
  INDEX idx_chat_ts (user_id, chat_id, timestamp)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

- `timestamp`: segundos epoch (igual que el campo actual `msgEntry.timestamp`).
- El índice `idx_chat_ts` optimiza las queries de paginación por timestamp.

### Variables de entorno necesarias

```
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=
DB_NAME=wpjava
```

## Diseño de Paginación

### GET /chats — lógica SQL

```sql
-- Contar total para hasMore
SELECT COUNT(*) FROM chats
WHERE user_id = ?
  AND NOT (name = 'No conocido' AND (last_message IS NULL OR last_message = ''))
ORDER BY last_timestamp DESC
LIMIT 10 OFFSET (page * 10)
```

Se obtienen 11 filas; si hay 11 se devuelven 10 y `hasMore=true`.

### GET /messages — lógica de ancla

El cálculo del offset depende de `unreadCount`:

```
totalMessages   = COUNT(*) WHERE user_id=? AND chat_id=?
unread          = unread_count de la tabla chats

Si unread = 0:
  anchorOffset  = MAX(0, totalMessages - 10)   ← últimos 10
  
Si unread > 0:
  firstUnreadPos = totalMessages - unread       ← posición del 1er no leído (0-based)
  anchorOffset   = firstUnreadPos               ← empieza ahí

pageOffset      = anchorOffset - (page * 10)   ← retroceder por páginas
finalOffset     = MAX(0, pageOffset)
hasMore         = finalOffset > 0
```

Los mensajes se devuelven `ORDER BY timestamp ASC` dentro de la página para que el Nokia los muestre en orden cronológico.

## Propiedades de Corrección

*Una propiedad es una característica o comportamiento que debe cumplirse en todas las ejecuciones válidas del sistema. Las propiedades sirven de puente entre la especificación legible por humanos y las garantías de corrección verificables automáticamente.*

### Propiedad 1: Round-trip de persistencia de mensajes

*Para cualquier* userId, chatId y msgEntry válido, llamar `saveMessage` y luego consultar la DB debe devolver un mensaje con los mismos campos `id`, `fromMe`, `text`, `type`, `timestamp`.

**Valida: Requisitos 1.1, 6.1**

### Propiedad 2: Idempotencia de inserción de mensajes

*Para cualquier* msgEntry, insertar el mismo mensaje dos veces debe resultar en exactamente un registro en la DB (el count no cambia en la segunda inserción).

**Valida: Requisito 1.2**

### Propiedad 3: Lógica de unreadCount según fromMe

*Para cualquier* chat con un unreadCount inicial conocido:
- Si se guarda un mensaje con `fromMe=false`, el nuevo unreadCount del chat debe ser `inicial + 1`.
- Si se guarda un mensaje con `fromMe=true`, el unreadCount debe permanecer igual al inicial.

**Valida: Requisitos 1.6, 1.7**

### Propiedad 4: Orden y tamaño de página en getChats

*Para cualquier* conjunto de chats en la DB y cualquier página `N` válida, `getChats(userId, N)` debe devolver como máximo 10 chats, todos ordenados estrictamente por `lastTimestamp DESC`.

**Valida: Requisito 3.1**

### Propiedad 5: Consistencia de hasMore en chats

*Para cualquier* userId y página `N`, el campo `hasMore` de `getChats(userId, N)` debe ser `true` si y solo si `getChats(userId, N+1)` devuelve al menos un chat.

**Valida: Requisitos 3.3, 3.4**

### Propiedad 6: Filtro de chats desconocidos

*Para cualquier* resultado de `getChats`, ningún elemento debe tener simultáneamente `name === 'No conocido'` y `lastMessage` vacío o nulo.

**Valida: Requisito 3.6**

### Propiedad 7: Completitud de campos en respuestas

*Para cualquier* chat devuelto por `getChats`, deben estar presentes los campos `id`, `name`, `lastMessage`, `lastTimestamp`, `unreadCount`. *Para cualquier* mensaje devuelto por `getMessages`, deben estar presentes los campos `id`, `fromMe`, `text`, `type`, `timestamp`.

**Valida: Requisitos 3.7, 4.8**

### Propiedad 8: Posicionamiento en no leídos

*Para cualquier* chat con `unreadCount > 0`, el primer elemento devuelto por `getMessages(userId, chatId, 0)` debe ser el mensaje más antiguo de los no leídos (posición `totalMessages - unreadCount` ordenado por timestamp ASC).

**Valida: Requisito 4.4**

### Propiedad 9: Paginación contigua sin solapamiento

*Para cualquier* chat y cualquier página `N`, la unión de los mensajes de `getMessages(userId, chatId, N)` y `getMessages(userId, chatId, N+1)` no debe contener duplicados y debe estar totalmente ordenada por timestamp ASC.

**Valida: Requisito 4.5**

### Propiedad 10: Idempotencia de markAsRead

*Para cualquier* chat, llamar `markChatAsRead` dos veces consecutivas debe resultar en `unreadCount = 0` y no debe lanzar error en ninguna de las dos llamadas.

**Valida: Requisito 5.1**

## Manejo de Errores

- `initDB` intenta crear las tablas al arrancar. Si falla (MySQL no disponible), registra el error y reintenta en cada operación individual.
- `saveMessage` y `upsertChat` usan `INSERT IGNORE` / `ON DUPLICATE KEY UPDATE`, por lo que los duplicados no generan errores.
- Si una query falla en tiempo de ejecución, el DB_Layer lanza el error al llamador; `sessionManager.js` y `routes.js` capturan estos errores con `.catch(e => console.error(...))` para no interrumpir el flujo de Baileys ni devolver 500 al Nokia.
- `getChats` y `getMessages` devuelven arrays vacíos con `hasMore: false` ante cualquier error de DB, manteniendo compatibilidad con el Nokia.
- La función `markChatAsRead` es tolerante a chatId inexistente (UPDATE sin filas afectadas no es error).

## Estrategia de Testing

### Tests unitarios

Verifican comportamientos concretos del DB_Layer con una DB de prueba (base de datos `wpjava_test` en el mismo XAMPP):

- Insertar y recuperar un mensaje: verificar campos individuales.
- Insertar chat duplicado: verificar que ON DUPLICATE KEY UPDATE funciona.
- `markAsRead` en chat inexistente: no lanza error.
- `getChats` con cero chats: devuelve `{ chats: [], hasMore: false }`.
- `getMessages` cuando `unreadCount = 0` y cuando `unreadCount > 0`: verificar posición del primer elemento.

### Tests de propiedades (property-based)

Usando la librería `fast-check` (compatible con Node.js/Jest).

Cada test de propiedad se configura con mínimo 100 iteraciones. Cada uno está anotado con el formato:
**Feature: mysql-migration, Property N: descripción**

- **Property 1** — Round-trip saveMessage: generar msgEntry aleatorio → save → query → comparar campos.
- **Property 2** — Idempotencia de inserción: save mismo mensaje dos veces → COUNT = 1.
- **Property 3** — unreadCount según fromMe: insertar N mensajes mixtos → verificar count = mensajes_entrantes.
- **Property 4** — Orden y tamaño de getChats: insertar K chats aleatorios → verificar sort DESC y len ≤ 10.
- **Property 5** — hasMore consistente en chats: verificar que hasMore ↔ existe página siguiente.
- **Property 6** — Filtro de desconocidos: insertar chats con name='No conocido'/lastMessage='' → no aparecen.
- **Property 7** — Completitud de campos: todos los campos requeridos presentes en cada resultado.
- **Property 8** — Posicionamiento en no leídos: insertar N mensajes con unreadCount=K → primer elemento correcto.
- **Property 9** — Paginación contigua: páginas consecutivas no se solapan y están en orden.
- **Property 10** — Idempotencia de markAsRead: llamar dos veces → unreadCount = 0 ambas veces.

El framework de tests es **Jest** con **fast-check**. Los tests requieren una instancia MySQL accesible (variables de entorno de test apuntan a `wpjava_test`).
