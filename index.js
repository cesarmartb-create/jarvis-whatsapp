const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
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

client.on('message', async (msg) => {
    if (msg.fromMe) return;

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

    console.log(`📨 Mensaje de ${msg.from}${isOwner ? ' (César/jefe)' : ''}: ${msg.body}`);
    try {
        const response = await axios.post(N8N_WEBHOOK, {
            message: msg.body,
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
        await msg.reply(reply);
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

app.get('/health', (req, res) => res.json({ status: 'JARVIS online' }));

// Permite a n8n enviar mensajes de WhatsApp: POST /send { to, message }
app.post('/send', async (req, res) => {
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
