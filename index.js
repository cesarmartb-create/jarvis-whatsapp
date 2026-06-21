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

client.on('qr', (qr) => {
    console.log('📱 Escanea este QR con WhatsApp Business:');
    qrcode.generate(qr, { small: true });
    console.log("🔗 O abre este enlace para ver el QR como imagen:");
    console.log("https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=" + encodeURIComponent(qr));
});

client.on('ready', () => {
    console.log('✅ JARVIS conectado a WhatsApp exitosamente!');
});

// Número de César (sin + ni @c.us) para identificar mensajes del jefe
const CESAR_NUMBER = '56993434939';
const OWNER_NOTE = 'IMPORTANTE: Este mensaje es de César directamente. Trátalo como tu jefe, no como un contacto externo.';

client.on('message', async (msg) => {
    if (msg.fromMe) return;
    const isOwner = msg.from.includes(CESAR_NUMBER);
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
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 JARVIS corriendo en puerto ${PORT}`));
