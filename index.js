const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const express = require('express');

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
});

client.on('ready', () => {
    console.log('✅ JARVIS conectado a WhatsApp exitosamente!');
});

client.on('message', async (msg) => {
    if (msg.fromMe) return;
    console.log(`📨 Mensaje de ${msg.from}: ${msg.body}`);
    try {
        const response = await axios.post(N8N_WEBHOOK, {
            message: msg.body,
            from: msg.from,
            timestamp: msg.timestamp
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

client.initialize();

app.get('/health', (req, res) => res.json({ status: 'JARVIS online' }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 JARVIS corriendo en puerto ${PORT}`));
