const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { getChatResponse } = require('./src/servicios/geminiServiceForms'); // Importamos tu lógica

console.log("Iniciando el bot de WhatsApp...");

// Usamos LocalAuth para no tener que escanear el QR cada vez
const client = new Client({
    authStrategy: new LocalAuth()
});

// === Generación del QR ===
client.on('qr', (qr) => {
    console.log('¡Escanea este código QR con tu WhatsApp para iniciar sesión!');
    qrcode.generate(qr, { small: true }); 
});

// === Cliente Listo ===
client.on('ready', () => {
    console.log('¡Cliente de WhatsApp listo y conectado!');
    console.log('Esperando mensajes...');
});

// === Recepción de Mensajes ===
client.on('message', async (message) => {
    // 1. Evitamos que el bot responda a estados o grupos (opcional, pero recomendado)
    if (message.from === 'status@broadcast' || message.from.includes('@g.us')) {
        return;
    }
    
    console.log(`📩 Mensaje recibido de ${message.from}: ${message.body}`);

    const userMessage = message.body;

    if (userMessage) {
        try {
            // === AQUÍ ESTÁ EL CAMBIO IMPORTANTE ===
            // Le pasamos 'message.from' (quién es) y 'userMessage' (qué dijo)
            // Esto permite que la base de datos guarde el historial correctamente.
            const botResponse = await getChatResponse(message.from, userMessage);

            // Enviamos la respuesta
            console.log(`📤 Respondiendo a ${message.from}`);
            
            // Usamos reply para citar el mensaje (queda más elegante) o sendMessage normal
            // client.sendMessage(message.from, botResponse); 
            message.reply(botResponse); 

        } catch (error) {
            console.error("Error al procesar mensaje:", error);
        }
    }
});

// Inicia el cliente
client.initialize();