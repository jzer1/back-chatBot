const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const { Pool } = require("pg");
const { google, database } = require("../../config");

// =============================================================================
// 1. CONFIGURACIÓN CENTRALIZADA (El "Cerebro" de los ajustes)
// =============================================================================
const CONFIG = {
    // Datos de la Campaña
    CAMPAIGN: {
        CANDIDATE_NAME: "Óscar Hernández",
        BOT_NAME: "Cami",
        FORM_URL: "https://oscarhernandez-respaldame.com/formulario/participa-y-gana-un-viaje-a-san-andres-islas",
        // Contexto fijo para que el bot sepa de qué habla si le preguntan cosas generales
        BIO_SNIPPET: "Óscar Hernández es un líder comprometido con la comunidad, promotor del turismo y el desarrollo social. Esta campaña busca premiar el apoyo ciudadano con un viaje a San Andrés."
    },
    // Configuración de la IA
    AI: {
        MODELS: ["gemini-1.5-flash", "gemini-2.0-flash-exp"], // Prioridad: Calidad > Velocidad
        MAX_RETRIES: 2,
        HISTORY_LIMIT: 10, // Cuántos mensajes recuerda
        // Filtros de seguridad (Evita que el bot responda a insultos graves o genere odio)
        SAFETY_SETTINGS: [
            { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
            { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
        ]
    },
    // Tiempos
    DELAYS: {
        RETRY_BASE_MS: 1000,
        JITTER_MS: 500
    }
};

// =============================================================================
// 2. INICIALIZACIÓN DE SERVICIOS
// =============================================================================
if (!google?.apiKey) { console.error("❌ FATAL: API Key de Google no encontrada."); process.exit(1); }
if (!database?.uri) { console.error("❌ FATAL: URI de Base de Datos no encontrada."); process.exit(1); }

const pool = new Pool({ connectionString: database.uri, ssl: { rejectUnauthorized: false } });
const genAI = new GoogleGenerativeAI(google.apiKey);

// =============================================================================
// 3. UTILIDADES (Helpers)
// =============================================================================
const Utils = {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    
    normalize: (text) => String(text || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim(),
    
    isBlank: (text) => !text || String(text).trim() === "",

    getTimeGreeting: () => {
        const hour = new Date().getHours() - 5; // Ajuste hora Colombia (UTC-5 aprox)
        if (hour < 12) return "Buenos días";
        if (hour < 18) return "Buenas tardes";
        return "Buenas noches";
    },

    stripLink: (text) => String(text || "").replaceAll(CONFIG.CAMPAIGN.FORM_URL, "").trim()
};

// =============================================================================
// 4. ANALIZADOR DE INTENCIONES (NLP Básico)
// =============================================================================
const IntentAnalyzer = {
    isAlreadyRegistered: (msg) => {
        const t = Utils.normalize(msg);
        return ["ya me registre", "ya me inscribi", "ya lo llene", "ya participe", "listo el registro", "ya quedo"].some(p => t.includes(p));
    },

    isResendRequest: (msg) => {
        const t = Utils.normalize(msg);
        const patterns = [
            // Peticiones explícitas
            "envia el link", "mandame el enlace", "reenvia", "otra vez", "de nuevo", "pasa el link",
            // Intención de registro
            "quiero inscribirme", "quiero participar", "me quiero anotar", "como me inscribo", "a donde entro", "cual es el link",
            // Negaciones (contexto: "¿lo viste?" -> "no")
            "no lo veo", "no aparece", "no me llego", "no", "tampoco", "nada"
        ];
        if (t === "no" || t === "no lo veo") return true;
        return patterns.some(p => t.includes(p));
    },

    isGratitudeOrFarewell: (msg) => {
        const t = Utils.normalize(msg);
        return ["gracias", "muy amable", "agradecido", "hasta luego", "chao", "nos vemos", "bendiciones", "feliz dia"].some(p => t.includes(p));
    }
};

// =============================================================================
// 5. CAPA DE DATOS (Database Layer)
// =============================================================================
const DB = {
    ensureUserExists: async (phone) => {
        await pool.query(`INSERT INTO users (phone_number) VALUES ($1) ON CONFLICT (phone_number) DO NOTHING`, [phone]);
    },

    getUserData: async (phone) => {
        const { rows } = await pool.query(`SELECT name, municipality FROM users WHERE phone_number = $1`, [phone]);
        return rows[0] || { name: null, municipality: null };
    },

    hasLinkBeenSent: async (phone) => {
        // Buscamos si el bot ya envió el dominio de la campaña
        const domain = CONFIG.CAMPAIGN.FORM_URL.split('/')[2]; 
        const res = await pool.query(
            `SELECT 1 FROM chat_history WHERE phone_number = $1 AND role = 'model' AND message LIKE $2 LIMIT 1`,
            [phone, `%${domain}%`]
        );
        return res.rowCount > 0;
    },

    getHistory: async (phone) => {
        const res = await pool.query(
            `SELECT role, message FROM chat_history WHERE phone_number = $1 ORDER BY created_at DESC LIMIT $2`,
            [phone, CONFIG.AI.HISTORY_LIMIT]
        );
        // Formato para Gemini
        return res.rows.reverse().map(h => ({ role: h.role, parts: [{ text: h.message }] }));
    },

    saveInteraction: async (phone, userMsg, botMsg) => {
        const query = `INSERT INTO chat_history (phone_number, role, message) VALUES ($1, $2, $3)`;
        await Promise.all([
            pool.query(query, [phone, 'user', userMsg]),
            pool.query(query, [phone, 'model', botMsg])
        ]);
    }
};

// =============================================================================
// 6. GESTOR DE RESPUESTAS MANUALES (Fallbacks)
// =============================================================================
function getFallbackResponse(scenario, userName) {
    const name = userName ? ` ${userName}` : "";
    const greeting = Utils.getTimeGreeting(); // "Buenos días", etc.
    const url = CONFIG.CAMPAIGN.FORM_URL;

    const libraries = {
        // Caso 1: Saludo inicial o error general
        greeting: [
            `¡${greeting}${name}! 👋 Es un gusto saludarte. Para participar en el sorteo del viaje a San Andrés, por favor completa el siguiente formulario:`,
            `¡Hola${name}! 🌊✈️ Qué alegría que quieras participar. Para inscribirte oficialmente, ingresa tus datos aquí:`,
            `¡${greeting}${name}! No te quedes por fuera del sorteo. Regístrate en este enlace:`
        ],
        // Caso 2: Pide reenvío explícito
        resend: [
            `¡Con mucho gusto${name}! Aquí tienes nuevamente el enlace de inscripción 👇:`,
            `Claro que sí. Te comparto el enlace de nuevo para que puedas registrarte sin problemas 📝:`,
            `Por supuesto, aquí te envío el enlace para que puedas participar:`
        ],
        // Caso 3: Ya se envió y no lo piden (Solo recordatorio)
        alreadySent: [
            `¡Hola${name}! 👋 Te compartí el enlace en el mensaje anterior 👆. ¿Pudiste verlo?`,
            `El link de inscripción se encuentra un poco más arriba en este chat 👆.`,
            `Ya te había enviado el enlace anteriormente. Revísalo arriba 👆 y, si no te funciona, avísame.`
        ],
        // Caso 4: Despedida / Agradecimiento
        farewell: [
            `¡Con mucho gusto${name}! Estamos para servirle. ¡Mucha suerte en el sorteo! 🎉`,
            `Ha sido un placer atenderte. Quedamos atentos. ¡${greeting}! 👋`,
            `¡Gracias a ti por participar! Esperamos que seas el ganador/a. ¡Bendiciones! ✨`
        ]
    };

    const lib = libraries[scenario] || libraries.greeting;
    const text = lib[Math.floor(Math.random() * lib.length)];

    // Lógica de append Link
    if (scenario === 'alreadySent' || scenario === 'farewell') return text;
    return `${text}\n${url}`;
}

// =============================================================================
// 7. MOTOR DE IA (Generación y Reintentos)
// =============================================================================
async function generateAIResponse(systemInstruction, history, userMessage) {
    let lastError = null;

    for (const modelName of CONFIG.AI.MODELS) {
        for (let attempt = 0; attempt <= CONFIG.AI.MAX_RETRIES; attempt++) {
            try {
                const model = genAI.getGenerativeModel({ 
                    model: modelName, 
                    systemInstruction,
                    safetySettings: CONFIG.AI.SAFETY_SETTINGS 
                });
                
                const chat = model.startChat({ history });
                const result = await chat.sendMessage(userMessage);
                const text = result.response.text();
                
                if (!Utils.isBlank(text)) return { ok: true, text };

            } catch (err) {
                lastError = err;
                const status = err.status || 500;
                
                // Si es error de cliente (400) o no encontrado (404), no reintentar ese modelo
                if (status === 400 || status === 404) break;

                // Si es sobrecarga (429, 503), esperar y reintentar
                if ((status === 429 || status === 503) && attempt < CONFIG.AI.MAX_RETRIES) {
                    await Utils.sleep(CONFIG.DELAYS.RETRY_BASE_MS + Math.random() * CONFIG.DELAYS.JITTER_MS);
                    continue;
                }
                break; 
            }
        }
    }
    return { ok: false, error: lastError };
}

// =============================================================================
// 8. CONTROLADOR PRINCIPAL (Main Handler)
// =============================================================================
async function getChatResponse(userId, userMessage) {
    const phone = String(userId);

    // --- A. Validación Inicial ---
    const hasHistory = await DB.hasLinkBeenSent(phone);
    if (Utils.isBlank(userMessage)) {
        return getFallbackResponse(hasHistory ? 'alreadySent' : 'greeting', null);
    }

    try {
        // --- B. Gestión de Usuarios y Datos ---
        await DB.ensureUserExists(phone);
        const userData = await DB.getUserData(phone);
        const history = await DB.getHistory(phone);

        // --- C. Análisis de Estado (State Machine) ---
        const state = {
            linkSentBefore: await DB.hasLinkBeenSent(phone),
            isRegistered: IntentAnalyzer.isAlreadyRegistered(userMessage),
            wantsLink: IntentAnalyzer.isResendRequest(userMessage),
            isFarewell: IntentAnalyzer.isGratitudeOrFarewell(userMessage)
        };

        // Regla de Negocio: ¿Debemos enviar el link en este mensaje?
        // SÍ, si: (Nunca se ha enviado O Pide reenvío) Y (No se ha registrado Y No se está despidiendo)
        const shouldSendLink = (!state.linkSentBefore || state.wantsLink) && !state.isRegistered && !state.isFarewell;

        // --- D. Construcción del Prompt (System Instruction) ---
        const systemInstruction = `
        ROL: Eres ${CONFIG.CAMPAIGN.BOT_NAME}, asistente oficial de la campaña de ${CONFIG.CAMPAIGN.CANDIDATE_NAME}.
        
        BIO CONTEXTO: ${CONFIG.CAMPAIGN.BIO_SNIPPET}

        TONO DE VOZ:
        - Cordial, paciente y servicial (Usa "Con gusto", "Claro que sí").
        - Formal pero cercano (Usa emojis moderados: 👋, ✅, 📩).
        - Si el usuario agradece, sé muy amable al despedirte.

        OBJETIVO PRINCIPAL:
        Facilitar la inscripción en: ${CONFIG.CAMPAIGN.FORM_URL}

        ESTADO DEL USUARIO:
        - ¿Ya tiene el link?: ${state.linkSentBefore ? "SÍ" : "NO"}
        - ¿Está pidiendo el link?: ${state.wantsLink ? "SÍ" : "NO"}
        - ¿Ya se registró?: ${state.isRegistered ? "SÍ" : "NO"}

        INSTRUCCIONES LÓGICAS (PRIORIDAD ALTA):
        1. SI PIDE EL LINK, DICE "QUIERO INSCRIBIRME" O DICE "NO LO VEO":
           -> ¡ENTRÉGALO SIEMPRE! Di: "Aquí tiene el enlace nuevamente 👇". Pega el link.

        2. SI SALUDA Y YA TIENE EL LINK (y no lo pide):
           -> Saluda y recuérdale amablemente que el link está en el mensaje anterior 👆.
           -> NO pegues el link de nuevo (evita spam), a menos que diga que no le abre.

        3. SI DICE "YA ME REGISTRÉ":
           -> Felicítalo, agradece el apoyo y desea suerte. NO pegues el link.

        4. SI AGRADECE O SE DESPIDE:
           -> Responde: "Es un placer atenderle", "Mucha suerte", "Feliz día".
           -> NO pegues el link.

        NOTA: Ante la duda de si el usuario tiene el link o no, ENVÍALO.
        `;

        // --- E. Generación de Respuesta ---
        const aiResult = await generateAIResponse(systemInstruction, history, userMessage);

        let finalResponse = "";

        if (aiResult.ok) {
            finalResponse = aiResult.text;

            // --- F. Post-Procesamiento (Safety Check del Link) ---
            const hasLinkInText = finalResponse.includes(CONFIG.CAMPAIGN.FORM_URL.replace("https://", "")); // Check simple
            
            if (shouldSendLink && !hasLinkInText) {
                // IA olvidó el link -> Lo forzamos elegantemente
                finalResponse += `\n\nAquí le adjunto el enlace de inscripción 👇:\n${CONFIG.CAMPAIGN.FORM_URL}`;
            } else if (!shouldSendLink && hasLinkInText) {
                // IA puso el link y no debía -> Lo quitamos
                finalResponse = Utils.stripLink(finalResponse);
            }
        } else {
            // --- G. Fallback Manual (Si falla la IA) ---
            // Determinamos qué fallback usar basado en el estado calculado en C
            let type = 'greeting';
            if (state.isRegistered) type = 'farewell'; // O un tipo 'registered' si creas uno
            else if (state.isFarewell) type = 'farewell';
            else if (shouldSendLink) type = 'resend';
            else type = 'alreadySent';

            finalResponse = getFallbackResponse(type);
        }

        // --- H. Guardado y Retorno ---
        // Limpieza final por si quedaron saltos de línea extra al quitar links
        finalResponse = finalResponse.replace(/\n{3,}/g, "\n\n").trim();
        
        await DB.saveInteraction(phone, userMessage, finalResponse);

        return finalResponse;

    } catch (error) {
        console.error("❌ Error Crítico en Bot:", error);
        // Último recurso: Fallback genérico
        return getFallbackResponse('greeting', null);
    }
}

module.exports = { getChatResponse };