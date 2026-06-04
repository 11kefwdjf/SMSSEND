# Google Messages Sender Bot v2.0

## Flujo de uso
1. Escribe `/start` en Telegram
2. El bot te pedirá un archivo `.txt` con los números (uno por línea)
3. Después te pedirá el mensaje a enviar
4. El envío empieza con **progreso en vivo** en un solo mensaje
5. Botón **⛔ Detener** para parar en cualquier momento

## Variables de entorno
- `TELEGRAM_TOKEN` — token del bot (obligatorio)
- `ALLOWED_USER` — username de Telegram que puede usar el bot (vacío = sin restricción)

## Formato del .txt
```
+34600123456
+34611223344
600987654
```

## Comandos
- `/start` — iniciar nuevo envío
- `/parar` — detener envío en curso
