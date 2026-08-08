/**
 * EstudiaPro — servidor único (VPS)
 *
 * Todo en un proceso: la interfaz web, la API, PostgreSQL local, las llamadas
 * a Claude, la transcripción con Vosk, los subtítulos de YouTube y la síntesis
 * del podcast. No depende de ningún servicio externo salvo la API de Anthropic.
 *
 * Variables de entorno (/root/estudia/.env):
 *   DATABASE_URL       postgres://estudia:CLAVE@localhost:5432/estudia
 *   ANTHROPIC_API_KEY  API key de Anthropic
 *   OPENAI_API_KEY     API key de OpenAI para Whisper (si falta, usa Vosk local)
 *   APP_TOKEN          token compartido con la app y la web
 *   VOSK_MODELO        /root/estudia/modelo   (default)
 *   PORT               8090                   (default)
 */

const express = require('express');
const multer = require('multer');
const { Pool } = require('pg');
const pdfParse = require('pdf-parse');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();

const APP_TOKEN = process.env.APP_TOKEN || 'estudia_dev';
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODELO_VOSK = process.env.VOSK_MODELO || '/root/estudia/modelo';
const WHISPER_KEY = process.env.OPENAI_API_KEY || '';
const MODELO = 'claude-haiku-4-5-20251001';
const PORT = process.env.PORT || 8090;
const AUDIO_DIR = path.join(__dirname, 'podcasts');

fs.mkdirSync(AUDIO_DIR, { recursive: true });

// La app de Android corre en origen https://localhost, así que todo lo que
// llega desde ahí es cross-origin. Sin esto el APK abre en blanco.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'content-type, x-app-token');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '25mb' }));
app.use('/audio', express.static(AUDIO_DIR));

const subirPdf = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });
const subirAudio = multer({ dest: os.tmpdir(), limits: { fileSize: 400 * 1024 * 1024 } });

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

/* ─────────────────────────── Base de datos ─────────────────────────── */

async function migrar() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sesiones (
      id       BIGSERIAL PRIMARY KEY,
      titulo   TEXT NOT NULL,
      materia  TEXT DEFAULT '',
      fuente   TEXT NOT NULL,
      origen   TEXT DEFAULT '',
      texto    TEXT NOT NULL,
      palabras INT DEFAULT 0,
      creado   TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS artefactos (
      id        BIGSERIAL PRIMARY KEY,
      sesion_id BIGINT REFERENCES sesiones(id) ON DELETE CASCADE,
      tipo      TEXT NOT NULL,
      contenido JSONB NOT NULL,
      creado    TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS ix_artef_sesion ON artefactos(sesion_id, tipo);
    CREATE TABLE IF NOT EXISTS repasos (
      id        BIGSERIAL PRIMARY KEY,
      sesion_id BIGINT REFERENCES sesiones(id) ON DELETE CASCADE,
      indice    INT NOT NULL,
      aciertos  INT DEFAULT 0,
      fallos    INT DEFAULT 0,
      proximo   TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(sesion_id, indice)
    );
  `);
  console.log('[db] esquema listo');
}

/* ─────────────────────────────── Auth ──────────────────────────────── */

function auth(req, res, next) {
  const t = req.headers['x-app-token'] || req.query.token;
  if (t !== APP_TOKEN) return res.status(401).json({ error: 'Token inválido' });
  next();
}

/* ────────────────────────── Procesos externos ──────────────────────── */

function correr(cmd, args, opts = {}) {
  return new Promise((ok, fallo) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (e, stdout, stderr) => {
      if (e) return fallo(new Error(`${cmd}: ${stderr || e.message}`.slice(0, 400)));
      ok(stdout);
    });
  });
}

/* ────────────────────────────── Claude ─────────────────────────────── */

async function claude(system, user, maxTokens = 8000) {
  if (!API_KEY) throw new Error('Falta ANTHROPIC_API_KEY');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODELO, max_tokens: maxTokens, system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!r.ok) throw new Error(`Claude ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
}

/**
 * Igual que claude(), pero dejándolo buscar en internet.
 *
 * Sirve cuando YouTube no suelta los subtítulos: se investiga el tema del
 * video por su título y se arma el material con lo que haya publicado.
 * Para clases, charlas y tutoriales suele salir tan completo como la
 * transcripción, a veces mejor.
 */
/**
 * Identifica un video de YouTube por su ID, sin API key.
 *
 * oEmbed es un endpoint público y ligero que YouTube no bloquea por IP,
 * a diferencia de todo lo relacionado con subtítulos. Devuelve título y
 * canal, que es cuanto hace falta para investigar el tema.
 */
async function identificarVideo(idYT) {
  try {
    const r = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${idYT}&format=json`,
      { headers: { 'user-agent': 'Mozilla/5.0 (compatible; EstudiaPro/1.0)' } }
    );
    if (!r.ok) return '';
    const d = await r.json();
    return [d.title, d.author_name].filter(Boolean).join(' — ');
  } catch {
    return '';
  }
}

async function claudeWeb(system, user, maxTokens = 8000) {
  if (!API_KEY) throw new Error('Falta ANTHROPIC_API_KEY');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODELO, max_tokens: maxTokens, system,
      messages: [{ role: 'user', content: user }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }],
    }),
  });
  if (!r.ok) throw new Error(`Claude ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  // La respuesta trae bloques de búsqueda mezclados; solo interesa el texto
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
}

const INVESTIGAR = `Eres un asistente de estudio para un estudiante en México.

Te doy el título de un video que el estudiante quiere estudiar, pero cuyo
contenido no se pudo obtener. Busca en internet de qué trata y arma un
documento de estudio completo sobre ese tema.

Reglas:
- Escribe SIEMPRE en español de México, aunque las fuentes estén en inglés.
- El documento debe ser tuyo, con tus propias palabras. No copies párrafos
  ni frases textuales de las fuentes; explica los conceptos desde cero.
- Cubre el tema a fondo: definiciones, mecanismos, datos, ejemplos,
  conclusiones. Al menos 800 palabras.
- Si el título corresponde a una charla o clase concreta, céntrate en los
  argumentos y hallazgos de esa charla.
- Si no encuentras nada específico sobre ese video, explica el tema general
  que sugiere el título.
- Sin preámbulo ni cierre. Solo el contenido de estudio.`;

function extraerJSON(txt) {
  let s = txt.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const i = s.indexOf('[') === -1 ? s.indexOf('{')
    : Math.min(...[s.indexOf('['), s.indexOf('{')].filter(n => n >= 0));
  const j = Math.max(s.lastIndexOf(']'), s.lastIndexOf('}'));
  if (i >= 0 && j > i) s = s.slice(i, j + 1);
  return JSON.parse(s);
}

/* ─────────────────────────── Prompts por tipo ──────────────────────── */

const BASE = `Eres un asistente de estudio. Trabajas sobre transcripciones de clases,
PDFs, artículos y subtítulos de video.

El material puede venir en cualquier idioma. Tu respuesta SIEMPRE va en español de
México, sin importar el idioma del original: traduce lo que haga falta. Conserva en
su idioma original solo los términos técnicos que se usan así en clase, y la primera
vez que aparezca uno pon la traducción entre paréntesis.

Las transcripciones automáticas traen errores de reconocimiento de voz: corrige
palabras evidentemente mal transcritas usando el contexto, y nunca inventes contenido
que no esté en el material.`;

const PROMPTS = {
  notas: {
    system: `${BASE}
Genera notas de estudio completas y jerarquizadas en Markdown.
Reglas:
- Empieza con un encabezado de nivel 2 por cada tema principal.
- Usa viñetas anidadas para el detalle. Negritas solo en términos clave.
- Incluye fórmulas, definiciones, fechas y cifras textuales del material.
- Si el profesor marcó algo como importante o de examen, ponlo en un bloque de cita.
- No agregues introducción ni cierre. Solo las notas.`,
    parse: t => ({ markdown: t.trim() }), tokens: 8000,
  },
  resumen: {
    system: `${BASE}
Escribe un resumen ejecutivo en Markdown con esta estructura exacta:
## En una frase
(una sola oración que capture la tesis central)
## Puntos clave
(5 a 8 viñetas)
## Qué necesitas recordar
(3 a 5 viñetas de lo que caería en un examen)
Sin preámbulo.`,
    parse: t => ({ markdown: t.trim() }), tokens: 3000,
  },
  quiz: {
    system: `${BASE}
Genera un quiz de opción múltiple. Devuelve ÚNICAMENTE un arreglo JSON válido,
sin markdown ni texto alrededor. Formato de cada elemento:
{"pregunta":"...","opciones":["A","B","C","D"],"correcta":0,"porque":"explicación breve"}
Reglas:
- Entre 8 y 15 preguntas según la densidad del material.
- Los distractores deben ser plausibles, no absurdos.
- "correcta" es el índice (0-3) dentro de "opciones".
- Varía la posición de la respuesta correcta.`,
    parse: t => ({ preguntas: extraerJSON(t) }), tokens: 8000,
  },
  flashcards: {
    system: `${BASE}
Genera flashcards de repaso activo. Devuelve ÚNICAMENTE un arreglo JSON válido,
sin markdown ni texto alrededor. Formato:
{"frente":"pregunta o término","reverso":"respuesta concisa","tema":"subtema"}
Reglas:
- Entre 15 y 30 tarjetas.
- El frente es una pregunta directa o un término, nunca una oración incompleta.
- El reverso cabe en dos líneas. Si es más largo, divídelo en dos tarjetas.
- Cubre todo el material, no solo el principio.`,
    parse: t => ({ tarjetas: extraerJSON(t) }), tokens: 8000,
  },
  podcast: {
    system: `${BASE}
Escribe el guion de un podcast de dos conductores que explican este material.
Devuelve ÚNICAMENTE un arreglo JSON válido, sin markdown. Formato:
{"voz":"A","texto":"lo que dice"}
Reglas:
- "voz" es "A" (Jorge, conduce y pregunta) o "B" (Dalia, explica a fondo).
- Alterna turnos. Entre 30 y 50 turnos.
- Español de México, conversacional, sin leer listas en voz alta.
- Escribe números y símbolos como se pronuncian: "quince por ciento", no "15%".
- Abre enganchando con el tema, cierra con los tres puntos que hay que recordar.
- Nada de efectos de sonido ni acotaciones entre paréntesis.`,
    parse: t => ({ turnos: extraerJSON(t) }), tokens: 12000,
  },
};

/* ────────────────────── Transcripción con Vosk ─────────────────────── */

const SCRIPT_VOSK = `
import sys, json, wave
from vosk import Model, KaldiRecognizer, SetLogLevel
SetLogLevel(-1)
wf = wave.open(sys.argv[2], "rb")
rec = KaldiRecognizer(Model(sys.argv[1]), wf.getframerate())
rec.SetWords(False)
partes = []
while True:
    data = wf.readframes(8000)
    if len(data) == 0: break
    if rec.AcceptWaveform(data):
        t = json.loads(rec.Result()).get("text", "")
        if t: partes.append(t)
t = json.loads(rec.FinalResult()).get("text", "")
if t: partes.append(t)
print(" ".join(partes))
`;
const RUTA_SCRIPT = path.join(os.tmpdir(), 'vosk_transcribir.py');
fs.writeFileSync(RUTA_SCRIPT, SCRIPT_VOSK);

/**
 * Transcribe con Whisper si hay OPENAI_API_KEY, con Vosk si no.
 *
 * Whisper devuelve texto con puntuación y mayúsculas, y aguanta voz lejana
 * y ruido de aula. Vosk local necesita el modelo grande (5 GB de RAM) para
 * dar algo usable; el modelo chico devuelve texto inservible con audio de
 * clase, así que solo sirve de respaldo para grabaciones de voz cercana.
 */
async function transcribirArchivo(ruta) {
  if (WHISPER_KEY) return transcribirWhisper(ruta);
  return transcribirVosk(ruta);
}

async function transcribirVosk(ruta) {
  const wav = `${ruta}.wav`;
  try {
    // Vosk exige WAV mono 16 kHz PCM. El filtro sube voz lejana y recorta
    // el ruido de fondo del aula.
    await correr('ffmpeg', [
      '-i', ruta, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
      '-af', 'highpass=f=90,afftdn=nf=-22,dynaudnorm=p=0.9:m=12',
      '-y', wav,
    ]);
    return (await correr('python3', [RUTA_SCRIPT, MODELO_VOSK, wav])).trim();
  } finally {
    fs.unlink(wav, () => {});
  }
}

// Whisper rechaza archivos de más de 25 MB, así que las clases largas van
// en trozos de 10 minutos que se concatenan al final.
const MINUTOS_TROZO = 10;

async function transcribirWhisper(ruta) {
  const trabajo = `${ruta}_trozos`;
  fs.mkdirSync(trabajo, { recursive: true });
  try {
    await correr('ffmpeg', [
      '-i', ruta,
      '-f', 'segment', '-segment_time', String(MINUTOS_TROZO * 60),
      '-ar', '16000', '-ac', '1', '-b:a', '32k',
      '-reset_timestamps', '1',
      path.join(trabajo, 'p%03d.mp3'),
    ]);

    const trozos = fs.readdirSync(trabajo).filter(f => f.endsWith('.mp3')).sort();
    if (!trozos.length) throw new Error('ffmpeg no pudo leer el audio');

    const partes = [];
    for (const t of trozos) {
      const archivo = path.join(trabajo, t);
      const fd = new FormData();
      fd.append('file', new Blob([fs.readFileSync(archivo)], { type: 'audio/mpeg' }), t);
      fd.append('model', 'whisper-1');
      fd.append('language', 'es');
      fd.append('response_format', 'text');

      const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { authorization: `Bearer ${WHISPER_KEY}` },
        body: fd,
      });
      if (!r.ok) throw new Error(`Whisper ${r.status}: ${(await r.text()).slice(0, 200)}`);
      partes.push((await r.text()).trim());
      console.log(`[whisper] ${t} listo (${partes.length}/${trozos.length})`);
    }
    return partes.join(' ').trim();
  } finally {
    fs.rm(trabajo, { recursive: true, force: true }, () => {});
  }
}

/* ─────────────────────── Ingesta: crear sesión ─────────────────────── */

async function crearSesion({ titulo, materia, fuente, origen, texto }) {
  const limpio = String(texto || '').trim();
  if (limpio.length < 120) throw new Error('El contenido es demasiado corto para estudiarlo');
  const palabras = limpio.split(/\s+/).length;
  const { rows } = await pool.query(
    `INSERT INTO sesiones (titulo, materia, fuente, origen, texto, palabras)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, titulo, materia, fuente, palabras, creado`,
    [titulo || 'Sin título', materia || '', fuente, origen || '', limpio, palabras]
  );
  return rows[0];
}

// Audio: sube, transcribe y guarda en un solo paso
app.post('/api/transcribir', auth, subirAudio.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No llegó ningún audio' });
  const t0 = Date.now();
  try {
    const texto = await transcribirArchivo(req.file.path);
    const segundos = Math.round((Date.now() - t0) / 1000);
    console.log(`[transcribir] ${segundos}s → ${texto.split(/\s+/).length} palabras`);

    if (!texto || texto.split(/\s+/).length < 25) {
      return res.status(400).json({
        error: 'Se transcribieron muy pocas palabras. Revisa que el micrófono captara la voz.',
      });
    }
    const s = await crearSesion({
      titulo: req.body.titulo || `Clase del ${new Date().toLocaleDateString('es-MX')}`,
      materia: req.body.materia, fuente: 'audio', texto,
    });
    res.json({ ...s, segundos });
  } catch (e) {
    console.error('[transcribir]', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

app.post('/api/sesion/texto', auth, async (req, res) => {
  try {
    const { titulo, materia, texto } = req.body;
    res.json(await crearSesion({ titulo, materia, texto, fuente: 'texto' }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/sesion/pdf', auth, subirPdf.single('archivo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No llegó ningún archivo' });
    const data = await pdfParse(req.file.buffer);
    const s = await crearSesion({
      titulo: req.body.titulo || req.file.originalname.replace(/\.pdf$/i, ''),
      materia: req.body.materia, fuente: 'pdf', origen: req.file.originalname,
      texto: (data.text || '').replace(/\n{3,}/g, '\n\n').trim(),
    });
    res.json({ ...s, paginas: data.numpages });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/sesion/link', auth, async (req, res) => {
  try {
    const { url, titulo, materia } = req.body;
    if (!/^https?:\/\//i.test(url || '')) return res.status(400).json({ error: 'URL inválida' });

    let texto = '', tituloDetectado = '', viaWeb = false;
    const idYT = (url.match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/) || [])[1];

    if (idYT) {
      // YouTube bloquea las IPs de datacenter, así que el servidor no puede
      // pedir los subtítulos: la app los trae con la IP del teléfono en
      // texto_cliente. Cuando ni así se puede (video sin subtítulos, o pistas
      // que exigen token del reproductor), se investiga el tema por su título.
      if (req.body.texto_cliente) {
        texto = req.body.texto_cliente;
        tituloDetectado = req.body.titulo_cliente || '';
        viaWeb = false;
      } else {
        // Sin subtítulos: identificar el video y armar el material
        // investigando el tema en internet. Funciona igual desde el
        // navegador, donde la app no puede leer nada del video.
        // oEmbed da el título sin API key; si no responde, Claude
        // identifica el video buscando la URL en internet.
        const nombre = req.body.titulo_cliente || await identificarVideo(idYT);
        console.log(`[web] investigando ${nombre ? `"${nombre}"` : `video ${idYT} (sin título)`}`);

        texto = await claudeWeb(INVESTIGAR, nombre
          ? `Título del video: ${nombre}\nURL: ${url}`
          : `URL del video: ${url}\nID: ${idYT}\n\n`
            + `No se pudo obtener el título. Busca primero de qué video se trata `
            + `y luego investiga ese tema.`, 8000);

        tituloDetectado = nombre || (texto.match(/^#{1,3}\s*(.+)$/m) || [])[1]?.trim()
          || `Video ${idYT}`;
        viaWeb = true;
        if (!texto || texto.trim().length < 400) {
          throw new Error('No se encontró información suficiente sobre ese video.');
        }
      }
    } else {
      const r = await fetch(url, {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; EstudiaPro/1.0)' },
      });
      if (!r.ok) throw new Error(`La página respondió ${r.status}`);
      const html = await r.text();
      tituloDetectado = (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || '';
      texto = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<nav[\s\S]*?<\/nav>/gi, ' ').replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>').replace(/&#\d+;/g, ' ')
        .replace(/\s{2,}/g, ' ').trim();
    }

    res.json(await crearSesion({
      titulo: titulo || tituloDetectado.trim() || url,
      materia, fuente: idYT ? (viaWeb ? 'web' : 'video') : 'link',
      origen: url, texto,
    }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* ──────────────────────────── Generación ───────────────────────────── */

app.post('/api/generar', auth, async (req, res) => {
  try {
    const { sesion_id, tipo, rehacer } = req.body;
    const cfg = PROMPTS[tipo];
    if (!cfg) return res.status(400).json({ error: 'Tipo no reconocido' });

    if (!rehacer) {
      const prev = await pool.query(
        'SELECT contenido FROM artefactos WHERE sesion_id=$1 AND tipo=$2 ORDER BY id DESC LIMIT 1',
        [sesion_id, tipo]
      );
      if (prev.rows.length) return res.json({ tipo, contenido: prev.rows[0].contenido, cache: true });
    }

    const { rows } = await pool.query('SELECT titulo, texto FROM sesiones WHERE id=$1', [sesion_id]);
    if (!rows.length) return res.status(404).json({ error: 'La sesión ya no existe' });

    const salida = await claude(cfg.system,
      `Título: ${rows[0].titulo}\n\n--- MATERIAL ---\n${rows[0].texto}`, cfg.tokens);
    const contenido = cfg.parse(salida);

    await pool.query('DELETE FROM artefactos WHERE sesion_id=$1 AND tipo=$2', [sesion_id, tipo]);
    await pool.query('INSERT INTO artefactos (sesion_id, tipo, contenido) VALUES ($1,$2,$3)',
      [sesion_id, tipo, contenido]);
    res.json({ tipo, contenido, cache: false });
  } catch (e) {
    console.error('[generar]', e.message);
    res.status(500).json({ error: e.message });
  }
});

const VOCES = { A: 'es-MX-JorgeNeural', B: 'es-MX-DaliaNeural' };

app.post('/api/podcast', auth, async (req, res) => {
  const { sesion_id } = req.body;
  const trabajo = path.join(os.tmpdir(), `pod_${sesion_id}_${Date.now()}`);
  try {
    let guion = (await pool.query(
      "SELECT contenido FROM artefactos WHERE sesion_id=$1 AND tipo='podcast' ORDER BY id DESC LIMIT 1",
      [sesion_id]
    )).rows[0]?.contenido;

    if (!guion) {
      const { rows } = await pool.query('SELECT titulo, texto FROM sesiones WHERE id=$1', [sesion_id]);
      if (!rows.length) return res.status(404).json({ error: 'La sesión ya no existe' });
      guion = PROMPTS.podcast.parse(await claude(PROMPTS.podcast.system,
        `Título: ${rows[0].titulo}\n\n--- MATERIAL ---\n${rows[0].texto}`, PROMPTS.podcast.tokens));
      await pool.query("INSERT INTO artefactos (sesion_id, tipo, contenido) VALUES ($1,'podcast',$2)",
        [sesion_id, guion]);
    }

    fs.mkdirSync(trabajo, { recursive: true });
    const salida = path.join(AUDIO_DIR, `sesion_${sesion_id}.mp3`);
    const piezas = [];

    for (let i = 0; i < guion.turnos.length; i++) {
      const t = guion.turnos[i];
      const texto = String(t.texto || '').trim();
      if (!texto) continue;
      const mp3 = path.join(trabajo, `${String(i).padStart(3, '0')}.mp3`);
      await correr('edge-tts', ['--voice', VOCES[t.voz] || VOCES.A, '--rate', '+8%',
        '--text', texto, '--write-media', mp3]);
      piezas.push(mp3);
    }
    if (!piezas.length) throw new Error('El guion llegó vacío');

    // sox concatena y normaliza; sin libsox-fmt-mp3 esto sale en silencio
    await correr('sox', [...piezas, salida, 'norm', '-1']);
    console.log(`[podcast] sesión ${sesion_id} → ${piezas.length} turnos`);
    res.json({ audio: `/audio/sesion_${sesion_id}.mp3`, turnos: piezas.length });
  } catch (e) {
    console.error('[podcast]', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    fs.rm(trabajo, { recursive: true, force: true }, () => {});
  }
});

/* ──────────────────────────── Consulta ─────────────────────────────── */

app.get('/api/sesiones', auth, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT s.id, s.titulo, s.materia, s.fuente, s.palabras, s.creado,
           COALESCE(array_agg(a.tipo) FILTER (WHERE a.tipo IS NOT NULL), '{}') AS listos
    FROM sesiones s LEFT JOIN artefactos a ON a.sesion_id = s.id
    GROUP BY s.id ORDER BY s.creado DESC LIMIT 200`);
  res.json(rows);
});

app.get('/api/sesion/:id', auth, async (req, res) => {
  const s = await pool.query('SELECT * FROM sesiones WHERE id=$1', [req.params.id]);
  if (!s.rows.length) return res.status(404).json({ error: 'La sesión ya no existe' });
  const a = await pool.query('SELECT tipo, contenido FROM artefactos WHERE sesion_id=$1', [req.params.id]);
  const artefactos = {};
  for (const row of a.rows) artefactos[row.tipo] = row.contenido;
  const mp3 = path.join(AUDIO_DIR, `sesion_${req.params.id}.mp3`);
  res.json({
    ...s.rows[0], artefactos,
    audio: fs.existsSync(mp3) ? `/audio/sesion_${req.params.id}.mp3` : null,
  });
});

app.delete('/api/sesion/:id', auth, async (req, res) => {
  await pool.query('DELETE FROM sesiones WHERE id=$1', [req.params.id]);
  fs.unlink(path.join(AUDIO_DIR, `sesion_${req.params.id}.mp3`), () => {});
  res.json({ ok: true });
});

app.post('/api/repaso', auth, async (req, res) => {
  const { sesion_id, indice, acerto } = req.body;
  const dias = acerto ? [1, 3, 7, 16, 35] : [0];
  const { rows } = await pool.query(
    'SELECT aciertos FROM repasos WHERE sesion_id=$1 AND indice=$2', [sesion_id, indice]);
  const nivel = acerto ? Math.min((rows[0]?.aciertos || 0), dias.length - 1) : 0;
  await pool.query(`
    INSERT INTO repasos (sesion_id, indice, aciertos, fallos, proximo)
    VALUES ($1,$2,$3,$4, NOW() + ($5 || ' days')::interval)
    ON CONFLICT (sesion_id, indice) DO UPDATE SET
      aciertos = repasos.aciertos + $3, fallos = repasos.fallos + $4,
      proximo  = NOW() + ($5 || ' days')::interval`,
    [sesion_id, indice, acerto ? 1 : 0, acerto ? 0 : 1, String(dias[nivel])]);
  res.json({ ok: true });
});

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      estado: 'ok', db: true, claude: !!API_KEY,
      motor: WHISPER_KEY ? 'whisper' : 'vosk',
      modelo: fs.existsSync(MODELO_VOSK),
      podcasts: fs.readdirSync(AUDIO_DIR).length,
      uptime: process.uptime(),
    });
  } catch (e) {
    res.status(500).json({ estado: 'error', db: false, detalle: e.message });
  }
});

// Un solo archivo que servir. Sin express.static para no exponer server.js.
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

migrar()
  .then(() => app.listen(PORT, () => {
    console.log(`EstudiaPro escuchando en :${PORT}`);
    console.log(`Transcripción: ${WHISPER_KEY ? 'Whisper (OpenAI)' : `Vosk local — ${MODELO_VOSK}`}`);
  }))
  .catch(e => { console.error('[fatal] migración falló:', e.message); process.exit(1); });
