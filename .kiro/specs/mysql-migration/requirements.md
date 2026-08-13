# Documento de Requisitos

## Introducción

Migración del backend Node.js de WPJava de almacenamiento en memoria (Maps en RAM + archivos JSON) a MySQL. WPJava es un servidor Express + Baileys que actúa como puente entre un cliente J2ME (Nokia) y WhatsApp. Actualmente los chats y mensajes se guardan en Maps en RAM con persistencia parcial en archivos JSON. La migración reemplaza esa capa por MySQL como fuente de verdad, manteniendo toda la lógica de Baileys intacta y la compatibilidad total con el cliente JAR existente.

## Glosario

- **System**: El servidor Node.js WPJava (Express + Baileys)
- **DB**: La base de datos MySQL que reemplaza el almacenamiento en RAM
- **Session**: Sesión activa de Baileys para un userId, incluyendo el objeto `sock`
- **Chat**: Conversación de WhatsApp identificada por un JID normalizado
- **Message**: Mensaje individual dentro de un Chat, con su timestamp de Baileys
- **JID**: Identificador de WhatsApp (e.g. `51999000000@s.whatsapp.net` o `120363xxx@g.us`)
- **LidCache**: Archivo JSON en disco que mapea JIDs `@lid` a números de teléfono reales
- **unreadCount**: Contador de mensajes no leídos de un Chat
- **Page**: Página de resultados paginados (índice basado en 0)
- **Baileys**: Librería que gestiona la conexión WebSocket con WhatsApp
- **Nokia_Client**: El cliente J2ME que hace polling HTTP al System cada 10s
- **DB_Layer**: Módulo Node.js nuevo (`db.js`) que encapsula todas las queries SQL

## Requisitos

### Requisito 1: Persistencia de mensajes en MySQL

**User Story:** Como operador del sistema, quiero que todos los mensajes recibidos desde que el usuario se vincula se guarden en MySQL, para tener historial completo sin límite.

#### Criterios de Aceptación

1. WHEN Baileys emite el evento `messages.upsert`, THE System SHALL insertar cada mensaje válido en la DB con su chatId, messageId, fromMe, texto, tipo, timestamp de Baileys y pushName.
2. WHEN un mensaje ya existe en la DB con el mismo messageId y chatId, THE System SHALL ignorar la inserción duplicada sin lanzar error.
3. THE DB_Layer SHALL exponer una función `saveMessage(userId, chatId, msgEntry)` que ejecute la inserción en la tabla `messages`.
4. WHEN Baileys emite `messages.upsert`, THE System SHALL actualizar o insertar el Chat correspondiente en la DB con los campos name, lastMessage, lastTimestamp y unreadCount.
5. THE DB_Layer SHALL exponer una función `upsertChat(userId, chatId, chatData)` que ejecute un INSERT ... ON DUPLICATE KEY UPDATE en la tabla `chats`.
6. WHEN se recibe un mensaje de un remitente no propio (fromMe = false), THE System SHALL incrementar el unreadCount del Chat en la DB en 1.
7. WHEN se recibe un mensaje propio (fromMe = true, enviado por el usuario), THE System SHALL mantener el unreadCount del Chat sin modificarlo.

### Requisito 2: Eliminación de Maps en RAM

**User Story:** Como desarrollador, quiero eliminar `entry.chats` y `entry.messages` (Maps en RAM) de sessionManager.js, para que MySQL sea la única fuente de verdad.

#### Criterios de Aceptación

1. THE System SHALL eliminar las propiedades `entry.chats` y `entry.messages` del objeto de sesión en `sessionManager.js`.
2. THE System SHALL eliminar las funciones `saveChatsCache`, `loadChatsCache`, `saveInbox` y `loadInbox` de `sessionManager.js`.
3. THE System SHALL eliminar la lectura y escritura de los archivos `chats_cache.json` y `messages_cache.json`.
4. THE System SHALL eliminar la lectura y escritura del archivo `inbox.json`.
5. WHILE una sesión de Baileys está activa, THE System SHALL mantener en RAM únicamente el objeto `sock`, `lidCache`, `contacts`, `presence`, `status`, `qr` y `accessCode`.
6. THE System SHALL conservar sin modificar toda la lógica de eventos de Baileys (`connection.update`, `contacts.upsert`, `lid-mapping.update`, `messaging-history.set`, `messages.update`, `presence.update`).
7. THE System SHALL conservar el archivo `lid_cache.json` en disco sin cambios.

### Requisito 3: API GET /chats con paginación

**User Story:** Como Nokia_Client, quiero obtener la lista de chats paginada de 10 en 10, para navegar entre conversaciones sin recibir todo el historial de golpe.

#### Criterios de Aceptación

1. WHEN Nokia_Client hace GET `/chats/:userId?code=XXX&page=N`, THE System SHALL devolver exactamente 10 chats (o menos si no hay suficientes) ordenados por lastTimestamp DESC.
2. WHEN el parámetro `page` no está presente en la request, THE System SHALL asumir `page=0`.
3. THE System SHALL incluir en la respuesta el campo `hasMore: true` si existe al menos un chat adicional más allá de los devueltos en la página actual.
4. THE System SHALL incluir en la respuesta el campo `hasMore: false` si no hay más chats.
5. WHEN Nokia_Client solicita una página vacía (más allá del total de chats), THE System SHALL devolver `chats: []` y `hasMore: false`.
6. THE System SHALL excluir de los resultados chats cuyo name sea 'No conocido' y cuyo lastMessage esté vacío, manteniendo el mismo filtro que la implementación actual.
7. THE System SHALL devolver para cada chat los campos: `id`, `name`, `lastMessage`, `lastTimestamp`, `unreadCount`.

### Requisito 4: API GET /messages con paginación y posicionamiento en no leídos

**User Story:** Como Nokia_Client, quiero obtener los mensajes de un chat paginados, con la primera página mostrando el primer mensaje no leído cuando existan mensajes no leídos.

#### Criterios de Aceptación

1. WHEN Nokia_Client hace GET `/messages/:userId/:chatId?code=XXX&page=N`, THE System SHALL devolver exactamente 10 mensajes (o menos si no hay suficientes) del chat especificado.
2. WHEN el parámetro `page` no está presente en la request, THE System SHALL asumir `page=0`.
3. WHEN el Chat tiene unreadCount igual a 0, THE System SHALL devolver los 10 mensajes más recientes en `page=0`, ordenados por timestamp ASC dentro de la página.
4. WHEN el Chat tiene unreadCount mayor a 0, THE System SHALL posicionar `page=0` de forma que el primer mensaje no leído sea el primer elemento de la respuesta, devolviendo los siguientes 10 mensajes desde ese punto.
5. WHEN Nokia_Client solicita `page=1` o mayor, THE System SHALL devolver mensajes más antiguos retrocediendo de 10 en 10 desde el ancla de `page=0`.
6. THE System SHALL incluir `hasMore: true` si existen mensajes más antiguos que los devueltos.
7. THE System SHALL incluir `hasMore: false` si no hay mensajes más antiguos.
8. THE System SHALL devolver para cada mensaje los campos: `id`, `fromMe`, `text`, `type`, `timestamp`, `pushName`, y opcionalmente `ack` y `duration`.

### Requisito 5: API POST /markAsRead

**User Story:** Como Nokia_Client, quiero marcar un chat como leído, para que el unreadCount se ponga a 0 en la DB.

#### Criterios de Aceptación

1. WHEN Nokia_Client hace POST `/markAsRead/:userId/:chatId?code=XXX`, THE System SHALL actualizar el unreadCount del Chat a 0 en la DB.
2. WHEN el chatId no existe en la DB, THE System SHALL responder con `{ ok: true }` sin lanzar error.
3. THE DB_Layer SHALL exponer una función `markChatAsRead(userId, chatId)` que ejecute UPDATE en la tabla `chats`.

### Requisito 6: API POST /send

**User Story:** Como Nokia_Client, quiero enviar mensajes y que queden guardados en MySQL inmediatamente.

#### Criterios de Aceptación

1. WHEN Nokia_Client hace POST `/send` y el mensaje se envía exitosamente, THE System SHALL insertar el mensaje enviado en la DB con fromMe=true antes de responder al cliente.
2. WHEN Nokia_Client hace POST `/send` y el mensaje se envía exitosamente, THE System SHALL actualizar el Chat en la DB con el nuevo lastMessage y lastTimestamp.
3. WHEN la sesión no está conectada al momento del envío, THE System SHALL encolar el mensaje en `outbox.json` sin intentar insertar en la DB (la inserción ocurrirá cuando Baileys confirme la entrega vía `messages.upsert`).
4. THE System SHALL mantener la lógica de outbox en disco (`saveOutbox`, `loadOutbox`, `processOutbox`) sin cambios.

### Requisito 7: Esquema SQL y módulo DB_Layer

**User Story:** Como desarrollador, quiero un esquema SQL claro y un módulo DB_Layer encapsulado, para que el resto del código interactúe con MySQL a través de una interfaz limpia.

#### Criterios de Aceptación

1. THE DB_Layer SHALL implementar un pool de conexiones MySQL usando la librería `mysql2` con el método `promise()`.
2. THE System SHALL crear una tabla `chats` con columnas: `user_id` (VARCHAR 36), `chat_id` (VARCHAR 100), `name` (VARCHAR 255), `last_message` (TEXT), `last_timestamp` (BIGINT), `unread_count` (INT DEFAULT 0), con clave primaria compuesta `(user_id, chat_id)`.
3. THE System SHALL crear una tabla `messages` con columnas: `user_id` (VARCHAR 36), `chat_id` (VARCHAR 100), `message_id` (VARCHAR 100), `from_me` (TINYINT), `text` (TEXT), `type` (VARCHAR 20), `timestamp` (BIGINT), `push_name` (VARCHAR 100), `ack` (TINYINT), `duration` (INT), con clave primaria compuesta `(user_id, chat_id, message_id)`.
4. THE DB_Layer SHALL exponer funciones: `saveMessage`, `upsertChat`, `getChats`, `getMessages`, `markChatAsRead`, `initDB`.
5. THE DB_Layer SHALL leer las credenciales de conexión desde variables de entorno: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`.
6. THE System SHALL proveer un archivo `schema.sql` con los statements CREATE TABLE IF NOT EXISTS para ambas tablas.
7. IF la conexión a MySQL falla al iniciar, THEN THE System SHALL registrar el error en consola y continuar intentando reconectar sin detener el servidor Express.

### Requisito 8: Compatibilidad con el cliente Nokia

**User Story:** Como Nokia_Client, quiero que el formato JSON de las respuestas REST no cambie, para no tener que actualizar el JAR.

#### Criterios de Aceptación

1. THE System SHALL mantener exactamente el mismo formato de respuesta JSON para GET `/chats/:userId`, GET `/messages/:userId/:chatId`, POST `/send`, POST `/markAsRead/:userId/:chatId` y GET `/status/:userId`.
2. THE System SHALL mantener los mismos parámetros de autenticación (`code` por query param o header `x-access-code`).
3. THE System SHALL mantener la función `sanitizeForJ2ME` sin modificaciones.
4. THE System SHALL mantener los endpoints `/myphoto`, `/presence` y `/media` sin cambios funcionales.
5. WHEN Nokia_Client envía un chatId sin sufijo `@`, THE System SHALL seguir normalizando a `@s.whatsapp.net` antes de consultar la DB, igual que la implementación actual.
