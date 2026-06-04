# 📱 Google Messages Sender Bot v1.0

Bot de Telegram que envía **SMS** a través de tu Android vinculado con Google Messages.

---

## ⚙️ Configuración rápida

### 1. Configura el bot

Edita `index.js` y cambia estas dos constantes al principio del archivo:

```js
const TOKEN            = "TU_TOKEN_DE_TELEGRAM";   // obtén uno en @BotFather
const ALLOWED_USERNAME = "TU_USUARIO_TELEGRAM";    // solo este usuario puede usarlo
```

O usa variables de entorno (recomendado para Railway/Render):
```
TELEGRAM_TOKEN=tu_token
ALLOWED_USER=tu_usuario
```

---

## 🚀 Despliegue

### Opción A — VPS / PC local

```bash
# 1. Requisitos: Node.js 18+, Chrome/Chromium
npm install

# 2. Ejecutar
node index.js

# En segundo plano:
nohup node index.js > bot.log 2>&1 & disown
```

### Opción B — Railway (con Docker)

1. Sube el proyecto a GitHub
2. Crea un proyecto en [railway.app](https://railway.app)
3. Conecta el repositorio → Railway detecta el Dockerfile automáticamente
4. Añade las variables de entorno `TELEGRAM_TOKEN` y `ALLOWED_USER`
5. Añade un **Volumen** en `/app/session_data` para persistir la sesión

### Opción C — Render (Background Worker)

- Runtime: Docker
- Variables de entorno: `TELEGRAM_TOKEN`, `ALLOWED_USER`

---

## 📱 Comandos de Telegram

| Comando | Descripción |
|---------|-------------|
| `/start` | Menú principal |
| `/conectar` | Vincula tu Android (QR code) |
| `/estado` | Estado del envío en curso |
| `/parar` | Detener envío |
| `/listas` | Ver listas guardadas |
| `/cancelar` | Cancelar acción actual |

---

## 📋 Flujos de uso

### Enviar a un número único
1. Pulsa **✉️ Enviar a un número**
2. Escribe el teléfono (ej: `+34600123456`)
3. Escribe el mensaje
4. El bot lo envía por SMS

### Enviar a una lista
1. **Sube un archivo .txt** al chat con los números (uno por línea)
   - Formatos válidos: `+34600123456`, `34600123456`, `600123456`
   - También soporta formato con nombre: `+34600123456 | Nombre`
2. La lista se guarda automáticamente
3. Ve a **📋 Enviar a una lista** → elige la lista
4. Escribe el mensaje → el bot envía con delays anti-ban

---

## 🛡️ Anti-ban

- Delay de 4–9 segundos entre mensajes
- Pausa de 90 segundos cada 15 mensajes
- Configurable en las constantes del archivo

---

## ⚠️ Requisitos del sistema

- Node.js 18+
- Chrome/Chromium instalado (o usar Docker)
- Android con Google Messages instalado y conexión activa
- La pantalla del Android puede estar bloqueada — Google Messages Web sigue funcionando

---

## 🔒 Sesión persistente

La sesión de Google Messages se guarda en `./session_data/`.  
No necesitas escanear el QR cada vez que reinicias el bot.  
Para desvincularse, usa el botón 🔌 **Desconectar** en el menú.
