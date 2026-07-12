const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const FormData = require('form-data');
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const N8N_WEBHOOK = 'https://n8n-production-fe7d.up.railway.app/webhook/fc021e64-6999-4d3f-93ff-492f784ec103';

const client = new Client({
    // dataPath apunta al volumen persistente de Railway (variable SESSION_PATH).
    // En local usa la carpeta por defecto .wwebjs_auth
    authStrategy: new LocalAuth({ dataPath: process.env.SESSION_PATH || './.wwebjs_auth' }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        // En Railway usamos el Chromium del sistema (ver nixpacks.toml)
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
    }
});

// Indica si WhatsApp ya terminó de conectar; lo usa el endpoint /send.
let clientReady = false;

client.on('qr', (qr) => {
    console.log('📱 Escanea este QR con WhatsApp Business:');
    qrcode.generate(qr, { small: true });
    console.log("🔗 O abre este enlace para ver el QR como imagen:");
    console.log("https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=" + encodeURIComponent(qr));
});

client.on('ready', () => {
    clientReady = true;
    console.log('✅ JARVIS conectado a WhatsApp exitosamente!');
});

client.on('disconnected', (reason) => {
    clientReady = false;
    console.log('⚠️ WhatsApp desconectado:', reason);
});

// Número de César (sin + ni @c.us) para identificar mensajes del jefe
const CESAR_NUMBER = "56993434939";
const CESAR_LID = "39015550038039";
const OWNER_NOTE = 'IMPORTANTE: Este mensaje es de César directamente. Trátalo como tu jefe, no como un contacto externo.';

// Transcribe una nota de voz usando OpenAI Whisper.
// Recibe el audio en base64 y devuelve el texto en español.
async function transcribirAudio(base64Data, mimetype) {
    const audioBuffer = Buffer.from(base64Data, 'base64');
    const extension = (mimetype && mimetype.includes('mp4')) ? 'mp4' : 'ogg';
    const form = new FormData();
    form.append('file', audioBuffer, { filename: `audio.${extension}`, contentType: mimetype || 'audio/ogg' });
    form.append('model', 'whisper-1');
    form.append('language', 'es');
    const resp = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
        headers: {
            ...form.getHeaders(),
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity
    });
    return resp.data.text;
}

// Genera una nota de voz a partir de texto usando ElevenLabs (text-to-speech).
// Devuelve el audio MP3 codificado en base64.
async function generarVoz(texto) {
    const voiceId = process.env.ELEVENLABS_VOICE_ID;
    const resp = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        { text: texto, model_id: 'eleven_multilingual_v2' },
        {
            headers: {
                'xi-api-key': process.env.ELEVENLABS_API_KEY,
                'Content-Type': 'application/json'
            },
            responseType: 'arraybuffer'
        }
    );
    return Buffer.from(resp.data).toString('base64');
}

client.on('message', async (msg) => {
    if (msg.fromMe) return;

    // Determina el texto del mensaje. Si es una nota de voz (ptt) o audio,
    // lo descarga y lo transcribe con Whisper. Si es texto, usa msg.body.
    let textoMensaje = msg.body;
    let entroPorVoz = false;
    if (msg.hasMedia && (msg.type === 'ptt' || msg.type === 'audio')) {
        try {
            console.log('🎤 Nota de voz recibida, transcribiendo...');
            const media = await msg.downloadMedia();
            textoMensaje = await transcribirAudio(media.data, media.mimetype);
            console.log('📝 Transcripción:', textoMensaje);
            entroPorVoz = true;
        } catch (err) {
            console.error('Error al transcribir audio:', err.message);
            await msg.reply('No pude entender la nota de voz, ¿me la puedes escribir?');
            return;
        }
    }


    // El número real puede llegar en distintos campos según si WhatsApp usa
    // formato estándar (@c.us) o LID (@lid, que NO contiene el número real).
    // getContact() suele resolver el número real incluso cuando from es @lid.
    let contactNumber = '';
    try {
        const contact = await msg.getContact();
        contactNumber = contact?.number || contact?.id?.user || '';
    } catch (err) {
        console.error('No se pudo obtener el contacto:', err.message);
    }

    // 🔎 Log de diagnóstico: muestra en qué campo llega el número real de César.
    console.log('🔎 Campos del mensaje:', JSON.stringify({
        from: msg.from,
        author: msg.author,
        dataFrom: msg._data?.from,
        dataAuthor: msg._data?.author,
        notifyName: msg._data?.notifyName,
        contactNumber
    }));

    // Es César si CUALQUIER campo disponible contiene su número real.
    const candidatos = [
        msg.from,
        msg.author,
        msg._data?.from,
        msg._data?.author,
        msg._data?.notifyName,
        contactNumber
    ];
    const isOwner = candidatos.some((c) => typeof c === "string" && (c.includes(CESAR_NUMBER) || c.includes(CESAR_LID)));

    console.log(`📨 Mensaje de ${msg.from}${isOwner ? " (César/jefe)" : ""}: ${textoMensaje}`);
    try {
        const response = await axios.post(N8N_WEBHOOK, {
            message: textoMensaje,
            from: msg.from,
            timestamp: msg.timestamp,
            isOwner,
            ownerNote: isOwner ? OWNER_NOTE : ''
        });
        console.log('Respuesta n8n:', JSON.stringify(response.data));
        let reply = 'Mensaje recibido.';
        if (response.data && Array.isArray(response.data.content)) {
            reply = response.data.content[0]?.text || reply;
        } else if (response.data && response.data.text) {
            reply = response.data.text;
        } else if (typeof response.data === 'string') {
            reply = response.data;
        }
        const LIMITE_VOZ = 600;
        // Voz de salida detras de un flag: solo genera audio si VOICE_REPLIES === 'true'.
        const vozSalidaActiva = process.env.VOICE_REPLIES === 'true';
        if (isOwner && entroPorVoz && vozSalidaActiva) {
            try {
                // Recorta respuestas largas para no gastar créditos de ElevenLabs de más.
                let textoParaVoz = reply;
                if (reply.length > LIMITE_VOZ) {
                    const ventana = reply.slice(0, LIMITE_VOZ);
                    const finFrase = Math.max(
                        ventana.lastIndexOf('.'),
                        ventana.lastIndexOf('!'),
                        ventana.lastIndexOf('?')
                    );
                    textoParaVoz = finFrase !== -1 ? reply.slice(0, finFrase + 1) : reply.slice(0, LIMITE_VOZ);
                    console.log(`✂️ Texto recortado para voz: ${reply.length} → ${textoParaVoz.length} caracteres.`);
                }
                console.log('🔊 César escribió por voz: respondo con nota de voz (ElevenLabs)...');
                const audioBase64 = await generarVoz(textoParaVoz);
                const media = new MessageMedia('audio/mpeg', audioBase64, 'voz.mp3');
                await client.sendMessage(msg.from, media, { sendAudioAsVoice: true });
                console.log('🔊 Nota de voz enviada correctamente.');
                // Si la respuesta era larga, manda el texto completo aparte para no perder detalle.
                if (reply.length > LIMITE_VOZ) {
                    await msg.reply(reply);
                }
            } catch (err) {
                console.error('🔊 Falló la generación de voz, respondo con texto:', err.message);
                await msg.reply(reply);
            }
        } else {
            if (isOwner && entroPorVoz) {
                console.log('🔇 Voz de salida desactivada: respondo en texto');
            }
            await msg.reply(reply);
        }
    } catch (error) {
        console.error('Error:', error.message);
    }
});

// Elimina los candados de Chromium (Singleton*) que pueden quedar dentro de la
// carpeta de sesión tras un apagado abrupto y que impiden relanzar el browser
// con el error "profile appears to be in use" (Code: 21).
function limpiarCandadosChromium(dir) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
        // La carpeta aún no existe (primer arranque) u otro error de lectura: no es fatal.
        return;
    }
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            limpiarCandadosChromium(fullPath);
        } else if (entry.name.startsWith('Singleton')) {
            try {
                fs.rmSync(fullPath, { force: true });
                console.log(`🧹 Candado de Chromium eliminado: ${fullPath}`);
            } catch (err) {
                console.error(`No se pudo eliminar el candado ${fullPath}:`, err.message);
            }
        }
    }
}

// Limpia candados antes de arrancar el cliente (clave en Railway tras reinicios).
limpiarCandadosChromium(process.env.SESSION_PATH || './.wwebjs_auth');

client.initialize();

app.get('/health', (req, res) => {
    const payload = {
        status: clientReady ? 'ok' : 'error',
        whatsapp: clientReady ? 'ready' : 'not_ready',
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString()
    };
    res.status(clientReady ? 200 : 503).json(payload);
});

// Permite a n8n enviar mensajes de WhatsApp: POST /send { to, message }
app.post("/send", async (req, res) => {
    // Verificacion de seguridad: solo quien tenga la llave correcta puede usar /send
    const token = req.headers["x-api-key"];
    if (!process.env.SEND_TOKEN || token !== process.env.SEND_TOKEN) {
        return res.status(401).json({ success: false, error: "No autorizado." });
    }
    const { to, message } = req.body || {};
    if (!to || !message) {
        return res.status(400).json({ success: false, error: 'Faltan los campos "to" o "message".' });
    }
    if (!clientReady) {
        return res.status(503).json({ success: false, error: 'El cliente de WhatsApp no está listo todavía.' });
    }
    try {
        await client.sendMessage(to, message);
        res.json({ success: true });
    } catch (error) {
        console.error('Error al enviar mensaje:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 JARVIS corriendo en puerto ${PORT}`));

// ============================================================
// SELF-HEALING: vigila n8n y lo reinicia vía API de Railway
// si su readiness falla varias veces seguidas.
// Todo detrás del flag SELF_HEAL (default OFF).
// ============================================================
const N8N_READINESS_URL = 'https://n8n-production-fe7d.up.railway.app/healthz/readiness';
const RAILWAY_API = 'https://backboard.railway.app/graphql/v2';
const SELFHEAL_INTERVAL_MS = 2 * 60 * 1000;   // chequea cada 2 min
const SELFHEAL_MAX_FAILS = 3;                 // reinicia tras 3 fallos seguidos
const SELFHEAL_COOLDOWN_MS = 5 * 60 * 1000;   // pausa 5 min tras reiniciar

let selfHealFails = 0;
let selfHealCooldownUntil = 0;

// Dispara el reinicio de n8n usando serviceInstanceRedeploy.
async function reiniciarN8n() {
    const token = process.env.RAILWAY_API_TOKEN;
    const serviceId = process.env.RAILWAY_N8N_SERVICE_ID;
    const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
    if (!token || !serviceId || !environmentId) {
        console.error('🩺 Self-heal: faltan RAILWAY_API_TOKEN / RAILWAY_N8N_SERVICE_ID / RAILWAY_ENVIRONMENT_ID. No reinicio.');
        return false;
    }
    const query = `mutation serviceInstanceRedeploy($serviceId: String!, $environmentId: String!) { serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId) }`;
    try {
        const resp = await axios.post(
            RAILWAY_API,
            { query, variables: { serviceId, environmentId } },
            { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 }
        );
        if (resp.data && resp.data.errors) {
            console.error('🩺 Self-heal: la API de Railway devolvió errores:', JSON.stringify(resp.data.errors));
            return false;
        }
        console.log('🩺 Self-heal: reinicio de n8n solicitado a Railway correctamente.');
        return true;
    } catch (err) {
        console.error('🩺 Self-heal: error llamando a la API de Railway:', err.message);
        return false;
    }
}

// Chequea el readiness de n8n y decide si reiniciar.
async function vigilarN8n() {
    if (process.env.SELF_HEAL !== 'true') return;          // apagado por flag
    if (Date.now() < selfHealCooldownUntil) return;        // en cooldown post-reinicio

    let sano = false;
    try {
        const resp = await axios.get(N8N_READINESS_URL, { timeout: 10000 });
        sano = resp.status === 200 && resp.data && resp.data.status === 'ok';
    } catch (err) {
        sano = false;
    }

    if (sano) {
        if (selfHealFails > 0) console.log('🩺 Self-heal: n8n volvió a responder OK, contador reseteado.');
        selfHealFails = 0;
        return;
    }

    selfHealFails++;
    console.log(`🩺 Self-heal: n8n no responde (fallo ${selfHealFails}/${SELFHEAL_MAX_FAILS}).`);
    if (selfHealFails >= SELFHEAL_MAX_FAILS) {
        console.log('🩺 Self-heal: umbral alcanzado, reiniciando n8n...');
        const ok = await reiniciarN8n();
        selfHealFails = 0;
        if (ok) {
            selfHealCooldownUntil = Date.now() + SELFHEAL_COOLDOWN_MS;
            console.log(`🩺 Self-heal: en cooldown ${SELFHEAL_COOLDOWN_MS / 60000} min mientras n8n arranca.`);
        }
    }
}

setInterval(vigilarN8n, SELFHEAL_INTERVAL_MS);
console.log('🩺 Self-heal: vigilancia de n8n iniciada (activa solo si SELF_HEAL=true).');

// Endpoint manual para probar el reinicio a demanda (protegido con SEND_TOKEN).
app.post('/selfheal-test', async (req, res) => {
    const token = req.headers['x-api-key'];
    if (!process.env.SEND_TOKEN || token !== process.env.SEND_TOKEN) {
        return res.status(401).json({ success: false, error: 'No autorizado.' });
    }
    console.log('🩺 Self-heal: reinicio manual solicitado vía /selfheal-test.');
    const ok = await reiniciarN8n();
    res.status(ok ? 200 : 500).json({ success: ok });
});
