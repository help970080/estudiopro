# EstudiaPro

Clases grabadas, PDFs y links convertidos en notas, resúmenes, quizes,
flashcards y podcast.

Todo corre en un solo servidor en el VPS: la web, la API, PostgreSQL, Vosk,
yt-dlp y edge-tts. Un dominio, un token, sin dependencias externas salvo la API
de Anthropic.

## Estructura

```
estudiopro/
├── .github/workflows/apk.yml     compila el APK
├── .gitignore
├── README.md
│
├── servidor/                     → VPS
│   ├── server.js
│   ├── index.html                versión web
│   └── package.json
│
└── app/                          → APK
    ├── index.html
    ├── package.json
    ├── capacitor.config.json
    └── nativo/
        ├── AndroidManifest.xml
        ├── MainActivity.java
        ├── GrabadoraPlugin.java
        ├── ServicioGrabacion.java
        ├── file_paths.xml
        └── firmar.py
```

Los dos `index.html` son casi el mismo archivo. El de `app/` detecta que corre
dentro de Capacitor y usa la grabadora nativa; el de `servidor/` usa
`MediaRecorder` del navegador. Si cambias la interfaz, cambia los dos.

## Instalar en el VPS

```bash
mkdir -p /root/estudia && cd /root/estudia
apt install -y ffmpeg sox libsox-fmt-mp3 unzip postgresql
pip install vosk edge-tts yt-dlp
```

### PostgreSQL

```bash
systemctl enable --now postgresql
su postgres -c "psql -c \"CREATE USER estudia WITH PASSWORD 'ponUnaClaveAqui';\""
su postgres -c "psql -c \"CREATE DATABASE estudia OWNER estudia;\""
```

Las tablas las crea el servidor solo al arrancar.

### Modelo de Vosk

```bash
wget https://alphacephei.com/vosk/models/vosk-model-es-0.42.zip
unzip vosk-model-es-0.42.zip && mv vosk-model-es-0.42 modelo
rm vosk-model-es-0.42.zip
```

Son 1.4 GB. El modelo `small` cabe en menos, pero con audio de aula la
transcripción sale inservible.

### Archivos y configuración

Sube `servidor/server.js`, `servidor/index.html` y `servidor/package.json` a
`/root/estudia/`, luego:

```bash
cd /root/estudia && npm install

printf '%s\n' \
  'DATABASE_URL=postgres://estudia:ponUnaClaveAqui@localhost:5432/estudia' \
  'ANTHROPIC_API_KEY=sk-ant-...' \
  'APP_TOKEN=inventaUnoLargo' \
  'PORT=8090' > .env
chmod 600 .env
```

### Servicio

```bash
printf '%s\n' '[Unit]' 'Description=EstudiaPro' 'After=network.target postgresql.service' \
  '[Service]' 'WorkingDirectory=/root/estudia' \
  'ExecStart=/usr/bin/node /root/estudia/server.js' \
  'EnvironmentFile=/root/estudia/.env' 'Restart=always' \
  '[Install]' 'WantedBy=multi-user.target' > /etc/systemd/system/estudia.service

systemctl daemon-reload && systemctl enable --now estudia
curl localhost:8090/api/health
```

Esperas `{"estado":"ok","db":true,"claude":true,"modelo":true}`. Si `modelo` sale
`false`, la carpeta no quedó en `/root/estudia/modelo`.

Agrega al túnel Cloudflare: `estudia.legaxia.uk` → `http://localhost:8090`.

### RAM

El modelo grande de Vosk carga ~1.2 GB mientras transcribe. Tu droplet de 2 GB
ya corre `legaxi-bot`, que también usa Vosk. Si ambos cargan modelo al mismo
tiempo te vas a swap y las llamadas del IVR se degradan. Sube a 4 GB, o
transcribe solo cuando el IVR esté ocioso.

## Probar

Con `TU_TOKEN` y el dominio ya activo:

```bash
curl https://estudia.legaxia.uk/api/health

curl -X POST https://estudia.legaxia.uk/api/sesion/texto \
  -H "x-app-token: TU_TOKEN" -H "content-type: application/json" \
  -d '{"titulo":"Prueba","texto":"...al menos 120 caracteres de algún tema..."}'

curl -X POST https://estudia.legaxia.uk/api/generar \
  -H "x-app-token: TU_TOKEN" -H "content-type: application/json" \
  -d '{"sesion_id":1,"tipo":"flashcards"}'
```

Flashcards a propósito: es la que devuelve JSON estructurado, así que de paso
confirmas que el parser aguanta lo que Claude contesta.

O más simple: abre `https://estudia.legaxia.uk` en el navegador, mete el token
en Ajustes y usa la pestaña *Pegar texto*.

## APK

Cada push a `main` que toque `app/**` compila un APK debug. Actions → última
corrida → **Artifacts** → `EstudiaPro-debug`. Baja un ZIP con el `.apk` adentro.

También desde Actions → APK → Run workflow.

En el teléfono, **Ajustes** pide dos datos: la URL (`https://estudia.legaxia.uk`)
y el token.

Y antes de tu primera clase real: Ajustes del sistema → Batería → EstudiaPro →
**Sin restricciones**. Xiaomi, Huawei, Oppo y Samsung matan servicios en segundo
plano sin importar el `WAKE_LOCK`, y la grabación se corta a media clase.

### Versión firmada

Solo si vas a Play Store. Genera la llave una vez:

```bash
keytool -genkey -v -keystore llave.jks -keyalg RSA -keysize 2048 \
  -validity 10000 -alias estudia
base64 -w0 llave.jks > llave.txt
```

Settings → Secrets and variables → Actions: `KEYSTORE_BASE64` (el contenido de
`llave.txt`), `KEYSTORE_PASSWORD`, `KEY_ALIAS` (`estudia`), `KEY_PASSWORD`.

Guarda `llave.jks` fuera del repo y respáldala. Si la pierdes no puedes firmar
actualizaciones de esa app nunca más.

```bash
git tag v1.0.0 && git push --tags
```

## Respaldo

Todo tu material vive en PostgreSQL. Un cron diario basta:

```bash
echo '0 3 * * * su postgres -c "pg_dump estudia" | gzip > /root/respaldos/estudia_$(date +\%F).sql.gz' | crontab -
mkdir -p /root/respaldos
```
